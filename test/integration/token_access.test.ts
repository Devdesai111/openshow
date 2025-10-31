import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';

describe('Token Refresh and Auth Me Integration Tests', () => {
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

    // Create a test user and get tokens
    const signupResponse = await request(app).post('/auth/signup').send({
      email: 'testuser@example.com',
      password: 'StrongPassword123',
      role: 'creator',
      fullName: 'Test User',
    });

    accessToken = signupResponse.body.accessToken;
    refreshToken = signupResponse.body.refreshToken;
    userId = signupResponse.body.user.id;
  });

  describe('POST /auth/refresh', () => {
    it('should successfully issue new token pair with rotation (T4.1)', async () => {
      // Wait 1 second to ensure different timestamp in JWT
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Act
      const response = await request(app).post('/auth/refresh').send({
        refreshToken: refreshToken,
      });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body).toHaveProperty('tokenType', 'Bearer');
      expect(response.body).toHaveProperty('expiresIn', 900);

      // Verify new tokens are different from old
      expect(response.body.accessToken).not.toBe(accessToken);
      expect(response.body.refreshToken).not.toBe(refreshToken);

      // Verify old session was invalidated
      const oldSessionCount = await AuthSessionModel.countDocuments({
        refreshTokenHash: { $exists: true },
        expiresAt: { $lte: new Date() },
      });
      expect(oldSessionCount).toBeGreaterThan(0);
    });

    it('should fail when re-using old refresh token after rotation (T4.2)', async () => {
      // Arrange - Use refresh token once
      await request(app).post('/auth/refresh').send({ refreshToken: refreshToken });

      // Act - Try to use the same token again
      const response = await request(app).post('/auth/refresh').send({
        refreshToken: refreshToken,
      });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'session_expired');
      expect(response.body.error).toHaveProperty('message');
      expect(response.body.error.message).toContain('expired or invalid');
    });

    it('should fail with non-existent refresh token (T4.3)', async () => {
      // Act
      const response = await request(app).post('/auth/refresh').send({
        refreshToken: 'non-existent-token-12345',
      });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'session_expired');
    });

    it('should fail when refresh token is missing', async () => {
      // Act
      const response = await request(app).post('/auth/refresh').send({});

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'invalid_input');
      expect(response.body.error.message).toContain('Refresh token is required');
    });

    it('should fail when refresh token is not a string', async () => {
      // Act
      const response = await request(app).post('/auth/refresh').send({
        refreshToken: 12345,
      });

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'invalid_input');
    });

    it('should create a new session after successful refresh', async () => {
      // Arrange - Count sessions before
      const sessionsBefore = await AuthSessionModel.countDocuments({});

      // Act
      await request(app).post('/auth/refresh').send({ refreshToken: refreshToken });

      // Assert - Should have one more session
      const sessionsAfter = await AuthSessionModel.countDocuments({});
      expect(sessionsAfter).toBe(sessionsBefore + 1);
    });
  });

  describe('GET /auth/me', () => {
    it('should successfully retrieve current user profile (T4.4)', async () => {
      // Act
      const response = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', userId);
      expect(response.body).toHaveProperty('email', 'testuser@example.com');
      expect(response.body).toHaveProperty('fullName', 'Test User');
      expect(response.body).toHaveProperty('role', 'creator');
      expect(response.body).toHaveProperty('status', 'active');
      expect(response.body).toHaveProperty('twoFAEnabled', false);
      expect(response.body).toHaveProperty('socialAccounts');
      expect(response.body).toHaveProperty('preferredName');
      expect(response.body).toHaveProperty('createdAt');
      expect(response.body).not.toHaveProperty('hashedPassword');
      expect(Array.isArray(response.body.socialAccounts)).toBe(true);
    });

    it('should update lastSeenAt when retrieving profile', async () => {
      // Arrange - Get initial lastSeenAt
      const userBefore = await UserModel.findById(userId);
      const lastSeenBefore = userBefore?.lastSeenAt;

      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 100));

      // Act
      await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);

      // Assert
      const userAfter = await UserModel.findById(userId);
      const lastSeenAfter = userAfter?.lastSeenAt;

      expect(lastSeenAfter).toBeTruthy();
      if (lastSeenBefore) {
        expect(lastSeenAfter!.getTime()).toBeGreaterThan(lastSeenBefore.getTime());
      }
    });

    it('should fail when suspended user tries to access (T4.5)', async () => {
      // Arrange - Suspend the user
      await UserModel.findByIdAndUpdate(userId, { status: 'suspended' });

      // Act
      const response = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'account_inactive');
      expect(response.body.error.message).toContain('suspended');
    });

    it('should fail when deleted user tries to access', async () => {
      // Arrange - Delete the user
      await UserModel.findByIdAndUpdate(userId, { status: 'deleted' });

      // Act
      const response = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'account_inactive');
    });

    it('should fail with invalid access token (T4.6)', async () => {
      // Act
      const response = await request(app)
        .get('/auth/me')
        .set('Authorization', 'Bearer invalid.jwt.token');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'invalid_token');
    });

    it('should fail when no authorization header is provided', async () => {
      // Act
      const response = await request(app).get('/auth/me');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should include social accounts in response', async () => {
      // Arrange - Create user with social account via OAuth
      const oauthResponse = await request(app).post('/auth/oauth').send({
        provider: 'google',
        providerAccessToken: 'valid-token-social-test',
      });

      // Act
      const response = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${oauthResponse.body.accessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.socialAccounts).toBeTruthy();
      expect(Array.isArray(response.body.socialAccounts)).toBe(true);
      expect(response.body.socialAccounts.length).toBeGreaterThanOrEqual(1);
      
      // Verify all social accounts have required fields
      response.body.socialAccounts.forEach((account: { provider: string; providerId: string; connectedAt: string }) => {
        expect(account).toHaveProperty('provider');
        expect(account).toHaveProperty('providerId');
        expect(account).toHaveProperty('connectedAt');
      });
    });
  });

  describe('Token Rotation Security', () => {
    it('should invalidate old token when refresh is successful', async () => {
      // Act
      const response = await request(app).post('/auth/refresh').send({ refreshToken: refreshToken });

      // Assert
      expect(response.status).toBe(200);

      // Verify old session is marked as expired
      const expiredSessions = await AuthSessionModel.countDocuments({
        expiresAt: { $lte: new Date() },
      });
      expect(expiredSessions).toBeGreaterThan(0);
    });

    it('should allow using the new refresh token after rotation', async () => {
      // Arrange - Get new tokens
      const firstRefresh = await request(app).post('/auth/refresh').send({ refreshToken: refreshToken });

      const newRefreshToken = firstRefresh.body.refreshToken;

      // Act - Use the new refresh token
      const secondRefresh = await request(app).post('/auth/refresh').send({
        refreshToken: newRefreshToken,
      });

      // Assert
      expect(secondRefresh.status).toBe(200);
      expect(secondRefresh.body).toHaveProperty('accessToken');
      expect(secondRefresh.body).toHaveProperty('refreshToken');
    });
  });
});

