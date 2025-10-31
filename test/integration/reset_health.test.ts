import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { PasswordResetModel } from '../../src/models/passwordReset.model';

describe('Password Reset Confirmation and Health Check Integration Tests', () => {
  let adminAccessToken: string;

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

    // Create admin user for metrics test
    const adminSignup = await request(app).post('/auth/signup').send({
      email: 'admin@example.com',
      password: 'AdminPassword123',
      role: 'creator',
    });

    adminAccessToken = adminSignup.body.accessToken;
    await UserModel.findOneAndUpdate({ email: 'admin@example.com' }, { role: 'admin' });
  });

  describe('POST /auth/password-reset/confirm', () => {
    it('should successfully reset password with valid token (T7.1)', async () => {
      // Arrange - Create user and request password reset
      const signupResponse = await request(app).post('/auth/signup').send({
        email: 'resetuser@example.com',
        password: 'OldPassword123',
      });

      const userId = signupResponse.body.user.id;

      // Count sessions after signup
      const sessionsAfterSignup = await AuthSessionModel.countDocuments({ userId: userId });
      expect(sessionsAfterSignup).toBe(1);

      // Request password reset
      await request(app).post('/auth/password-reset/request').send({
        email: 'resetuser@example.com',
        redirectUrl: 'https://app.com/reset',
      });

      // Get the reset token from database
      const resetRecord = await PasswordResetModel.findOne({ userId: userId });
      expect(resetRecord).toBeTruthy();

      // We can't get the plain token easily, so we'll manually create one for testing
      // In real scenario, user receives this via email
      const plainToken = 'test-reset-token-12345678901234567890';
      const bcrypt = require('bcryptjs');
      const tokenHash = await bcrypt.hash(plainToken, 10);

      // Update the reset record with our known token
      await PasswordResetModel.findByIdAndUpdate(resetRecord?._id, { tokenHash });

      // Act - Confirm password reset
      const response = await request(app).post('/auth/password-reset/confirm').send({
        token: plainToken,
        newPassword: 'NewStrongP@ss123',
      });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Password successfully reset');

      // Verify all old sessions were revoked BEFORE new login
      const sessionsAfterReset = await AuthSessionModel.countDocuments({ userId: userId });
      expect(sessionsAfterReset).toBe(0);

      // Verify password was updated - can login with new password
      const loginResponse = await request(app).post('/auth/login').send({
        email: 'resetuser@example.com',
        password: 'NewStrongP@ss123',
      });
      expect(loginResponse.status).toBe(200);

      // Verify old password no longer works
      const oldLoginResponse = await request(app).post('/auth/login').send({
        email: 'resetuser@example.com',
        password: 'OldPassword123',
      });
      expect(oldLoginResponse.status).toBe(401);

      // Verify reset token was marked as used
      const usedRecord = await PasswordResetModel.findById(resetRecord?._id);
      expect(usedRecord?.isUsed).toBe(true);
    });

    it('should fail with invalid/expired token (T7.2)', async () => {
      // Act
      const response = await request(app).post('/auth/password-reset/confirm').send({
        token: 'invalid-token-does-not-exist',
        newPassword: 'NewStrongP@ss123',
      });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'token_invalid');
      expect(response.body.error.message).toContain('invalid or has expired');
    });

    it('should fail with weak password (T7.3)', async () => {
      // Arrange - Create user and reset token
      await request(app).post('/auth/signup').send({
        email: 'weakpass@example.com',
        password: 'OldPassword123',
      });

      // Act
      const response = await request(app).post('/auth/password-reset/confirm').send({
        token: 'some-valid-token-12345678901234567890',
        newPassword: 'weak',
      });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error).toHaveProperty('details');
    });

    it('should fail when token is missing', async () => {
      // Act
      const response = await request(app).post('/auth/password-reset/confirm').send({
        newPassword: 'NewStrongP@ss123',
      });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when password is missing', async () => {
      // Act
      const response = await request(app).post('/auth/password-reset/confirm').send({
        token: 'some-token',
      });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should revoke all user sessions on successful reset', async () => {
      // Arrange - Create user with multiple sessions
      const signupResponse = await request(app).post('/auth/signup').send({
        email: 'multisession@example.com',
        password: 'OldPassword123',
      });

      const userId = signupResponse.body.user.id;

      // Create second session
      await request(app).post('/auth/login').send({
        email: 'multisession@example.com',
        password: 'OldPassword123',
      });

      // Verify multiple sessions exist
      const sessionsBefore = await AuthSessionModel.countDocuments({ userId: userId });
      expect(sessionsBefore).toBe(2);

      // Request and confirm reset
      await request(app).post('/auth/password-reset/request').send({
        email: 'multisession@example.com',
        redirectUrl: 'https://app.com/reset',
      });

      const resetRecord = await PasswordResetModel.findOne({ userId: userId });
      const plainToken = 'test-multi-session-token-12345678901234567890';
      const bcrypt = require('bcryptjs');
      const tokenHash = await bcrypt.hash(plainToken, 10);
      await PasswordResetModel.findByIdAndUpdate(resetRecord?._id, { tokenHash });

      // Act - Confirm reset
      await request(app).post('/auth/password-reset/confirm').send({
        token: plainToken,
        newPassword: 'NewPassword123',
      });

      // Assert - All sessions should be revoked
      const sessionsAfter = await AuthSessionModel.countDocuments({ userId: userId });
      expect(sessionsAfter).toBe(0);
    });
  });

  describe('GET /health', () => {
    it('should return health status with DB ok (T7.4)', async () => {
      // Act
      const response = await request(app).get('/health');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('db', 'ok');
      expect(response.body).toHaveProperty('service');
      expect(response.body).toHaveProperty('uptimeSeconds');
      expect(response.body).toHaveProperty('responseTimeMs');
      expect(response.body).toHaveProperty('date');
      expect(typeof response.body.uptimeSeconds).toBe('number');
      expect(typeof response.body.responseTimeMs).toBe('number');
    });

    it('should not require authentication (public endpoint)', async () => {
      // Act - No auth header
      const response = await request(app).get('/health');

      // Assert
      expect(response.status).toBe(200);
    });

    it('should respond quickly (performance check)', async () => {
      // Act
      const startTime = Date.now();
      const response = await request(app).get('/health');
      const duration = Date.now() - startTime;

      // Assert - Should respond in under 1 second
      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('GET /metrics', () => {
    it('should fail when creator tries to access (T7.5)', async () => {
      // Arrange - Create creator
      const creatorSignup = await request(app).post('/auth/signup').send({
        email: 'creator@example.com',
        password: 'Password123',
        role: 'creator',
      });

      const creatorToken = creatorSignup.body.accessToken;

      // Act
      const response = await request(app).get('/metrics').set('Authorization', `Bearer ${creatorToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should succeed when admin accesses (T7.6)', async () => {
      // Act
      const response = await request(app).get('/metrics').set('Authorization', `Bearer ${adminAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('node_uptime_seconds');
      expect(response.text).toContain('custom_db_connection_status');
      expect(response.text).toContain('# HELP');
      expect(response.text).toContain('# TYPE');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).get('/metrics');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should return Prometheus format metrics', async () => {
      // Act
      const response = await request(app).get('/metrics').set('Authorization', `Bearer ${adminAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toMatch(/# HELP/);
      expect(response.text).toMatch(/# TYPE/);
      expect(response.text).toMatch(/gauge|counter/);
    });
  });
});

