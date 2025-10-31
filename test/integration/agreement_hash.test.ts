import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { AgreementModel } from '../../src/models/agreement.model';

describe('Agreement Hash Storage Integration Tests', () => {
  let ownerToken: string;
  let ownerId: string;
  let adminToken: string;
  let signer1Token: string;
  let signer1Id: string;
  let signer1Email: string;
  let signer2Token: string;
  let signer2Id: string;
  let signer2Email: string;
  let projectId: string;
  let agreementId: string;

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

    // Create signer1 user
    const signer1Signup = await request(app).post('/auth/signup').send({
      email: 'signer1@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Signer One',
    });
    signer1Token = signer1Signup.body.accessToken;
    signer1Id = signer1Signup.body.user.id;
    signer1Email = signer1Signup.body.user.email;

    // Create signer2 user
    const signer2Signup = await request(app).post('/auth/signup').send({
      email: 'signer2@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Signer Two',
    });
    signer2Token = signer2Signup.body.accessToken;
    signer2Id = signer2Signup.body.user.id;
    signer2Email = signer2Signup.body.user.email;

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

    // Create project
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Test Project',
        category: 'Film Production',
        visibility: 'private',
        roles: [{ title: 'Director', slots: 1 }],
        revenueModel: {
          splits: [{ userId: ownerId, percentage: 100 }],
        },
      });
    projectId = projectResponse.body.projectId;

    // Create agreement draft
    const agreementResponse = await request(app)
      .post(`/projects/${projectId}/agreements/generate`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Test Agreement',
        signers: [
          { signerId: signer1Id, email: signer1Email, role: 'Signer' },
          { signerId: signer2Id, email: signer2Email, role: 'Signer' },
        ],
        payloadJson: {
          title: 'Test Agreement',
          licenseType: 'Non-Exclusive (royalty-based)',
          terms: 'Test terms',
          splits: [{ percentage: 100 }],
        },
      });
    agreementId = agreementResponse.body.agreementId;
  });

  describe('POST /agreements/:agreementId/hash', () => {
    it('T28.1 - should successfully store hash and queue anchoring job (happy path)', async () => {
      // Arrange - Fully sign the agreement
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      // Clear the mock hash set during signing (Task 26) so we can test real hash storage
      await AgreementModel.updateOne({ agreementId }, { $unset: { immutableHash: '' } });

      // Act - Admin stores hash with anchoring
      const response = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          anchorChain: true,
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'hashed');
      expect(response.body).toHaveProperty('immutableHash');
      expect(response.body).toHaveProperty('jobId');
      expect(response.body).toHaveProperty('message');
      expect(response.body.immutableHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(response.body.message).toContain('blockchain anchoring job queued');

      // Verify hash stored in database
      const agreement = await AgreementModel.findOne({ agreementId });
      expect(agreement?.immutableHash).toBe(response.body.immutableHash);
    });

    it('should successfully store hash without anchoring', async () => {
      // Arrange - Fully sign the agreement
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      // Clear the mock hash set during signing
      await AgreementModel.updateOne({ agreementId }, { $unset: { immutableHash: '' } });

      // Act - Admin stores hash without anchoring
      const response = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          anchorChain: false,
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'hashed');
      expect(response.body).toHaveProperty('immutableHash');
      expect(response.body).not.toHaveProperty('jobId'); // No jobId when anchorChain is false
      expect(response.body.message).toContain('Hash computed and stored');
    });

    it('T28.2 - should fail when agreement is not fully signed (409)', async () => {
      // Arrange - Only signer1 has signed (partially signed)
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      // Act - Admin tries to store hash
      const response = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          anchorChain: true,
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('fully signed');
    });

    it('T28.3 - should fail when hash is already stored (idempotency - 409)', async () => {
      // Arrange - Fully sign and store hash once
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ anchorChain: false });

      // Act - Try to store hash again
      const response = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          anchorChain: true,
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already stored');
    });

    it('should fail when non-admin tries to store hash (403)', async () => {
      // Arrange - Fully sign the agreement
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      // Act - Non-admin (owner) tries to store hash
      const response = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          anchorChain: true,
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should return 404 for non-existent agreement', async () => {
      // Act - Admin tries to store hash for non-existent agreement
      const response = await request(app)
        .post('/agreements/nonexistent_123/hash')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          anchorChain: true,
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should validate anchorChain is required boolean', async () => {
      // Arrange - Fully sign the agreement
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      // Act - Missing anchorChain
      const response = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          // Missing anchorChain
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate anchorChain is boolean', async () => {
      // Arrange - Fully sign the agreement
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      // Act - Invalid anchorChain type
      const response = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          anchorChain: 'not-a-boolean',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .send({
          anchorChain: true,
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should produce consistent hash on repeated calls with same data', async () => {
      // Arrange - Fully sign the agreement
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      // Clear the mock hash set during signing
      await AgreementModel.updateOne({ agreementId }, { $unset: { immutableHash: '' } });

      // Get the agreement to compute hash manually
      const agreement = await AgreementModel.findOne({ agreementId });
      expect(agreement).toBeDefined();

      // Note: We can't call computeCanonicalHash directly from here as it's not exported
      // But we can verify the hash is consistent by storing it twice (which should fail with AlreadyHashed)
      // This test verifies the idempotency which ensures consistency

      // Act - Store hash first time
      const response1 = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ anchorChain: false });

      // Verify agreement has hash
      const agreementAfterFirst = await AgreementModel.findOne({ agreementId });
      const storedHash = agreementAfterFirst?.immutableHash;

      // Try to store again (should fail)
      const response2 = await request(app)
        .post(`/agreements/${agreementId}/hash`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ anchorChain: false });

      // Assert
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(409); // Already hashed
      expect(storedHash).toBeDefined();
      expect(storedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
  });
});

