import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { NotificationTemplateModel } from '../../src/models/notificationTemplate.model';
import { NotificationModel } from '../../src/models/notification.model';

describe('Notification Queue Integration Tests', () => {
  let adminAccessToken: string;
  let adminUserId: string;

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
    await NotificationTemplateModel.deleteMany({});
    await NotificationModel.deleteMany({});

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

    // Create test template
    await NotificationTemplateModel.create({
      templateId: 'project.invite.v1',
      name: 'Project Invitation',
      channels: ['in_app', 'email'],
      contentTemplate: {
        in_app: {
          title: 'Project Invitation from {{inviterName}}',
          body: 'You have been invited to join {{projectTitle}}. Click to accept!',
        },
        email: {
          subject: 'Invitation to {{projectTitle}}',
          html: '<h2>Project Invitation</h2><p>{{inviterName}} invited you to {{projectTitle}}</p>',
          text: '{{inviterName}} invited you to {{projectTitle}}',
        },
      },
      requiredVariables: ['inviterName', 'projectTitle'],
      active: true,
    });
  });

  describe('POST /notifications/send', () => {
    it('should successfully send notification and return 202 Accepted (T11.1)', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          templateId: 'project.invite.v1',
          recipients: [
            { userId: '507f1f77bcf86cd799439011', email: 'recipient@example.com' }
          ],
          variables: {
            inviterName: 'John Doe',
            projectTitle: 'Amazing VFX Project'
          }
        });

      // Assert
      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty('notificationId');
      expect(response.body).toHaveProperty('status', 'queued');
      expect(response.body).toHaveProperty('message', 'Notification accepted and queued for rendering and dispatch.');

      // Verify database record
      const notification = await NotificationModel.findOne({ notificationId: response.body.notificationId });
      expect(notification).toBeTruthy();
      expect(notification?.status).toBe('queued');
      expect(notification?.content.in_app?.title).toBe('Project Invitation from John Doe');
      expect(notification?.content.email?.subject).toBe('Invitation to Amazing VFX Project');
    });

    it('should return 422 when required variable is missing (T11.2)', async () => {
      // Act - Missing projectTitle variable
      const response = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          templateId: 'project.invite.v1',
          recipients: [
            { userId: '507f1f77bcf86cd799439011' }
          ],
          variables: {
            inviterName: 'John Doe'
            // Missing projectTitle
          }
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('Missing required template variable: projectTitle');
    });

    it('should return 404 when template is not found (T11.3)', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          templateId: 'nonexistent.template.v1',
          recipients: [
            { userId: '507f1f77bcf86cd799439011' }
          ],
          variables: {
            test: 'value'
          }
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
      expect(response.body.error.message).toBe('The specified template ID was not found or is inactive.');
    });

    it('should validate request body and return 422 for invalid data (T11.4)', async () => {
      // Act - Invalid recipient userId
      const response = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          templateId: 'project.invite.v1',
          recipients: [
            { userId: 'invalid-id' } // Invalid MongoDB ObjectId
          ],
          variables: {
            inviterName: 'John',
            projectTitle: 'Test'
          }
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication (T11.5)', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/send')
        .send({
          templateId: 'project.invite.v1',
          recipients: [{ userId: '507f1f77bcf86cd799439011' }],
          variables: { inviterName: 'John', projectTitle: 'Test' }
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should require admin permissions (T11.6)', async () => {
      // Arrange - Create regular user
      const userSignup = await request(app).post('/auth/signup').send({
        email: 'user@example.com',
        password: 'Password123',
        role: 'creator',
      });

      // Act
      const response = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${userSignup.body.accessToken}`)
        .send({
          templateId: 'project.invite.v1',
          recipients: [{ userId: '507f1f77bcf86cd799439011' }],
          variables: { inviterName: 'John', projectTitle: 'Test' }
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should handle scheduled notifications (T11.7)', async () => {
      const scheduledTime = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

      // Act
      const response = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          templateId: 'project.invite.v1',
          recipients: [{ userId: '507f1f77bcf86cd799439011' }],
          variables: {
            inviterName: 'John Doe',
            projectTitle: 'Scheduled Project'
          },
          scheduledAt: scheduledTime
        });

      // Assert
      expect(response.status).toBe(202);

      // Verify scheduled time in database
      const notification = await NotificationModel.findOne({ notificationId: response.body.notificationId });
      expect(notification?.scheduledAt).toEqual(new Date(scheduledTime));
    });

    it('should support channel overrides (T11.8)', async () => {
      // Act - Override to only use in_app channel
      const response = await request(app)
        .post('/notifications/send')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          templateId: 'project.invite.v1',
          recipients: [{ userId: '507f1f77bcf86cd799439011' }],
          variables: {
            inviterName: 'John Doe',
            projectTitle: 'Channel Override Test'
          },
          channels: ['in_app'] // Override default channels
        });

      // Assert
      expect(response.status).toBe(202);

      // Verify channels in database
      const notification = await NotificationModel.findOne({ notificationId: response.body.notificationId });
      expect(notification?.channels).toEqual(['in_app']);
    });
  });

  describe('POST /notifications/templates', () => {
    it('should create template for testing (T11.9)', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/templates')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          templateId: 'test.new.v1',
          name: 'Test Template',
          channels: ['in_app'],
          contentTemplate: {
            in_app: {
              title: 'Test {{message}}',
              body: 'Body {{message}}'
            }
          },
          requiredVariables: ['message'],
          active: true
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('templateId', 'test.new.v1');

      // Verify template exists in database
      const template = await NotificationTemplateModel.findOne({ templateId: 'test.new.v1' });
      expect(template).toBeTruthy();
    });
  });
});
