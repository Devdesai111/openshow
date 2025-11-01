import request from 'supertest';
import app from '../../src/server';
import { UserSettingsModel } from '../../src/models/userSettings.model';
import { AuditLogModel } from '../../src/models/auditLog.model';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import mongoose from 'mongoose';
import { Types } from 'mongoose';

describe('Payout Recipient Management & KYC Checks API Integration Tests (Task 68)', () => {
  let adminToken: string;
  let creatorToken: string;
  let adminUserId: string;
  let targetUserId: string;

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
    await UserSettingsModel.deleteMany({});
    await AuditLogModel.deleteMany({});
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});

    // Create admin user
    await request(app).post('/auth/signup').send({
      email: 'admin@test.com',
      password: 'Admin123!',
      preferredName: 'Admin User',
      fullName: 'Admin User',
      role: 'creator',
    });

    const adminUser = await UserModel.findOne({ email: 'admin@test.com' });
    expect(adminUser).toBeDefined();
    adminUserId = adminUser!._id!.toString();

    await UserModel.updateOne({ email: 'admin@test.com' }, { $set: { role: 'admin' } });

    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@test.com',
      password: 'Admin123!',
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.data?.token || adminLogin.body.accessToken;
    expect(adminToken).toBeDefined();

    // Create target user
    await request(app).post('/auth/signup').send({
      email: 'target@test.com',
      password: 'Target123!',
      preferredName: 'Target User',
      fullName: 'Target User',
      role: 'creator',
    });

    const targetUser = await UserModel.findOne({ email: 'target@test.com' });
    expect(targetUser).toBeDefined();
    targetUserId = targetUser!._id!.toString();

    // Create creator user for unauthorized tests
    await request(app).post('/auth/signup').send({
      email: 'creator@test.com',
      password: 'Creator123!',
      preferredName: 'Creator User',
      fullName: 'Creator User',
      role: 'creator',
    });

    const creatorLogin = await request(app).post('/auth/login').send({
      email: 'creator@test.com',
      password: 'Creator123!',
    });
    expect(creatorLogin.status).toBe(200);
    creatorToken = creatorLogin.body.data?.token || creatorLogin.body.accessToken;
    expect(creatorToken).toBeDefined();
  });

  describe('PUT /admin/users/:userId/payout-status', () => {
    it('T68.1 - should successfully verify user payout status (200 OK)', async () => {
      // Arrange
      const payload = {
        isVerified: true,
        providerAccountId: 'acct_test_12345',
        reason: 'KYC documents verified successfully after manual review.',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/payout-status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('userId', targetUserId);
      expect(response.body).toHaveProperty('isVerified', true);
      expect(response.body).toHaveProperty('providerAccountId', 'acct_test_12345');
      expect(response.body).toHaveProperty('message');

      // Verify database update
      const settings = await UserSettingsModel.findOne({ userId: new Types.ObjectId(targetUserId) });
      expect(settings).toBeDefined();
      expect(settings!.payoutMethod).toBeDefined();
      expect(settings!.payoutMethod!.isVerified).toBe(true);
      expect(settings!.payoutMethod!.providerAccountId).toBe('acct_test_12345');

      // Verify audit log
      const auditLog = await AuditLogModel.findOne({
        action: 'payout.kyc_verified',
        'details.providerAccountId': 'acct_test_12345',
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.actorId?.toString()).toBe(adminUserId);
      expect(auditLog!.actorRole).toBe('admin');
    });

    it('should successfully unverify user payout status (200 OK)', async () => {
      // Arrange: First verify, then unverify
      await request(app)
        .put(`/admin/users/${targetUserId}/payout-status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          isVerified: true,
          providerAccountId: 'acct_test_12345',
          reason: 'Initially verified for testing.',
        });

      const unverifyPayload = {
        isVerified: false,
        providerAccountId: 'acct_test_12345',
        reason: 'KYC documents expired and require re-verification.',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/payout-status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(unverifyPayload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('isVerified', false);

      // Verify database update
      const settings = await UserSettingsModel.findOne({ userId: new Types.ObjectId(targetUserId) });
      expect(settings!.payoutMethod!.isVerified).toBe(false);

      // Verify audit log
      const auditLog = await AuditLogModel.findOne({
        action: 'payout.kyc_unverified',
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.actorId?.toString()).toBe(adminUserId);
    });

    it('T68.2 - should return 403 for unauthorized access', async () => {
      // Arrange
      const payload = {
        isVerified: true,
        providerAccountId: 'acct_test_12345',
        reason: 'Unauthorized verification attempt.',
      };

      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/payout-status`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('T68.3 - should return 422 for invalid providerAccountId', async () => {
      // Arrange: Account ID too short
      const payload = {
        isVerified: true,
        providerAccountId: '1234', // Less than 5 characters
        reason: 'KYC documents verified successfully.',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/payout-status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 422 for reason too short', async () => {
      // Arrange: Reason less than 10 characters
      const payload = {
        isVerified: true,
        providerAccountId: 'acct_test_12345',
        reason: 'Short', // Less than 10 characters
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/payout-status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 422 for missing isVerified', async () => {
      // Arrange: Missing isVerified
      const payload = {
        providerAccountId: 'acct_test_12345',
        reason: 'KYC verification reason.',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/payout-status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 404 for non-existent user', async () => {
      // Arrange
      const nonExistentUserId = new Types.ObjectId().toString();
      const payload = {
        isVerified: true,
        providerAccountId: 'acct_test_12345',
        reason: 'KYC verification reason.',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${nonExistentUserId}/payout-status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('not_found');
    });

    it('should audit log include reason in details', async () => {
      // Arrange
      const payload = {
        isVerified: true,
        providerAccountId: 'acct_test_audit',
        reason: 'Manual KYC verification after document review.',
      };

      // Act
      await request(app)
        .put(`/admin/users/${targetUserId}/payout-status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert: Verify audit log details
      const auditLog = await AuditLogModel.findOne({
        action: 'payout.kyc_verified',
        'details.providerAccountId': 'acct_test_audit',
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.details).toHaveProperty('reason', 'Manual KYC verification after document review.');
    });

    it('should create user settings if they do not exist', async () => {
      // Arrange: Create a new user without settings
      await request(app).post('/auth/signup').send({
        email: 'newuser@test.com',
        password: 'NewUser123!',
        preferredName: 'New User',
        fullName: 'New User',
        role: 'creator',
      });

      const newUser = await UserModel.findOne({ email: 'newuser@test.com' });
      expect(newUser).toBeDefined();
      const newUserId = newUser!._id!.toString();

      const payload = {
        isVerified: true,
        providerAccountId: 'acct_new_user_123',
        reason: 'Creating settings for new user and verifying KYC.',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${newUserId}/payout-status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);

      // Verify settings were created
      const settings = await UserSettingsModel.findOne({ userId: new Types.ObjectId(newUserId) });
      expect(settings).toBeDefined();
      expect(settings!.payoutMethod).toBeDefined();
      expect(settings!.payoutMethod!.isVerified).toBe(true);
    });
  });
});

