import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { TwoFATempModel } from '../../src/models/twoFATemp.model';

describe('Logout and 2FA Integration Tests', () => {
  let accessToken: string;
  let refreshToken: string;
  let userId: string;

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

    // Create a test user and get tokens
    const signupResponse = await request(app).post('/auth/signup').send({
      email: 'logouttest@example.com',
      password: 'StrongPassword123',
      role: 'creator',
    });

    accessToken = signupResponse.body.accessToken;
    refreshToken = signupResponse.body.refreshToken;
    userId = signupResponse.body.user.id;
  });

  describe('POST /auth/logout', () => {
    it('should successfully revoke session and return 204 (T5.1)', async () => {
      // Act
      const response = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken: refreshToken });

      // Assert
      expect(response.status).toBe(204);
      expect(response.body).toEqual({});

      // Verify session was deleted from database
      const session = await AuthSessionModel.findOne({ userId: userId });
      expect(session).toBeNull();
    });

    it('should fail to refresh after successful logout', async () => {
      // Arrange - Logout first
      await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken: refreshToken });

      // Act - Try to use the refresh token
      const response = await request(app).post('/auth/refresh').send({ refreshToken: refreshToken });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'session_expired');
    });

    it('should return 400 when refresh token is missing (T5.2)', async () => {
      // Act
      const response = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'invalid_input');
      expect(response.body.error.message).toContain('Refresh token is required');
    });

    it('should return 400 when session is already revoked (T5.3)', async () => {
      // Arrange - Logout once
      await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken: refreshToken });

      // Act - Try to logout again with same token
      const response = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken: refreshToken });

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'not_found');
      expect(response.body.error.message).toContain('already revoked');
    });

    it('should return 400 when refresh token is invalid', async () => {
      // Act
      const response = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken: 'invalid-token-12345' });

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act - No auth token
      const response = await request(app).post('/auth/logout').send({ refreshToken: refreshToken });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /auth/2fa/enable', () => {
    it('should successfully generate 2FA secret and return details (T5.4)', async () => {
      // Act
      const response = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${accessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('tempSecretId');
      expect(response.body).toHaveProperty('otpauthUrl');
      expect(response.body).toHaveProperty('expiresAt');
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Scan the QR code');
      expect(response.body.otpauthUrl).toContain('otpauth://totp/');
      expect(response.body.otpauthUrl).toContain('OpenShow');
      // Email is URL-encoded in otpauth URL
      expect(response.body.otpauthUrl).toMatch(/logouttest(%40|@)example\.com/);

      // Verify temporary secret was created
      const tempSecret = await TwoFATempModel.findById(response.body.tempSecretId);
      expect(tempSecret).toBeTruthy();
      expect(tempSecret?.userId.toString()).toBe(userId);
      expect(tempSecret?.tempSecretEncrypted).toBeTruthy();
      expect(tempSecret?.expiresAt).toBeTruthy();
    });

    it('should set proper expiration time on temp secret (10 minutes)', async () => {
      // Act
      const response = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${accessToken}`);

      // Assert
      const expiresAt = new Date(response.body.expiresAt);
      const expectedExpiry = new Date(Date.now() + 10 * 60 * 1000);
      const diff = Math.abs(expiresAt.getTime() - expectedExpiry.getTime());
      expect(diff).toBeLessThan(5000); // Within 5 seconds
    });

    it('should fail when 2FA is already enabled (T5.5)', async () => {
      // Arrange - Enable 2FA on user
      await UserModel.findByIdAndUpdate(userId, {
        'twoFA.enabled': true,
        'twoFA.totpSecretEncrypted': 'encrypted:somesecret',
      });

      // Act
      const response = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${accessToken}`);

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already enabled');
    });

    it('should require authentication', async () => {
      // Act - No auth token
      const response = await request(app).post('/auth/2fa/enable');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should encrypt the temporary secret before storage', async () => {
      // Act
      const response = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${accessToken}`);

      // Assert
      const tempSecret = await TwoFATempModel.findById(response.body.tempSecretId);
      expect(tempSecret?.tempSecretEncrypted).toContain('encrypted:');
    });

    it('should allow multiple enable attempts if previous expired', async () => {
      // Arrange - Create first temp secret
      const firstResponse = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${accessToken}`);

      // Manually expire the first temp secret
      await TwoFATempModel.findByIdAndUpdate(firstResponse.body.tempSecretId, {
        expiresAt: new Date(Date.now() - 1000),
      });

      // Act - Create second temp secret
      const secondResponse = await request(app)
        .post('/auth/2fa/enable')
        .set('Authorization', `Bearer ${accessToken}`);

      // Assert
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.tempSecretId).not.toBe(firstResponse.body.tempSecretId);
    });
  });

  describe('Logout Impact on Other Sessions', () => {
    it('should only revoke the specified session, not all sessions', async () => {
      // Arrange - Create a second session by logging in again
      const loginResponse = await request(app).post('/auth/login').send({
        email: 'logouttest@example.com',
        password: 'StrongPassword123',
      });

      const secondRefreshToken = loginResponse.body.refreshToken;

      // Verify we have 2 sessions
      const sessionsBefore = await AuthSessionModel.countDocuments({ userId: userId });
      expect(sessionsBefore).toBe(2);

      // Act - Logout only the first session
      await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken: refreshToken });

      // Assert - Second session should still be valid
      const sessionsAfter = await AuthSessionModel.countDocuments({ userId: userId });
      expect(sessionsAfter).toBe(1);

      // Verify second refresh token still works
      const refreshResponse = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: secondRefreshToken });

      expect(refreshResponse.status).toBe(200);
    });
  });
});

