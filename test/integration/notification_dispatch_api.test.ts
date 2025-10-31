import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { NotificationModel } from '../../src/models/notification.model';
import { NotificationTemplateModel } from '../../src/models/notificationTemplate.model';
import { DispatchAttemptModel } from '../../src/models/dispatchAttempt.model';

describe('Notification Dispatch API Integration Tests', () => {
  let adminToken: string;
  let userToken: string;
  let userId: string;

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
    await NotificationModel.deleteMany({});
    await NotificationTemplateModel.deleteMany({});
    await DispatchAttemptModel.deleteMany({});

    // Create admin user
    await request(app).post('/auth/signup').send({
      email: 'admin@example.com',
      password: 'Password123',
      fullName: 'Admin User',
    });
    // Update user role to admin after creation
    await UserModel.updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
    // Login to get admin token
    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@example.com',
      password: 'Password123',
    });
    adminToken = adminLogin.body.accessToken;
    expect(adminToken).toBeDefined();

    // Create regular user
    const userSignup = await request(app).post('/auth/signup').send({
      email: 'user@example.com',
      password: 'Password123',
      fullName: 'Test User',
    });
    userToken = userSignup.body.accessToken;
    expect(userToken).toBeDefined();
    const user = await UserModel.findOne({ email: 'user@example.com' });
    expect(user).toBeDefined();
    userId = user!._id.toString();
  });

  describe('POST /notifications/:notificationId/dispatch', () => {
    it('T50.4 - should return 403 for unauthorized user (creator)', async () => {
      // Arrange - Create template
      await NotificationTemplateModel.create({
        templateId: 'test.dispatch',
        name: 'Test Dispatch Template',
        channels: ['email'],
        contentTemplate: {
          email: {
            subject: 'Test Subject',
            html: '<h1>Test</h1>',
          },
        },
        requiredVariables: [],
        active: true,
      });

      // Create notification
      const createResponse = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          templateId: 'test.dispatch',
          recipients: [{ userId: userId, email: 'user@example.com' }],
          variables: {},
          channels: ['email'],
        });

      expect(createResponse.status).toBe(202);

      // Get notification ID from database
      await new Promise(resolve => setTimeout(resolve, 50)); // Wait for DB save
      const notifications = await NotificationModel.find().sort({ createdAt: -1 }).limit(1).lean();
      expect(notifications.length).toBeGreaterThan(0);
      expect(notifications[0]).toBeDefined();
      const notificationId = notifications[0]!._id!.toString();

      // Act
      const response = await request(app)
        .post(`/notifications/${notificationId}/dispatch`)
        .set('Authorization', `Bearer ${userToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should successfully dispatch notification (admin)', async () => {
      // Arrange - Create user with push token
      await UserModel.updateOne(
        { _id: userId },
        {
          $push: {
            pushTokens: {
              token: 'fcm_test_token',
              deviceId: 'device_1',
              provider: 'fcm',
              lastUsed: new Date(),
            },
          },
        }
      );

      // Create template
      await NotificationTemplateModel.create({
        templateId: 'test.dispatch.full',
        name: 'Test Full Dispatch Template',
        channels: ['email', 'push', 'in_app'],
        contentTemplate: {
          email: {
            subject: 'Test Subject',
            html: '<h1>Test</h1>',
          },
          in_app: {
            title: 'Test Title',
            body: 'Test Body',
          },
        },
        requiredVariables: [],
        active: true,
      });

      // Create notification
      const createResponse = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          templateId: 'test.dispatch.full',
          recipients: [{ userId: userId, email: 'user@example.com' }],
          variables: {},
          channels: ['email', 'push', 'in_app'],
        });

      expect(createResponse.status).toBe(202);

      // Get notification ID from database
      await new Promise(resolve => setTimeout(resolve, 50)); // Wait for DB save
      const notifications = await NotificationModel.find().sort({ createdAt: -1 }).limit(1).lean();
      expect(notifications.length).toBeGreaterThan(0);
      expect(notifications[0]).toBeDefined();
      const notificationId = notifications[0]!._id!.toString();

      // Act
      const response = await request(app)
        .post(`/notifications/${notificationId}/dispatch`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
      expect(['sent', 'partial']).toContain(response.body.status);
      expect(response.body).toHaveProperty('notificationId');
      expect(response.body).toHaveProperty('message');

      // Verify dispatch attempts were created
      const attempts = await DispatchAttemptModel.find({
        notificationRef: new mongoose.Types.ObjectId(notificationId),
      }).lean();
      expect(attempts.length).toBeGreaterThan(0);
    });

    it('should return 404 for non-existent notification', async () => {
      // Arrange
      const fakeId = new mongoose.Types.ObjectId().toString();

      // Act
      const response = await request(app)
        .post(`/notifications/${fakeId}/dispatch`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should return 409 for non-queued notification', async () => {
      // Arrange - Create notification with 'sent' status
      const notification = await NotificationModel.create({
        notificationId: 'test_sent_notif',
        type: 'test.type',
        recipients: [{ userId: new mongoose.Types.ObjectId(userId) }],
        content: {
          in_app: {
            title: 'Test',
            body: 'Test',
          },
        },
        channels: ['in_app'],
        status: 'sent',
      });

      // Act
      const response = await request(app)
        .post(`/notifications/${notification._id.toString()}/dispatch`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('queued');
    });

    it('should require authentication', async () => {
      // Arrange
      const fakeId = new mongoose.Types.ObjectId().toString();

      // Act
      const response = await request(app).post(`/notifications/${fakeId}/dispatch`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });
});

