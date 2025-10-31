import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { NotificationModel } from '../../src/models/notification.model';
import { NotificationTemplateModel } from '../../src/models/notificationTemplate.model';
import { UserInboxModel } from '../../src/models/userNotification.model';

describe('Notification Inbox Integration Tests', () => {
  let userToken: string;
  let userId: string;
  let templateId: string;

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
    await UserInboxModel.deleteMany({});

    // Create user
    const signup = await request(app).post('/auth/signup').send({
      email: 'user@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Test User',
    });
    userToken = signup.body.accessToken;
    const user = await UserModel.findOne({ email: 'user@example.com' });
    userId = user!._id.toString();

    templateId = 'test.invite.v1';

    // Create a template
    await NotificationTemplateModel.create({
      templateId: templateId,
      name: 'Project Invite Template',
      channels: ['in_app', 'email'],
      contentTemplate: {
        in_app: {
          title: 'New Invite',
          body: 'You have been invited to {{projectTitle}}',
        },
        email: {
          subject: 'Invitation to {{projectTitle}}',
          html: '<h1>You have been invited to {{projectTitle}}</h1>',
        },
      },
      requiredVariables: ['projectTitle'],
      active: true,
    });
  });

  describe('GET /notifications', () => {
    beforeEach(async () => {
      // Create notifications for the user
      const notification1 = await NotificationModel.create({
        notificationId: 'notif_1',
        type: 'project.invite',
        templateId: templateId,
        recipients: [{ userId: new mongoose.Types.ObjectId(userId) }],
        content: {
          in_app: {
            title: 'New Invite',
            body: 'You have been invited to Project A',
          },
        },
        channels: ['in_app'],
        status: 'sent',
      });

      const notification2 = await NotificationModel.create({
        notificationId: 'notif_2',
        type: 'project.update',
        recipients: [{ userId: new mongoose.Types.ObjectId(userId) }],
        content: {
          in_app: {
            title: 'Project Update',
            body: 'Your project has been updated',
          },
        },
        channels: ['in_app'],
        status: 'sent',
      });

      // Create inbox entries
      await UserInboxModel.create({
        userId: new mongoose.Types.ObjectId(userId),
        notificationId: notification1._id,
        read: false,
        deleted: false,
      });

      await UserInboxModel.create({
        userId: new mongoose.Types.ObjectId(userId),
        notificationId: notification2._id,
        read: true,
        readAt: new Date(),
        deleted: false,
      });
    });

    it('T47.1 - should list user notifications (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/notifications')
        .set('Authorization', `Bearer ${userToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('meta');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);

      // Verify first notification is unread by default
      const firstNotification = response.body.data[0];
      expect(firstNotification).toHaveProperty('id');
      expect(firstNotification).toHaveProperty('notificationId');
      expect(firstNotification).toHaveProperty('read');
      expect(firstNotification).toHaveProperty('type');
      expect(firstNotification).toHaveProperty('title');
      expect(firstNotification).toHaveProperty('createdAt');

      // Should have at least one unread notification
      const unreadNotifications = response.body.data.filter((n: any) => n.read === false);
      expect(unreadNotifications.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter notifications by status=unread', async () => {
      // Act
      const response = await request(app)
        .get('/notifications')
        .query({ status: 'unread' })
        .set('Authorization', `Bearer ${userToken}`);

      // Assert
      expect(response.status).toBe(200);
      response.body.data.forEach((notification: any) => {
        expect(notification.read).toBe(false);
      });
    });

    it('should filter notifications by status=read', async () => {
      // Act
      const response = await request(app)
        .get('/notifications')
        .query({ status: 'read' })
        .set('Authorization', `Bearer ${userToken}`);

      // Assert
      expect(response.status).toBe(200);
      response.body.data.forEach((notification: any) => {
        expect(notification.read).toBe(true);
      });
    });

    it('should support pagination', async () => {
      // Act
      const response = await request(app)
        .get('/notifications')
        .query({ page: 1, per_page: 1 })
        .set('Authorization', `Bearer ${userToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeLessThanOrEqual(1);
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.per_page).toBe(1);
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).get('/notifications');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /notifications/mark-read', () => {
    let inboxId1: string;
    let inboxId2: string;

    beforeEach(async () => {
      // Create notifications
      const notification1 = await NotificationModel.create({
        notificationId: 'notif_1',
        type: 'project.invite',
        recipients: [{ userId: new mongoose.Types.ObjectId(userId) }],
        content: {
          in_app: {
            title: 'New Invite',
            body: 'You have been invited',
          },
        },
        channels: ['in_app'],
        status: 'sent',
      });

      const notification2 = await NotificationModel.create({
        notificationId: 'notif_2',
        type: 'project.update',
        recipients: [{ userId: new mongoose.Types.ObjectId(userId) }],
        content: {
          in_app: {
            title: 'Project Update',
            body: 'Your project has been updated',
          },
        },
        channels: ['in_app'],
        status: 'sent',
      });

      // Create inbox entries
      const inbox1 = await UserInboxModel.create({
        userId: new mongoose.Types.ObjectId(userId),
        notificationId: notification1._id,
        read: false,
        deleted: false,
      });

      const inbox2 = await UserInboxModel.create({
        userId: new mongoose.Types.ObjectId(userId),
        notificationId: notification2._id,
        read: false,
        deleted: false,
      });

      inboxId1 = inbox1._id.toString();
      inboxId2 = inbox2._id.toString();
    });

    it('T47.3 - should mark specific notifications as read (200 OK)', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/mark-read')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          ids: [inboxId1],
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('message', 'Notifications updated.');

      // Verify only id1 is marked as read
      const inbox1 = await UserInboxModel.findById(inboxId1).lean();
      const inbox2 = await UserInboxModel.findById(inboxId2).lean();

      expect(inbox1!.read).toBe(true);
      expect(inbox1!.readAt).toBeDefined();
      expect(inbox2!.read).toBe(false);
      expect(inbox2!.readAt).toBeUndefined();
    });

    it('T47.4 - should mark all notifications as read (200 OK)', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/mark-read')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          markAll: true,
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');

      // Verify all notifications are marked as read
      const inbox1 = await UserInboxModel.findById(inboxId1).lean();
      const inbox2 = await UserInboxModel.findById(inboxId2).lean();

      expect(inbox1!.read).toBe(true);
      expect(inbox1!.readAt).toBeDefined();
      expect(inbox2!.read).toBe(true);
      expect(inbox2!.readAt).toBeDefined();
    });

    it('T47.5 - should return 422 for missing action', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/mark-read')
        .set('Authorization', `Bearer ${userToken}`)
        .send({});

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).post('/notifications/mark-read').send({
        ids: [inboxId1],
      });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('GET /notifications/unread-count', () => {
    beforeEach(async () => {
      // Create notifications
      const notification1 = await NotificationModel.create({
        notificationId: 'notif_1',
        type: 'project.invite',
        recipients: [{ userId: new mongoose.Types.ObjectId(userId) }],
        content: {
          in_app: {
            title: 'New Invite',
            body: 'You have been invited',
          },
        },
        channels: ['in_app'],
        status: 'sent',
      });

      const notification2 = await NotificationModel.create({
        notificationId: 'notif_2',
        type: 'project.update',
        recipients: [{ userId: new mongoose.Types.ObjectId(userId) }],
        content: {
          in_app: {
            title: 'Project Update',
            body: 'Your project has been updated',
          },
        },
        channels: ['in_app'],
        status: 'sent',
      });

      // Create inbox entries (both unread initially)
      await UserInboxModel.create({
        userId: new mongoose.Types.ObjectId(userId),
        notificationId: notification1._id,
        read: false,
        deleted: false,
      });

      await UserInboxModel.create({
        userId: new mongoose.Types.ObjectId(userId),
        notificationId: notification2._id,
        read: false,
        deleted: false,
      });
    });

    it('T47.2 - should return unread count (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/notifications/unread-count')
        .set('Authorization', `Bearer ${userToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('unreadCount');
      expect(typeof response.body.unreadCount).toBe('number');
      expect(response.body.unreadCount).toBe(2);
    });

    it('should decrease count after marking as read', async () => {
      // Get initial count
      const initialResponse = await request(app)
        .get('/notifications/unread-count')
        .set('Authorization', `Bearer ${userToken}`);

      expect(initialResponse.body.unreadCount).toBe(2);

      // Mark one as read
      await request(app)
        .post('/notifications/mark-read')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          markAll: true,
        });

      // Get updated count
      const updatedResponse = await request(app)
        .get('/notifications/unread-count')
        .set('Authorization', `Bearer ${userToken}`);

      // Assert
      expect(updatedResponse.status).toBe(200);
      expect(updatedResponse.body.unreadCount).toBe(0);
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).get('/notifications/unread-count');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('Integration: Notification Creation and Inbox', () => {
    it('should automatically create inbox entries when notification is sent with in_app channel', async () => {
      // Arrange - Create admin token for sending notification
      await UserModel.updateOne({ email: 'user@example.com' }, { $set: { role: 'admin' } });
      const adminLogin = await request(app).post('/auth/login').send({
        email: 'user@example.com',
        password: 'Password123',
      });
      const adminToken = adminLogin.body.accessToken;

      // Act - Send notification via template
      const sendResponse = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          templateId: templateId,
          recipients: [{ userId: userId }],
          variables: {
            projectTitle: 'Test Project',
          },
          channels: ['in_app'],
        });

      expect(sendResponse.status).toBe(202);

      // Wait a bit for async processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Assert - Verify inbox entry was created
      const inboxEntries = await UserInboxModel.find({
        userId: new mongoose.Types.ObjectId(userId),
        deleted: false,
      }).lean();

      expect(inboxEntries.length).toBeGreaterThan(0);
      expect(inboxEntries[0]).toBeDefined();
      expect(inboxEntries[0]!.read).toBe(false);

      // Verify user can see it in their inbox
      const listResponse = await request(app)
        .get('/notifications')
        .set('Authorization', `Bearer ${userToken}`);

      expect(listResponse.status).toBe(200);
      expect(listResponse.body.data.length).toBeGreaterThan(0);
    });
  });
});

