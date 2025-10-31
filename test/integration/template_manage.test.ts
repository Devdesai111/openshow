import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { NotificationTemplateModel } from '../../src/models/notificationTemplate.model';

describe('Notification Template Management Integration Tests', () => {
  let adminToken: string;
  let creatorToken: string;
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
    await NotificationTemplateModel.deleteMany({});

    // Create admin user
    await request(app).post('/auth/signup').send({
      email: 'admin@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Admin User',
    });
    await UserModel.updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@example.com',
      password: 'Password123',
    });
    adminToken = adminLogin.body.accessToken;

    // Create creator user
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Creator User',
    });
    creatorToken = creatorSignup.body.accessToken;

    templateId = 'test.welcome.v1';
  });

  describe('POST /notifications/templates', () => {
    it('T46.1 - should successfully create a template (201 Created)', async () => {
      // Arrange
      const payload = {
        templateId: templateId,
        name: 'Welcome Email Template',
        description: 'Welcome email for new users',
        channels: ['email', 'in_app'],
        contentTemplate: {
          email: {
            subject: 'Welcome, {{userName}}!',
            html: '<h1>Welcome {{userName}}!</h1><p>Thank you for joining.</p>',
          },
          in_app: {
            title: 'Welcome',
            body: 'Welcome {{userName}}! Thank you for joining.',
          },
        },
        requiredVariables: ['userName'],
        defaultLocale: 'en',
      };

      // Act
      const response = await request(app)
        .post('/notifications/templates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('templateId', templateId);
      expect(response.body).toHaveProperty('version', 1);
      expect(response.body).toHaveProperty('createdAt');

      // Verify template was saved
      const template = await NotificationTemplateModel.findOne({ templateId }).lean();
      expect(template).toBeDefined();
      expect(template!.name).toBe('Welcome Email Template');
      expect(template!.version).toBe(1);
      expect(template!.active).toBe(true);
    });

    it('should return 409 for duplicate templateId', async () => {
      // Arrange - Create template first
      await NotificationTemplateModel.create({
        templateId: templateId,
        name: 'Existing Template',
        channels: ['email'],
        contentTemplate: { email: { subject: 'Test', html: 'Test' } },
        requiredVariables: [],
      });

      // Act - Try to create duplicate
      const payload = {
        templateId: templateId,
        name: 'Duplicate Template',
        channels: ['email'],
        contentTemplate: { email: { subject: 'Test', html: 'Test' } },
        requiredVariables: [],
      };

      const response = await request(app)
        .post('/notifications/templates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already exists');
    });

    it('should return 403 for non-admin user', async () => {
      // Arrange
      const payload = {
        templateId: templateId,
        name: 'Test Template',
        channels: ['email'],
        contentTemplate: { email: { subject: 'Test', html: 'Test' } },
        requiredVariables: [],
      };

      // Act
      const response = await request(app)
        .post('/notifications/templates')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should return 422 for missing required fields', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/templates')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          // Missing templateId, name, channels, etc.
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).post('/notifications/templates').send({
        templateId: templateId,
        name: 'Test',
        channels: ['email'],
        contentTemplate: {},
        requiredVariables: [],
      });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /notifications/templates/preview', () => {
    beforeEach(async () => {
      // Create a template for preview tests
      await NotificationTemplateModel.create({
        templateId: templateId,
        name: 'Preview Test Template',
        channels: ['email', 'in_app'],
        contentTemplate: {
          email: {
            subject: 'Welcome, {{userName}}!',
            html: '<h1>Welcome {{userName}}!</h1><p>You joined on {{joinDate}}.</p>',
          },
          in_app: {
            title: 'Welcome',
            body: 'Welcome {{userName}}! Thank you for joining on {{joinDate}}.',
          },
        },
        requiredVariables: ['userName', 'joinDate'],
        active: true,
      });
    });

    it('T46.2 - should successfully preview rendered template (200 OK)', async () => {
      // Arrange
      const payload = {
        templateId: templateId,
        variables: {
          userName: 'John Doe',
          joinDate: '2025-01-15',
        },
      };

      // Act
      const response = await request(app)
        .post('/notifications/templates/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('email');
      expect(response.body).toHaveProperty('in_app');

      expect(response.body.email.subject).toBe('Welcome, John Doe!');
      expect(response.body.email.html).toContain('Welcome John Doe!');
      expect(response.body.email.html).toContain('2025-01-15');

      expect(response.body.in_app.title).toBe('Welcome');
      expect(response.body.in_app.body).toContain('Welcome John Doe!');
      expect(response.body.in_app.body).toContain('2025-01-15');
    });

    it('T46.3 - should return 422 for missing required variable', async () => {
      // Arrange - Missing joinDate
      const payload = {
        templateId: templateId,
        variables: {
          userName: 'John Doe',
          // Missing joinDate
        },
      };

      // Act
      const response = await request(app)
        .post('/notifications/templates/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('VariableMissing');
    });

    it('should return 404 for inactive template', async () => {
      // Arrange - Deactivate template
      await NotificationTemplateModel.updateOne({ templateId }, { $set: { active: false } });

      // Act
      const response = await request(app)
        .post('/notifications/templates/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          templateId: templateId,
          variables: { userName: 'Test', joinDate: '2025-01-01' },
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should return 404 for non-existent template', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/templates/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          templateId: 'nonexistent.template',
          variables: { userName: 'Test' },
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should return 403 for non-admin user', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/templates/preview')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          templateId: templateId,
          variables: { userName: 'Test', joinDate: '2025-01-01' },
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should return 422 for missing templateId', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/templates/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          variables: { userName: 'Test' },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for missing variables', async () => {
      // Act
      const response = await request(app)
        .post('/notifications/templates/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          templateId: templateId,
          // Missing variables
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });

  describe('DELETE /notifications/templates/:templateId', () => {
    beforeEach(async () => {
      // Create a template for delete tests
      await NotificationTemplateModel.create({
        templateId: templateId,
        name: 'Delete Test Template',
        channels: ['email'],
        contentTemplate: { email: { subject: 'Test', html: 'Test' } },
        requiredVariables: [],
        active: true,
      });
    });

    it('should successfully delete template (204 No Content)', async () => {
      // Act
      const response = await request(app)
        .delete(`/notifications/templates/${templateId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(204);

      // Verify template was deactivated
      const template = await NotificationTemplateModel.findOne({ templateId }).lean();
      expect(template).toBeDefined();
      expect(template!.active).toBe(false);
    });

    it('T46.4 - should return 403 for non-admin user', async () => {
      // Act
      const response = await request(app)
        .delete(`/notifications/templates/${templateId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should return 404 for non-existent template', async () => {
      // Act
      const response = await request(app)
        .delete('/notifications/templates/nonexistent.template')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).delete(`/notifications/templates/${templateId}`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });
});

