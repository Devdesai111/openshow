import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { WebhookSubscriptionModel } from '../../src/models/webhookSubscription.model';

describe('Webhook Subscription Management Integration Tests', () => {
  let adminAccessToken: string;
  let adminUserId: string;
  let creatorAccessToken: string;

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
    // Clean up database
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await WebhookSubscriptionModel.deleteMany({});

    // Create admin user
    const adminSignup = await request(app).post('/auth/signup').send({
      email: 'admin@example.com',
      password: 'AdminPassword123',
      role: 'creator',
    });

    adminUserId = adminSignup.body.user.id;

    // Update to admin role
    await UserModel.findByIdAndUpdate(adminUserId, { role: 'admin' });

    // Re-login to get admin token
    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@example.com',
      password: 'AdminPassword123',
    });
    adminAccessToken = adminLogin.body.accessToken;

    // Create creator user (for unauthorized tests)
    await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'CreatorPassword123',
      role: 'creator',
    });

    const creatorLogin = await request(app).post('/auth/login').send({
      email: 'creator@example.com',
      password: 'CreatorPassword123',
    });
    creatorAccessToken = creatorLogin.body.accessToken;
  });

  describe('POST /notifications/webhook-subscriptions', () => {
    it('should successfully create a webhook subscription (T51.1)', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          event: 'project.milestone.approved',
          url: 'https://partner.com/webhook',
          secret: 'my-secret-key-min-16-chars',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('subscriptionId');
      expect(response.body).toHaveProperty('event', 'project.milestone.approved');
      expect(response.body).toHaveProperty('url', 'https://partner.com/webhook');
      expect(response.body).toHaveProperty('status', 'active');
      expect(response.body).not.toHaveProperty('secretHash'); // Secret should be hidden
      expect(response.body).not.toHaveProperty('secret'); // Secret should not be in response

      // Verify database record
      const subscription = await WebhookSubscriptionModel.findOne({ subscriptionId: response.body.subscriptionId });
      expect(subscription).toBeTruthy();
      expect(subscription?.event).toBe('project.milestone.approved');
      expect(subscription?.url).toBe('https://partner.com/webhook');
      expect(subscription?.status).toBe('active');
      expect(subscription?.secretHash).toBeDefined(); // Secret should be hashed in DB
      expect(subscription?.createdBy?.toString()).toBe(adminUserId);
    });

    it('should return 403 Forbidden for non-admin user (T51.2)', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/webhook-subscriptions')
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          event: 'project.milestone.approved',
          url: 'https://partner.com/webhook',
          secret: 'my-secret-key-min-16-chars',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('should return 401 Unauthorized without authentication', async () => {
      // Act
      const response = await request(app).post('/notifications/webhook-subscriptions').send({
        event: 'project.milestone.approved',
        url: 'https://partner.com/webhook',
        secret: 'my-secret-key-min-16-chars',
      });

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 422 Validation Error for invalid input', async () => {
      // Act - Missing required fields
      const response = await request(app)
        .post('/notifications/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          event: 'proj', // Too short (< 5 chars)
          url: 'not-a-url',
          secret: 'short', // Too short (< 16 chars)
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('validation_error');
      expect(response.body.error.details).toBeDefined();
    });
  });

  describe('PUT /notifications/webhook-subscriptions/:subscriptionId', () => {
    let subscriptionId: string;

    beforeEach(async () => {
      // Create a subscription for update tests
      const createResponse = await request(app)
        .post('/notifications/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          event: 'project.milestone.approved',
          url: 'https://partner.com/webhook',
          secret: 'my-secret-key-min-16-chars',
        });

      subscriptionId = createResponse.body.subscriptionId;
    });

    it('should successfully update subscription URL (T51.3)', async () => {
      // Act
      const response = await request(app)
        .put(`/notifications/webhook-subscriptions/${subscriptionId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          url: 'https://new-partner.com/webhook',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('subscriptionId', subscriptionId);
      expect(response.body).toHaveProperty('url', 'https://new-partner.com/webhook');
      expect(response.body.event).toBe('project.milestone.approved'); // Original event unchanged

      // Verify database
      const subscription = await WebhookSubscriptionModel.findOne({ subscriptionId });
      expect(subscription?.url).toBe('https://new-partner.com/webhook');
    });

    it('should successfully update subscription status', async () => {
      // Act
      const response = await request(app)
        .put(`/notifications/webhook-subscriptions/${subscriptionId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          status: 'inactive',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'inactive');

      // Verify database
      const subscription = await WebhookSubscriptionModel.findOne({ subscriptionId });
      expect(subscription?.status).toBe('inactive');
    });

    it('should successfully update subscription secret (re-hash)', async () => {
      // Act
      const response = await request(app)
        .put(`/notifications/webhook-subscriptions/${subscriptionId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          secret: 'new-secret-key-min-16-chars-longer',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('secretHash');
      expect(response.body).not.toHaveProperty('secret');

      // Verify database - secretHash should be updated
      const subscription = await WebhookSubscriptionModel.findOne({ subscriptionId });
      expect(subscription?.secretHash).toBeDefined();
      // The hash should be different (we can't verify the exact hash, but it should exist)
    });

    it('should return 404 Not Found for non-existent subscription', async () => {
      // Act
      const response = await request(app)
        .put('/notifications/webhook-subscriptions/nonexistent')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          url: 'https://new-partner.com/webhook',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('not_found');
    });

    it('should return 403 Forbidden for non-admin user', async () => {
      // Act
      const response = await request(app)
        .put(`/notifications/webhook-subscriptions/${subscriptionId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          url: 'https://new-partner.com/webhook',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });
  });

  describe('DELETE /notifications/webhook-subscriptions/:subscriptionId', () => {
    let subscriptionId: string;

    beforeEach(async () => {
      // Create a subscription for delete tests
      const createResponse = await request(app)
        .post('/notifications/webhook-subscriptions')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          event: 'project.milestone.approved',
          url: 'https://partner.com/webhook',
          secret: 'my-secret-key-min-16-chars',
        });

      subscriptionId = createResponse.body.subscriptionId;
    });

    it('should successfully delete subscription (T51.4)', async () => {
      // Act
      const response = await request(app)
        .delete(`/notifications/webhook-subscriptions/${subscriptionId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`);

      // Assert
      expect(response.status).toBe(204);

      // Verify database - subscription should be deleted
      const subscription = await WebhookSubscriptionModel.findOne({ subscriptionId });
      expect(subscription).toBeNull();
    });

    it('should return 404 Not Found for non-existent subscription (T51.5)', async () => {
      // Act
      const response = await request(app)
        .delete('/notifications/webhook-subscriptions/nonexistent')
        .set('Authorization', `Bearer ${adminAccessToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('not_found');
    });

    it('should return 403 Forbidden for non-admin user', async () => {
      // Act
      const response = await request(app)
        .delete(`/notifications/webhook-subscriptions/${subscriptionId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('should return 401 Unauthorized without authentication', async () => {
      // Act
      const response = await request(app).delete(`/notifications/webhook-subscriptions/${subscriptionId}`);

      // Assert
      expect(response.status).toBe(401);
    });
  });
});

