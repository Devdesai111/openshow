import request from 'supertest';
import mongoose from 'mongoose';
import * as speakeasy from 'speakeasy';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { TwoFATempModel } from '../../src/models/twoFATemp.model';

describe('2FA Verification and Admin Integration Tests', () => {
  let userAccessToken: string;
  let userId: string;
  let adminAccessToken: string;
  let adminUserId: string;

  // Test database connection setup
  beforeAll(async () => {
    // Use test database
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
    // Clean up database before each test
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await TwoFATempModel.deleteMany({});

    // Create regular user
    const userSignup = await request(app).post('/auth/signup').send({
      email: 'user2fa@example.com',
      password: 'StrongPassword123',
      role: 'creator',
    });

    userAccessToken = userSignup.body.accessToken;
    userId = userSignup.body.user.id;

    // Create admin user
    const adminSignup = await request(app).post('/auth/signup').send({
      email: 'admin@example.com',
      password: 'AdminPassword123',
      role: 'creator',
    });

    adminAccessToken = adminSignup.body.accessToken;
    adminUserId = adminSignup.body.user.id;

    // Update admin user to have admin role
    await UserModel.findByIdAndUpdate(adminUserId, { role: 'admin' });
  });

  describe('POST /auth/2fa/verify', () => {
    it('should successfully verify and finalize 2FA enrollment (T6.1)', async () => {
      // Arrange - Enable 2FA first
      const enableResponse = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${userAccessToken}`);

      expect(enableResponse.status).toBe(200);
      const { tempSecretId, otpauthUrl } = enableResponse.body;

      // Extract secret from otpauthUrl
      const secretMatch = otpauthUrl.match(/secret=([A-Z2-7]+)/);
      expect(secretMatch).toBeTruthy();
      const secret = secretMatch ? secretMatch[1] : '';

      // Generate a valid TOTP token
      const token = speakeasy.totp({
        secret: secret,
        encoding: 'base32',
      });

      // Act - Verify the token
      const verifyResponse = await request(app)
        .post('/auth/2fa/verify')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ tempSecretId, token });

      // Assert
      expect(verifyResponse.status).toBe(200);
      expect(verifyResponse.body).toHaveProperty('status', 'enabled');
      expect(verifyResponse.body).toHaveProperty('enabledAt');

      // Verify user has 2FA enabled in database
      const user = await UserModel.findById(userId).select('twoFA');
      expect(user?.twoFA?.enabled).toBe(true);
      expect(user?.twoFA?.totpSecretEncrypted).toBeTruthy();
      expect(user?.twoFA?.enabledAt).toBeTruthy();

      // Verify temp secret was deleted
      const tempSecret = await TwoFATempModel.findById(tempSecretId);
      expect(tempSecret).toBeNull();
    });

    it('should fail with invalid TOTP token (T6.2)', async () => {
      // Arrange - Enable 2FA first
      const enableResponse = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${userAccessToken}`);

      const { tempSecretId } = enableResponse.body;

      // Act - Use invalid token
      const verifyResponse = await request(app)
        .post('/auth/2fa/verify')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ tempSecretId, token: '000000' });

      // Assert
      expect(verifyResponse.status).toBe(422);
      expect(verifyResponse.body).toHaveProperty('error');
      expect(verifyResponse.body.error).toHaveProperty('code', 'invalid_input');
      expect(verifyResponse.body.error.message).toContain('Invalid 2FA token');

      // Verify user still doesn't have 2FA enabled
      const user = await UserModel.findById(userId).select('twoFA');
      expect(user?.twoFA?.enabled).toBe(false);
    });

    it('should fail with expired temp secret (T6.3)', async () => {
      // Arrange - Enable 2FA first
      const enableResponse = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${userAccessToken}`);

      const { tempSecretId } = enableResponse.body;

      // Manually expire the temp secret
      await TwoFATempModel.findByIdAndUpdate(tempSecretId, {
        expiresAt: new Date(Date.now() - 1000),
      });

      // Act - Try to verify with expired secret
      const verifyResponse = await request(app)
        .post('/auth/2fa/verify')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ tempSecretId, token: '123456' });

      // Assert
      expect(verifyResponse.status).toBe(404);
      expect(verifyResponse.body).toHaveProperty('error');
      expect(verifyResponse.body.error).toHaveProperty('code', 'not_found');
      expect(verifyResponse.body.error.message).toContain('expired');
    });

    it('should fail when tempSecretId is invalid format', async () => {
      // Act
      const verifyResponse = await request(app)
        .post('/auth/2fa/verify')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ tempSecretId: 'invalid-id', token: '123456' });

      // Assert
      expect(verifyResponse.status).toBe(422);
      expect(verifyResponse.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post('/auth/2fa/verify')
        .send({ tempSecretId: '507f1f77bcf86cd799439011', token: '123456' });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /auth/2fa/disable', () => {
    it('should successfully disable 2FA when enabled (T6.4)', async () => {
      // Arrange - Enable 2FA first
      await UserModel.findByIdAndUpdate(userId, {
        'twoFA.enabled': true,
        'twoFA.totpSecretEncrypted': 'encrypted:somesecret',
        'twoFA.enabledAt': new Date(),
      });

      // Act
      const response = await request(app)
        .post('/auth/2fa/disable')
        .set('Authorization', `Bearer ${userAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'disabled');
      expect(response.body).toHaveProperty('disabledAt');

      // Verify 2FA is disabled in database
      const user = await UserModel.findById(userId).select('twoFA');
      expect(user?.twoFA?.enabled).toBe(false);
      expect(user?.twoFA?.totpSecretEncrypted).toBeUndefined();
    });

    it('should fail when 2FA is not enabled', async () => {
      // Act
      const response = await request(app)
        .post('/auth/2fa/disable')
        .set('Authorization', `Bearer ${userAccessToken}`);

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'invalid_input');
      expect(response.body.error.message).toContain('not currently enabled');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).post('/auth/2fa/disable');

      // Assert
      expect(response.status).toBe(401);
    });
  });

  describe('POST /auth/users/:userId/suspend', () => {
    it('should successfully suspend user as admin (T6.5)', async () => {
      // Act
      const response = await request(app)
        .post(`/auth/users/${userId}/suspend`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          reason: 'Violating terms of service',
          until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('userId', userId);
      expect(response.body).toHaveProperty('status', 'suspended');
      expect(response.body).toHaveProperty('reason', 'Violating terms of service');
      expect(response.body).toHaveProperty('suspendedAt');
      expect(response.body).toHaveProperty('until');

      // Verify user is suspended in database
      const user = await UserModel.findById(userId);
      expect(user?.status).toBe('suspended');
    });

    it('should fail when creator tries to suspend (T6.6)', async () => {
      // Arrange - Create another user to try to suspend
      const creatorSignup = await request(app).post('/auth/signup').send({
        email: 'creator@example.com',
        password: 'Password123',
        role: 'creator',
      });

      const creatorToken = creatorSignup.body.accessToken;

      // Act
      const response = await request(app)
        .post(`/auth/users/${userId}/suspend`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({ reason: 'Some reason for suspension' });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should fail with invalid userId format', async () => {
      // Act
      const response = await request(app)
        .post('/auth/users/invalid-id/suspend')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ reason: 'Some reason for suspension' });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when reason is too short', async () => {
      // Act
      const response = await request(app)
        .post(`/auth/users/${userId}/suspend`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ reason: 'Short' });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/auth/users/${userId}/suspend`)
        .send({ reason: 'Some reason for suspension' });

      // Assert
      expect(response.status).toBe(401);
    });
  });

  describe('POST /auth/users/:userId/unsuspend', () => {
    it('should successfully unsuspend user as admin', async () => {
      // Arrange - Suspend user first
      await UserModel.findByIdAndUpdate(userId, { status: 'suspended' });

      // Act
      const response = await request(app)
        .post(`/auth/users/${userId}/unsuspend`)
        .set('Authorization', `Bearer ${adminAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('userId', userId);
      expect(response.body).toHaveProperty('status', 'active');
      expect(response.body).toHaveProperty('unsuspendedAt');

      // Verify user is active in database
      const user = await UserModel.findById(userId);
      expect(user?.status).toBe('active');
    });

    it('should fail with non-existent user (T6.7)', async () => {
      // Act
      const response = await request(app)
        .post('/auth/users/507f1f77bcf86cd799439011/unsuspend')
        .set('Authorization', `Bearer ${adminAccessToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should fail when creator tries to unsuspend', async () => {
      // Arrange - Create creator and suspend a user
      const creatorSignup = await request(app).post('/auth/signup').send({
        email: 'creator2@example.com',
        password: 'Password123',
        role: 'creator',
      });

      const creatorToken = creatorSignup.body.accessToken;
      await UserModel.findByIdAndUpdate(userId, { status: 'suspended' });

      // Act
      const response = await request(app)
        .post(`/auth/users/${userId}/unsuspend`)
        .set('Authorization', `Bearer ${creatorToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).post(`/auth/users/${userId}/unsuspend`);

      // Assert
      expect(response.status).toBe(401);
    });
  });

  describe('2FA Complete Flow', () => {
    it('should complete full 2FA enrollment and verification flow', async () => {
      // Step 1: Enable 2FA
      const enableResponse = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${userAccessToken}`);

      expect(enableResponse.status).toBe(200);
      const { tempSecretId, otpauthUrl } = enableResponse.body;

      // Step 2: Extract secret and generate valid token
      const secretMatch = otpauthUrl.match(/secret=([A-Z2-7]+)/);
      const secret = secretMatch ? secretMatch[1] : '';
      const token = speakeasy.totp({ secret, encoding: 'base32' });

      // Step 3: Verify the token
      const verifyResponse = await request(app)
        .post('/auth/2fa/verify')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ tempSecretId, token });

      expect(verifyResponse.status).toBe(200);

      // Step 4: Verify /auth/me shows 2FA as enabled
      const meResponse = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${userAccessToken}`);

      expect(meResponse.status).toBe(200);
      expect(meResponse.body).toHaveProperty('twoFAEnabled', true);
    });

    it('should allow disabling 2FA after it was enabled', async () => {
      // Arrange - Enable and verify 2FA
      const enableResponse = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${userAccessToken}`);

      const { tempSecretId, otpauthUrl } = enableResponse.body;
      const secretMatch = otpauthUrl.match(/secret=([A-Z2-7]+)/);
      const secret = secretMatch ? secretMatch[1] : '';
      const token = speakeasy.totp({ secret, encoding: 'base32' });

      await request(app)
        .post('/auth/2fa/verify')
        .set('Authorization', `Bearer ${userAccessToken}`)
        .send({ tempSecretId, token });

      // Act - Disable 2FA
      const disableResponse = await request(app)
        .post('/auth/2fa/disable')
        .set('Authorization', `Bearer ${userAccessToken}`);

      // Assert
      expect(disableResponse.status).toBe(200);
      expect(disableResponse.body).toHaveProperty('status', 'disabled');

      // Verify in /auth/me
      const meResponse = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${userAccessToken}`);

      expect(meResponse.body).toHaveProperty('twoFAEnabled', false);
    });
  });

  describe('Admin Suspension Flow', () => {
    it('should prevent suspended user from accessing protected endpoints', async () => {
      // Arrange - Admin suspends user
      await request(app)
        .post(`/auth/users/${userId}/suspend`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ reason: 'Testing suspension functionality' });

      // Act - Suspended user tries to access /auth/me
      const response = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${userAccessToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'account_inactive');
    });

    it('should allow access after admin unsuspends user', async () => {
      // Arrange - Suspend then unsuspend
      await request(app)
        .post(`/auth/users/${userId}/suspend`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ reason: 'Testing suspension functionality' });

      await request(app)
        .post(`/auth/users/${userId}/unsuspend`)
        .set('Authorization', `Bearer ${adminAccessToken}`);

      // Act - User tries to access /auth/me
      const response = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${userAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'active');
    });
  });

  describe('Owner role permissions', () => {
    it('should not allow owner to suspend users', async () => {
      // Arrange - Create owner
      const ownerSignup = await request(app).post('/auth/signup').send({
        email: 'owner@example.com',
        password: 'Password123',
        role: 'owner',
      });

      const ownerToken = ownerSignup.body.accessToken;

      // Act
      const response = await request(app)
        .post(`/auth/users/${userId}/suspend`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ reason: 'Owner attempting suspension' });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });
  });
});

