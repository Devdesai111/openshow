import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { CreatorProfileModel } from '../../src/models/creatorProfile.model';
import { VerificationApplicationModel } from '../../src/models/verificationApplication.model';
import { AssetModel } from '../../src/models/asset.model';

describe('Verification Application Workflow Integration Tests', () => {
  let creatorToken: string;
  let creatorId: string;
  let adminToken: string;
  let ownerToken: string;
  let assetId: string;

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
    await CreatorProfileModel.deleteMany({});
    await VerificationApplicationModel.deleteMany({});
    await AssetModel.deleteMany({});

    // Create creator user
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Test Creator',
    });
    creatorToken = creatorSignup.body.accessToken;
    creatorId = creatorSignup.body.user.id;

    // Create creator profile
    await CreatorProfileModel.create({
      userId: new mongoose.Types.ObjectId(creatorId),
      skills: ['Directing', 'Editing'],
      categories: ['Film'],
      availability: 'open',
      verified: false,
    });

    // Create owner user (for asset upload)
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Test Owner',
    });
    ownerToken = ownerSignup.body.accessToken;

    // Create admin user
    await request(app).post('/auth/signup').send({
      email: 'admin@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Admin User',
    });
    await UserModel.updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@example.com',
      password: 'Password123',
    });
    adminToken = adminLogin.body.accessToken;

    // Create an asset for evidence
    const urlResponse = await request(app)
      .post('/assets/signed-upload-url')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'id-document.pdf',
        mimeType: 'application/pdf',
      });

    const assetUploadId = urlResponse.body.assetUploadId;
    const storageKey = `uploads/profile/${ownerToken}/${Date.now()}-id-document.pdf`;

    const registerResponse = await request(app)
      .post('/assets/register')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        assetUploadId,
        storageKey,
        size: 1024000,
        sha256: 'asset-hash',
      });

    assetId = registerResponse.body.assetId;
  });

  describe('POST /verification/apply', () => {
    it('T24.1 - should successfully submit verification application (happy path)', async () => {
      // Act
      const response = await request(app)
        .post('/verification/apply')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          statement: 'I am a professional filmmaker with 10 years of experience.',
          evidence: [
            {
              type: 'portfolio',
              url: 'https://example.com/portfolio',
              notes: 'Portfolio website',
            },
            {
              type: 'id_document',
              assetId: assetId,
            },
          ],
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('applicationId');
      expect(response.body).toHaveProperty('status', 'pending');
      expect(response.body).toHaveProperty('submittedAt');
      expect(response.body).toHaveProperty('message');

      // Verify application saved in database
      const application = await VerificationApplicationModel.findOne({
        applicationId: response.body.applicationId,
      });
      expect(application).toBeDefined();
      expect(application?.status).toBe('pending');
      expect(application?.evidence).toHaveLength(2);
      expect(application?.evidence[0]?.type).toBe('portfolio');
      expect(application?.evidence[1]?.type).toBe('id_document');
      expect(application?.evidence[1]?.isSensitive).toBe(true); // Auto-flagged as PII
    });

    it('T24.2 - should fail when pending application already exists (409)', async () => {
      // Arrange - Create pending application
      await request(app)
        .post('/verification/apply')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          evidence: [
            {
              type: 'portfolio',
              url: 'https://example.com/portfolio',
            },
          ],
        });

      // Act - Try to submit another application
      const response = await request(app)
        .post('/verification/apply')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          evidence: [
            {
              type: 'work_sample',
              url: 'https://example.com/work',
            },
          ],
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
    });

    it('should validate evidence array is required', async () => {
      // Act
      const response = await request(app)
        .post('/verification/apply')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          statement: 'Test statement',
          // Missing evidence
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate evidence must have assetId or url', async () => {
      // Act
      const response = await request(app)
        .post('/verification/apply')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          evidence: [
            {
              type: 'portfolio',
              // Missing both assetId and url
            },
          ],
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate evidence type enum', async () => {
      // Act
      const response = await request(app)
        .post('/verification/apply')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          evidence: [
            {
              type: 'invalid_type',
              url: 'https://example.com',
            },
          ],
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).post('/verification/apply').send({
        evidence: [{ type: 'portfolio', url: 'https://example.com' }],
      });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('GET /verification/queue', () => {
    let applicationId: string;

    beforeEach(async () => {
      // Create a pending application
      const submitResponse = await request(app)
        .post('/verification/apply')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          evidence: [{ type: 'portfolio', url: 'https://example.com/portfolio' }],
        });
      applicationId = submitResponse.body.applicationId;
    });

    it('should successfully retrieve admin queue (admin)', async () => {
      // Act
      const response = await request(app)
        .get('/verification/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ status: 'pending' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.meta).toHaveProperty('page', 1);
      expect(response.body.meta).toHaveProperty('per_page');
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta).toHaveProperty('total_pages');

      // Verify application is in queue
      const foundApp = response.body.data.find((app: any) => app.applicationId === applicationId);
      expect(foundApp).toBeDefined();
      expect(foundApp.status).toBe('pending');
      expect(foundApp).toHaveProperty('userId');
      expect(foundApp).toHaveProperty('submittedAt');
      expect(foundApp).toHaveProperty('evidenceCount');
    });

    it('T24.3 - should fail when non-admin tries to access queue (403)', async () => {
      // Act
      const response = await request(app)
        .get('/verification/queue')
        .set('Authorization', `Bearer ${creatorToken}`) // Creator, not admin
        .query({ status: 'pending' });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should support pagination', async () => {
      // Arrange - Create multiple applications
      for (let i = 0; i < 5; i++) {
        const creatorSignup = await request(app).post('/auth/signup').send({
          email: `creator${i}@example.com`,
          password: 'Password123',
          role: 'creator',
          fullName: `Creator ${i}`,
        });
        await CreatorProfileModel.create({
          userId: new mongoose.Types.ObjectId(creatorSignup.body.user.id),
          skills: [],
          categories: [],
          availability: 'open',
          verified: false,
        });
        await request(app)
          .post('/verification/apply')
          .set('Authorization', `Bearer ${creatorSignup.body.accessToken}`)
          .send({
            evidence: [{ type: 'portfolio', url: `https://example.com/${i}` }],
          });
      }

      // Act - First page
      const firstPage = await request(app)
        .get('/verification/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ status: 'pending', page: 1, per_page: 3 });

      expect(firstPage.status).toBe(200);
      expect(firstPage.body.data.length).toBe(3);
      expect(firstPage.body.meta.page).toBe(1);
    });

    it('should filter by status', async () => {
      // Arrange - Approve the application
      const approveResponse = await request(app)
        .post(`/verification/${applicationId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ adminNotes: 'Approved for testing' });

      expect(approveResponse.status).toBe(200);

      // Wait a bit to ensure database update is committed
      await new Promise(resolve => setTimeout(resolve, 100));

      // Act - Query pending (should not include approved)
      const pendingResponse = await request(app)
        .get('/verification/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ status: 'pending' });

      expect(pendingResponse.status).toBe(200);
      const foundApp = pendingResponse.body.data.find((app: any) => app.applicationId === applicationId);
      expect(foundApp).toBeUndefined(); // Approved app should not be in pending queue
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).get('/verification/queue');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /verification/:applicationId/approve', () => {
    let applicationId: string;

    beforeEach(async () => {
      // Create a pending application
      const submitResponse = await request(app)
        .post('/verification/apply')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          evidence: [{ type: 'portfolio', url: 'https://example.com/portfolio' }],
        });
      applicationId = submitResponse.body.applicationId;
    });

    it('T24.4 - should successfully approve application and update CreatorProfile (happy path)', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Profile verified. All documentation checked and approved.',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('applicationId', applicationId);
      expect(response.body).toHaveProperty('status', 'approved');
      expect(response.body).toHaveProperty('reviewedBy');
      expect(response.body).toHaveProperty('verifiedAt');

      // Verify application status updated
      const application = await VerificationApplicationModel.findOne({ applicationId });
      expect(application?.status).toBe('approved');
      expect(application?.reviewedBy).toBeDefined();
      expect(application?.reviewedAt).toBeDefined();
      expect(application?.adminNotes).toBe('Profile verified. All documentation checked and approved.');

      // Verify CreatorProfile verified flag updated
      const profile = await CreatorProfileModel.findOne({ userId: new mongoose.Types.ObjectId(creatorId) });
      expect(profile?.verified).toBe(true);
      expect(profile?.verificationBadgeMeta).toBeDefined();
      expect(profile?.verificationBadgeMeta?.verifiedAt).toBeDefined();
      expect(profile?.verificationBadgeMeta?.verifierId).toBeDefined();
    });

    it('T24.5 - should fail when trying to approve already approved application (409)', async () => {
      // Arrange - Approve the application first
      await request(app)
        .post(`/verification/${applicationId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ adminNotes: 'First approval' });

      // Act - Try to approve again
      const response = await request(app)
        .post(`/verification/${applicationId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Second approval attempt',
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
    });

    it('should fail when non-admin tries to approve (403)', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/approve`)
        .set('Authorization', `Bearer ${creatorToken}`) // Creator, not admin
        .send({
          adminNotes: 'Unauthorized approval attempt',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should validate adminNotes is required (min 10 chars)', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Short', // Too short
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 409 for non-existent application', async () => {
      // Act
      const response = await request(app)
        .post('/verification/nonexistent_123/approve')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Approval notes for non-existent application',
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/approve`)
        .send({
          adminNotes: 'Unauthenticated approval attempt',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /verification/:applicationId/reject', () => {
    let applicationId: string;

    beforeEach(async () => {
      // Create a pending application
      const submitResponse = await request(app)
        .post('/verification/apply')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          evidence: [{ type: 'portfolio', url: 'https://example.com/portfolio' }],
        });
      applicationId = submitResponse.body.applicationId;
    });

    it('T24.6 - should successfully reject application (happy path)', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Application rejected due to insufficient documentation.',
          action: 'rejected',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('applicationId', applicationId);
      expect(response.body).toHaveProperty('status', 'rejected');
      expect(response.body).toHaveProperty('reviewedBy');
      expect(response.body).toHaveProperty('reviewedAt');

      // Verify application status updated
      const application = await VerificationApplicationModel.findOne({ applicationId });
      expect(application?.status).toBe('rejected');
      expect(application?.reviewedBy).toBeDefined();
      expect(application?.reviewedAt).toBeDefined();
      expect(application?.adminNotes).toBe('Application rejected due to insufficient documentation.');

      // Verify CreatorProfile verified flag NOT updated (should remain false)
      const profile = await CreatorProfileModel.findOne({ userId: new mongoose.Types.ObjectId(creatorId) });
      expect(profile?.verified).toBe(false);
    });

    it('should support needs_more_info action', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Please provide additional ID documentation.',
          action: 'needs_more_info',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'needs_more_info');

      // Verify application status
      const application = await VerificationApplicationModel.findOne({ applicationId });
      expect(application?.status).toBe('needs_more_info');
    });

    it('should default to rejected if action not specified', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Default rejection without action specified.',
          // No action specified
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'rejected');
    });

    it('should fail when trying to reject already processed application (409)', async () => {
      // Arrange - Approve the application first
      await request(app)
        .post(`/verification/${applicationId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ adminNotes: 'Approved first' });

      // Act - Try to reject
      const response = await request(app)
        .post(`/verification/${applicationId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Rejection attempt on approved app',
          action: 'rejected',
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
    });

    it('should fail when non-admin tries to reject (403)', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/reject`)
        .set('Authorization', `Bearer ${creatorToken}`) // Creator, not admin
        .send({
          adminNotes: 'Unauthorized rejection attempt',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should validate adminNotes is required (min 10 chars)', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          adminNotes: 'Short',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/verification/${applicationId}/reject`)
        .send({
          adminNotes: 'Unauthenticated rejection attempt',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });
});

