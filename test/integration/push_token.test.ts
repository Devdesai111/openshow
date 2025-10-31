import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';

describe('Push Token Management Integration Tests', () => {
  let userToken: string;
  let userId: string;
  let userBToken: string;
  let userBId: string;

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

    // Create user A
    const signupA = await request(app).post('/auth/signup').send({
      email: 'usera@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'User A',
    });
    userToken = signupA.body.accessToken;
    const userA = await UserModel.findOne({ email: 'usera@example.com' });
    userId = userA!._id.toString();

    // Create user B
    const signupB = await request(app).post('/auth/signup').send({
      email: 'userb@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'User B',
    });
    userBToken = signupB.body.accessToken;
    const userB = await UserModel.findOne({ email: 'userb@example.com' });
    userBId = userB!._id.toString();
  });

  describe('POST /settings/:userId/push-token', () => {
    it('T49.1 - should register a new push token (200 OK)', async () => {
      // Arrange
      const payload = {
        token: 'fcm_token_12345',
        deviceId: 'device_abc',
        provider: 'fcm',
      };

      // Act
      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('message', 'Push token registered successfully.');

      // Verify DB update
      const user = await UserModel.findById(userId).lean();
      expect(user!.pushTokens).toHaveLength(1);
      expect(user!.pushTokens[0]).toBeDefined();
      expect(user!.pushTokens[0]!.token).toBe('fcm_token_12345');
      expect(user!.pushTokens[0]!.deviceId).toBe('device_abc');
      expect(user!.pushTokens[0]!.provider).toBe('fcm');
      expect(user!.pushTokens[0]!.lastUsed).toBeDefined();
    });

    it('T49.2 - should update token when same deviceId is used (upsert device)', async () => {
      // Arrange - Register initial token
      const initialPayload = {
        token: 'fcm_token_old',
        deviceId: 'device_abc',
        provider: 'fcm',
      };

      await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(initialPayload);

      // Act - Register new token for same device
      const newPayload = {
        token: 'fcm_token_new',
        deviceId: 'device_abc',
        provider: 'fcm',
      };

      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(newPayload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');

      // Verify DB update - old token removed, new token added
      const user = await UserModel.findById(userId).lean();
      expect(user!.pushTokens).toHaveLength(1);
      expect(user!.pushTokens[0]).toBeDefined();
      expect(user!.pushTokens[0]!.token).toBe('fcm_token_new');
      expect(user!.pushTokens[0]!.deviceId).toBe('device_abc');
    });

    it('should update lastUsed when same token is re-registered', async () => {
      // Arrange - Register initial token
      const payload = {
        token: 'fcm_token_same',
        deviceId: 'device_xyz',
        provider: 'fcm',
      };

      await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      const firstRegistration = await UserModel.findById(userId).lean();
      expect(firstRegistration!.pushTokens[0]).toBeDefined();
      const firstLastUsed = firstRegistration!.pushTokens[0]!.lastUsed;

      // Wait a bit to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      // Act - Re-register same token
      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);

      // Verify lastUsed was updated
      const user = await UserModel.findById(userId).lean();
      expect(user!.pushTokens).toHaveLength(1);
      expect(user!.pushTokens[0]).toBeDefined();
      expect(new Date(user!.pushTokens[0]!.lastUsed).getTime()).toBeGreaterThan(
        new Date(firstLastUsed).getTime()
      );
    });

    it('should support multiple tokens for different devices', async () => {
      // Arrange
      const token1 = {
        token: 'fcm_token_1',
        deviceId: 'device_1',
        provider: 'fcm',
      };

      const token2 = {
        token: 'fcm_token_2',
        deviceId: 'device_2',
        provider: 'fcm',
      };

      // Act
      await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(token1);

      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(token2);

      // Assert
      expect(response.status).toBe(200);

      // Verify both tokens exist
      const user = await UserModel.findById(userId).lean();
      expect(user!.pushTokens).toHaveLength(2);
      expect(user!.pushTokens.map(t => t.token)).toContain('fcm_token_1');
      expect(user!.pushTokens.map(t => t.token)).toContain('fcm_token_2');
    });

    it('should require authentication', async () => {
      // Arrange
      const payload = {
        token: 'fcm_token_12345',
        deviceId: 'device_abc',
        provider: 'fcm',
      };

      // Act
      const response = await request(app).post(`/settings/${userId}/push-token`).send(payload);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should return 403 for unauthorized user', async () => {
      // Arrange
      const payload = {
        token: 'fcm_token_12345',
        deviceId: 'device_abc',
        provider: 'fcm',
      };

      // Act
      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should return 422 for missing required fields', async () => {
      // Arrange
      const payload = {
        token: 'fcm_token_12345',
        // Missing deviceId and provider
      };

      // Act
      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });

  describe('DELETE /settings/:userId/push-token', () => {
    beforeEach(async () => {
      // Register a token before each delete test
      await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          token: 'fcm_token_to_delete',
          deviceId: 'device_delete',
          provider: 'fcm',
        });
    });

    it('T49.3 - should delete push token (204 No Content)', async () => {
      // Arrange
      const payload = {
        token: 'fcm_token_to_delete',
      };

      // Act
      const response = await request(app)
        .delete(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(204);

      // Verify DB delete
      const user = await UserModel.findById(userId).lean();
      expect(user!.pushTokens).toHaveLength(0);
    });

    it('T49.4 - should return 404 for non-existent token', async () => {
      // Arrange
      const payload = {
        token: 'fcm_token_nonexistent',
      };

      // Act
      const response = await request(app)
        .delete(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
      expect(response.body.error).toHaveProperty('message', 'Token not found for this user/device.');
    });

    it('should require authentication', async () => {
      // Arrange
      const payload = {
        token: 'fcm_token_to_delete',
      };

      // Act
      const response = await request(app).delete(`/settings/${userId}/push-token`).send(payload);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should return 403 for unauthorized user', async () => {
      // Arrange
      const payload = {
        token: 'fcm_token_to_delete',
      };

      // Act
      const response = await request(app)
        .delete(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should return 422 for missing token', async () => {
      // Arrange
      const payload = {};

      // Act
      const response = await request(app)
        .delete(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should only delete token for the specified user', async () => {
      // Arrange - Register tokens for both users
      await request(app)
        .post(`/settings/${userBId}/push-token`)
        .set('Authorization', `Bearer ${userBToken}`)
        .send({
          token: 'fcm_token_userb',
          deviceId: 'device_userb',
          provider: 'fcm',
        });

      // Act - Try to delete userB's token as userA (should fail with 403)
      const response = await request(app)
        .delete(`/settings/${userBId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          token: 'fcm_token_userb',
        });

      // Assert
      expect(response.status).toBe(403);

      // Verify userB's token still exists
      const userB = await UserModel.findById(userBId).lean();
      expect(userB!.pushTokens).toHaveLength(1);
      expect(userB!.pushTokens[0]).toBeDefined();
      expect(userB!.pushTokens[0]!.token).toBe('fcm_token_userb');
    });
  });

  describe('Provider Types', () => {
    it('should support FCM provider', async () => {
      // Arrange
      const payload = {
        token: 'fcm_token_123',
        deviceId: 'device_fcm',
        provider: 'fcm',
      };

      // Act
      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);

      const user = await UserModel.findById(userId).lean();
      expect(user!.pushTokens[0]).toBeDefined();
      expect(user!.pushTokens[0]!.provider).toBe('fcm');
    });

    it('should support APNS provider', async () => {
      // Arrange
      const payload = {
        token: 'apns_token_123',
        deviceId: 'device_apns',
        provider: 'apns',
      };

      // Act
      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);

      const user = await UserModel.findById(userId).lean();
      expect(user!.pushTokens[0]).toBeDefined();
      expect(user!.pushTokens[0]!.provider).toBe('apns');
    });

    it('should support Web provider', async () => {
      // Arrange
      const payload = {
        token: 'web_token_123',
        deviceId: 'device_web',
        provider: 'web',
      };

      // Act
      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);

      const user = await UserModel.findById(userId).lean();
      expect(user!.pushTokens[0]).toBeDefined();
      expect(user!.pushTokens[0]!.provider).toBe('web');
    });

    it('should return 422 for invalid provider', async () => {
      // Arrange
      const payload = {
        token: 'token_123',
        deviceId: 'device_123',
        provider: 'invalid_provider',
      };

      // Act
      const response = await request(app)
        .post(`/settings/${userId}/push-token`)
        .set('Authorization', `Bearer ${userToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });
});

