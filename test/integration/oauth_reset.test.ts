import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { PasswordResetModel } from '../../src/models/passwordReset.model';

describe('OAuth and Password Reset Integration Tests', () => {
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
    await PasswordResetModel.deleteMany({});
  });

  describe('POST /auth/oauth', () => {
    it('should create new user and return 201 with tokens (T3.1)', async () => {
      // Arrange
      const oauthData = {
        provider: 'google',
        providerAccessToken: 'valid-token-new-user',
        role: 'creator',
      };

      // Act
      const response = await request(app).post('/auth/oauth').send(oauthData);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body).toHaveProperty('tokenType', 'Bearer');
      expect(response.body).toHaveProperty('expiresIn', 900);
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('id');
      expect(response.body.user).toHaveProperty('email', 'oauth.user@example.com');
      expect(response.body.user).toHaveProperty('role', 'creator');
      expect(response.body.user).toHaveProperty('status', 'active');
      expect(response.body.user).not.toHaveProperty('hashedPassword');

      // Verify user was created in database
      const user = await UserModel.findOne({ email: 'oauth.user@example.com' });
      expect(user).toBeTruthy();
      expect(user?.socialAccounts).toHaveLength(1);
      expect(user?.socialAccounts[0]?.provider).toBe('google');

      // Verify session was created
      const session = await AuthSessionModel.findOne({ userId: user?._id });
      expect(session).toBeTruthy();
    });

    it('should login existing user and return 200 with tokens (T3.2)', async () => {
      // Arrange - Create user first via OAuth
      const oauthData = {
        provider: 'google',
        providerAccessToken: 'valid-token-existing',
      };

      await request(app).post('/auth/oauth').send(oauthData);

      // Act - Login again with same OAuth
      const response = await request(app).post('/auth/oauth').send(oauthData);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('email', 'oauth.user@example.com');

      // Verify only one user exists
      const users = await UserModel.find({ email: 'oauth.user@example.com' });
      expect(users).toHaveLength(1);
    });

    it('should return 400 when provider token is invalid (T3.3)', async () => {
      // Arrange
      const oauthData = {
        provider: 'google',
        providerAccessToken: 'invalid-token',
      };

      // Act
      const response = await request(app).post('/auth/oauth').send(oauthData);

      // Assert
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'invalid_input');
      expect(response.body.error).toHaveProperty('message');
      expect(response.body.error.message).toContain('provider token is invalid');
    });

    it('should return 422 when provider is invalid', async () => {
      // Arrange
      const oauthData = {
        provider: 'facebook', // Not in allowed list
        providerAccessToken: 'valid-token',
      };

      // Act
      const response = await request(app).post('/auth/oauth').send(oauthData);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should link social account to existing email-based user', async () => {
      // Arrange - Create user with email/password first
      await request(app).post('/auth/signup').send({
        email: 'oauth.user@example.com',
        password: 'StrongPassword123',
      });

      // Act - Login with OAuth using same email
      const oauthData = {
        provider: 'google',
        providerAccessToken: 'valid-token-link',
      };
      const response = await request(app).post('/auth/oauth').send(oauthData);

      // Assert
      expect(response.status).toBe(200);

      // Verify social account was linked
      const user = await UserModel.findOne({ email: 'oauth.user@example.com' }).select('+hashedPassword');
      expect(user?.socialAccounts).toHaveLength(1);
      expect(user?.socialAccounts[0]?.provider).toBe('google');
      expect(user?.hashedPassword).toBeTruthy(); // Original password should still exist
    });
  });

  describe('POST /auth/password-reset/request', () => {
    it('should return 200 when user exists (T3.4)', async () => {
      // Arrange - Create user first
      await request(app).post('/auth/signup').send({
        email: 'test@exists.com',
        password: 'StrongPassword123',
      });

      const resetData = {
        email: 'test@exists.com',
        redirectUrl: 'https://app.com/reset',
      };

      // Act
      const response = await request(app).post('/auth/password-reset/request').send(resetData);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('password reset link has been sent');

      // Verify reset token was created
      const user = await UserModel.findOne({ email: 'test@exists.com' });
      const resetToken = await PasswordResetModel.findOne({ userId: user?._id });
      expect(resetToken).toBeTruthy();
      expect(resetToken?.tokenHash).toBeTruthy();
      expect(resetToken?.expiresAt).toBeTruthy();
      expect(resetToken?.isUsed).toBe(false);
    });

    it('should return 200 when user does not exist (security - T3.5)', async () => {
      // Arrange
      const resetData = {
        email: 'unknown@a.com',
        redirectUrl: 'https://app.com/reset',
      };

      // Act
      const response = await request(app).post('/auth/password-reset/request').send(resetData);

      // Assert - Should return same response as when user exists (security)
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('password reset link has been sent');

      // Verify no reset token was created
      const resetTokens = await PasswordResetModel.find({});
      expect(resetTokens).toHaveLength(0);
    });

    it('should return 422 when email format is invalid (T3.6)', async () => {
      // Arrange
      const resetData = {
        email: 'bademail',
        redirectUrl: 'https://app.com/reset',
      };

      // Act
      const response = await request(app).post('/auth/password-reset/request').send(resetData);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error).toHaveProperty('details');
    });

    it('should return 422 when redirectUrl is missing', async () => {
      // Arrange
      const resetData = {
        email: 'test@example.com',
      };

      // Act
      const response = await request(app).post('/auth/password-reset/request').send(resetData);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should invalidate old reset tokens when requesting new one', async () => {
      // Arrange - Create user and request reset twice
      await request(app).post('/auth/signup').send({
        email: 'test@double.com',
        password: 'StrongPassword123',
      });

      const resetData = {
        email: 'test@double.com',
        redirectUrl: 'https://app.com/reset',
      };

      // Act - Request reset twice
      await request(app).post('/auth/password-reset/request').send(resetData);
      await request(app).post('/auth/password-reset/request').send(resetData);

      // Assert - Only one active token should exist
      const user = await UserModel.findOne({ email: 'test@double.com' });
      const activeTokens = await PasswordResetModel.find({ userId: user?._id, isUsed: false });
      expect(activeTokens).toHaveLength(1);

      // Verify old token is marked as used
      const allTokens = await PasswordResetModel.find({ userId: user?._id });
      expect(allTokens.length).toBeGreaterThanOrEqual(2);
      const usedTokens = allTokens.filter(t => t.isUsed);
      expect(usedTokens.length).toBeGreaterThanOrEqual(1);
    });

    it('should set proper expiration time on reset token', async () => {
      // Arrange
      await request(app).post('/auth/signup').send({
        email: 'test@expiry.com',
        password: 'StrongPassword123',
      });

      const resetData = {
        email: 'test@expiry.com',
        redirectUrl: 'https://app.com/reset',
      };

      // Act
      await request(app).post('/auth/password-reset/request').send(resetData);

      // Assert
      const user = await UserModel.findOne({ email: 'test@expiry.com' });
      const resetToken = await PasswordResetModel.findOne({ userId: user?._id });

      expect(resetToken).toBeTruthy();
      expect(resetToken?.expiresAt).toBeTruthy();

      // Expiry should be approximately 1 hour from now (allow 10 second tolerance)
      const expectedExpiry = new Date(Date.now() + 60 * 60 * 1000);
      const actualExpiry = resetToken?.expiresAt.getTime() || 0;
      const diff = Math.abs(actualExpiry - expectedExpiry.getTime());
      expect(diff).toBeLessThan(10000); // Within 10 seconds
    });
  });
});

