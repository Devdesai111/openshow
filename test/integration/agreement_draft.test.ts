import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { AgreementModel } from '../../src/models/agreement.model';

describe('Agreement Draft Generation Integration Tests', () => {
  let ownerToken: string;
  let ownerId: string;
  let nonOwnerToken: string;
  let projectId: string;

  beforeAll(async () => {
    const testDbUri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/openshow-test';
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    await mongoose.connect(testDbUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await AgreementModel.deleteMany({});

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerToken = ownerSignup.body.accessToken;
    ownerId = ownerSignup.body.user.id;

    // Create non-owner user
    const nonOwnerSignup = await request(app).post('/auth/signup').send({
      email: 'nonowner@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Non Owner',
    });
    nonOwnerToken = nonOwnerSignup.body.accessToken;

    // Create project
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Agreement Test Project',
        category: 'Film Production',
        visibility: 'private',
        roles: [{ title: 'Director', slots: 1 }],
        revenueModel: { splits: [{ placeholder: 'Director', percentage: 100 }] },
      });
    projectId = projectResponse.body.projectId;
  });

  describe('POST /projects/:projectId/agreements/generate', () => {
    it('T21.1 - should successfully generate agreement draft (happy path)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/agreements/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Contributor Agreement - Alpha',
          templateId: 'contributor_template_v1',
          signers: [
            {
              email: 'owner@example.com',
              role: 'Owner',
            },
            {
              email: 'director@example.com',
              role: 'Director',
            },
          ],
          payloadJson: {
            title: 'Contributor Agreement - Alpha',
            licenseType: 'Exclusive Ownership',
            terms: 'Standard contributor terms apply.',
            splits: [
              { userId: ownerId, percentage: 60 },
              { placeholder: 'Director', percentage: 40 },
            ],
          },
          signOrderEnforced: false,
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('agreementId');
      expect(response.body).toHaveProperty('projectId', projectId);
      expect(response.body).toHaveProperty('title', 'Contributor Agreement - Alpha');
      expect(response.body).toHaveProperty('status', 'draft');
      expect(response.body).toHaveProperty('version', 1);
      expect(response.body).toHaveProperty('previewHtml');
      expect(response.body).toHaveProperty('createdAt');

      // Verify agreement record created
      const agreement = await AgreementModel.findOne({ agreementId: response.body.agreementId });
      expect(agreement).toBeDefined();
      expect(agreement?.status).toBe('draft');
      expect(agreement?.version).toBe(1);
      expect(agreement?.signers).toHaveLength(2);
      expect(agreement?.signers[0]?.signed).toBe(false);
      expect(agreement?.signers[1]?.signed).toBe(false);
      expect(agreement?.payloadJson.licenseType).toBe('Exclusive Ownership');
    });

    it('T21.2 - should fail when non-owner tries to generate draft (403)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/agreements/generate`)
        .set('Authorization', `Bearer ${nonOwnerToken}`)
        .send({
          title: 'Unauthorized Agreement',
          signers: [{ email: 'test@example.com', role: 'Contributor' }],
          payloadJson: {
            title: 'Unauthorized Agreement',
            licenseType: 'Non-Exclusive (royalty-based)',
            terms: 'Test terms',
            splits: [],
          },
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('T21.3 - should return 422 for missing signers', async () => {
      // Act - Missing signers array
      const response = await request(app)
        .post(`/projects/${projectId}/agreements/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Invalid Agreement',
          payloadJson: {
            title: 'Invalid Agreement',
            licenseType: 'Creative Commons',
            terms: 'Test terms',
            splits: [],
          },
          // Missing signers
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('T21.4 - should return response with previewHtml and signers with signed: false', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/agreements/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Test Agreement',
          signers: [
            {
              email: 'signer1@example.com',
              name: 'Signer One',
              role: 'Contributor',
            },
          ],
          payloadJson: {
            title: 'Test Agreement',
            licenseType: 'Exclusive Ownership',
            terms: 'Test terms for verification',
            splits: [{ placeholder: 'Contributor', percentage: 100 }],
          },
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('previewHtml');
      expect(response.body.previewHtml).toContain('Test Agreement');
      expect(response.body.previewHtml).toContain('Exclusive Ownership');

      // Verify signers in database
      const agreement = await AgreementModel.findOne({ agreementId: response.body.agreementId });
      expect(agreement?.signers).toHaveLength(1);
      expect(agreement?.signers[0]?.email).toBe('signer1@example.com');
      expect(agreement?.signers[0]?.name).toBe('Signer One');
      expect(agreement?.signers[0]?.signed).toBe(false);
      expect(agreement?.signers[0]?.role).toBe('Contributor');
    });

    it('should validate title length (min 5 chars)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/agreements/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Test', // Too short
          signers: [{ email: 'test@example.com' }],
          payloadJson: {
            title: 'Test',
            licenseType: 'Creative Commons',
            terms: 'Test',
            splits: [],
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate signer email format', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/agreements/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Test Agreement',
          signers: [{ email: 'invalid-email' }], // Invalid email
          payloadJson: {
            title: 'Test Agreement',
            licenseType: 'Creative Commons',
            terms: 'Test',
            splits: [],
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate payloadJson.licenseType is present', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/agreements/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Test Agreement',
          signers: [{ email: 'test@example.com' }],
          payloadJson: {
            title: 'Test Agreement',
            // Missing licenseType
            terms: 'Test',
            splits: [],
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 404 for non-existent project', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${new mongoose.Types.ObjectId()}/agreements/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Test Agreement',
          signers: [{ email: 'test@example.com' }],
          payloadJson: {
            title: 'Test Agreement',
            licenseType: 'Creative Commons',
            terms: 'Test',
            splits: [],
          },
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/agreements/generate`)
        .send({
          title: 'Test Agreement',
          signers: [{ email: 'test@example.com' }],
          payloadJson: {
            title: 'Test Agreement',
            licenseType: 'Creative Commons',
            terms: 'Test',
            splits: [],
          },
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should handle empty signers array with 422', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/agreements/generate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Test Agreement',
          signers: [], // Empty array
          payloadJson: {
            title: 'Test Agreement',
            licenseType: 'Creative Commons',
            terms: 'Test',
            splits: [],
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });
});

