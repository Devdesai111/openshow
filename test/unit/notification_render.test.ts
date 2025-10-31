import { NotificationService } from '../../src/services/notification.service';
import { NotificationTemplateModel } from '../../src/models/notificationTemplate.model';
import { NotificationModel } from '../../src/models/notification.model';
import mongoose from 'mongoose';

describe('NotificationService - Template Rendering', () => {
  let notificationService: NotificationService;

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
    notificationService = new NotificationService();
    await NotificationTemplateModel.deleteMany({});
    await NotificationModel.deleteMany({});
  });

  describe('sendTemplateNotification', () => {
    it('should render template with variables and create notification record', async () => {
      // Arrange - Create a test template
      await NotificationTemplateModel.create({
        templateId: 'test.welcome.v1',
        name: 'Welcome Template',
        channels: ['in_app', 'email'],
        contentTemplate: {
          in_app: {
            title: 'Welcome {{userName}}!',
            body: 'Welcome to {{platformName}}, {{userName}}. Get started today!',
          },
          email: {
            subject: 'Welcome to {{platformName}}',
            html: '<h1>Hello {{userName}}</h1><p>Welcome to {{platformName}}!</p>',
            text: 'Hello {{userName}}, welcome to {{platformName}}!',
          },
        },
        requiredVariables: ['userName', 'platformName'],
        active: true,
      });

      // Act
      const result = await notificationService.sendTemplateNotification({
        templateId: 'test.welcome.v1',
        recipients: [{ userId: '507f1f77bcf86cd799439011', email: 'test@example.com' }],
        variables: {
          userName: 'John Doe',
          platformName: 'OpenShow',
        },
      });

      // Assert
      expect(result).toHaveProperty('notificationId');
      expect(result.status).toBe('queued');
      expect(result.type).toBe('test.welcome.v1');
      expect(result.content.in_app?.title).toBe('Welcome John Doe!');
      expect(result.content.in_app?.body).toBe('Welcome to OpenShow, John Doe. Get started today!');
      expect(result.content.email?.subject).toBe('Welcome to OpenShow');
      expect(result.content.email?.html).toBe('<h1>Hello John Doe</h1><p>Welcome to OpenShow!</p>');
      expect(result.content.email?.text).toBe('Hello John Doe, welcome to OpenShow!');

      // Verify database persistence
      const savedNotification = await NotificationModel.findOne({ notificationId: result.notificationId });
      expect(savedNotification).toBeTruthy();
      expect(savedNotification?.status).toBe('queued');
    });

    it('should throw TemplateNotFound error when template does not exist', async () => {
      // Act & Assert
      await expect(
        notificationService.sendTemplateNotification({
          templateId: 'nonexistent.template.v1',
          recipients: [{ userId: '507f1f77bcf86cd799439011' }],
          variables: { test: 'value' },
        })
      ).rejects.toThrow('TemplateNotFound');
    });

    it('should throw VariableMissing error when required variable is missing', async () => {
      // Arrange
      await NotificationTemplateModel.create({
        templateId: 'test.missing.v1',
        name: 'Missing Variables Template',
        channels: ['in_app'],
        contentTemplate: {
          in_app: {
            title: 'Hello {{userName}}!',
            body: 'Your project {{projectName}} is ready.',
          },
        },
        requiredVariables: ['userName', 'projectName'],
        active: true,
      });

      // Act & Assert - Missing projectName
      await expect(
        notificationService.sendTemplateNotification({
          templateId: 'test.missing.v1',
          recipients: [{ userId: '507f1f77bcf86cd799439011' }],
          variables: { userName: 'John' }, // Missing projectName
        })
      ).rejects.toThrow('VariableMissing: projectName');
    });

    it('should handle XSS-safe template rendering', async () => {
      // Arrange
      await NotificationTemplateModel.create({
        templateId: 'test.xss.v1',
        name: 'XSS Test Template',
        channels: ['email'],
        contentTemplate: {
          email: {
            subject: 'Alert: {{alertMessage}}',
            html: '<p>Message: {{alertMessage}}</p>',
          },
        },
        requiredVariables: ['alertMessage'],
        active: true,
      });

      // Act - Try to inject script
      const result = await notificationService.sendTemplateNotification({
        templateId: 'test.xss.v1',
        recipients: [{ userId: '507f1f77bcf86cd799439011' }],
        variables: {
          alertMessage: '<script>alert("xss")</script>Safe message',
        },
      });

      // Assert - Handlebars escapes HTML by default
      expect(result.content.email?.html).toBe('<p>Message: &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;Safe message</p>');
      expect(result.content.email?.subject).toBe('Alert: &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;Safe message');
    });

    it('should support channel overrides', async () => {
      // Arrange
      await NotificationTemplateModel.create({
        templateId: 'test.channels.v1',
        name: 'Multi-Channel Template',
        channels: ['in_app', 'email', 'push'],
        contentTemplate: {
          in_app: { title: 'In-App {{message}}', body: 'Body {{message}}' },
          email: { subject: 'Email {{message}}', html: '<p>{{message}}</p>' },
          push: { title: 'Push {{message}}', body: 'Push body {{message}}' },
        },
        requiredVariables: ['message'],
        active: true,
      });

      // Act - Override channels to only use email
      const result = await notificationService.sendTemplateNotification({
        templateId: 'test.channels.v1',
        recipients: [{ userId: '507f1f77bcf86cd799439011' }],
        variables: { message: 'test' },
        channels: ['email'], // Override default channels
      });

      // Assert
      expect(result.channels).toEqual(['email']);
      expect(result.content.email?.subject).toBe('Email test');
      // Content is still rendered for all template channels, but only email will be dispatched
      expect(result.content.in_app?.title).toBe('In-App test');
    });

    it('should handle scheduled notifications', async () => {
      // Arrange
      await NotificationTemplateModel.create({
        templateId: 'test.scheduled.v1',
        name: 'Scheduled Template',
        channels: ['in_app'],
        contentTemplate: {
          in_app: { title: 'Scheduled {{message}}', body: 'Body' },
        },
        requiredVariables: ['message'],
        active: true,
      });

      const scheduledTime = new Date(Date.now() + 3600000); // 1 hour from now

      // Act
      const result = await notificationService.sendTemplateNotification({
        templateId: 'test.scheduled.v1',
        recipients: [{ userId: '507f1f77bcf86cd799439011' }],
        variables: { message: 'future' },
        scheduledAt: scheduledTime,
      });

      // Assert
      expect(result.status).toBe('queued');
      expect(result.scheduledAt).toEqual(scheduledTime);
    });
  });
});
