import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';

describe('Email Webhook Integration Tests', () => {
  const EMAIL_WEBHOOK_SECRET = process.env.EMAIL_WEBHOOK_SECRET || 'dev_email_secret';

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

  describe('POST /notifications/webhooks/notifications/email', () => {
    it('T48.2 - should process delivered event with valid signature (200 OK)', async () => {
      // Arrange
      const payload = [
        {
          event: 'delivered',
          email: 'test@example.com',
          providerMessageId: 'sg_12345',
        },
      ];

      // Act
      const response = await request(app)
        .post('/notifications/webhooks/notifications/email')
        .set('X-Email-Signature', EMAIL_WEBHOOK_SECRET)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('OK');
    });

    it('T48.4 - should process bounce event with valid signature (200 OK)', async () => {
      // Arrange
      const payload = [
        {
          event: 'bounce',
          email: 'bounce@example.com',
          providerMessageId: 'sg_67890',
        },
      ];

      // Act
      const response = await request(app)
        .post('/notifications/webhooks/notifications/email')
        .set('X-Email-Signature', EMAIL_WEBHOOK_SECRET)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('OK');
    });

    it('T48.3 - should return 401 for invalid signature', async () => {
      // Arrange
      const payload = [
        {
          event: 'delivered',
          email: 'test@example.com',
          providerMessageId: 'sg_12345',
        },
      ];

      // Act
      const response = await request(app)
        .post('/notifications/webhooks/notifications/email')
        .set('X-Email-Signature', 'invalid_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'signature_invalid');
      expect(response.body.error).toHaveProperty('message', 'Webhook signature validation failed.');
    });

    it('should return 401 for missing signature header', async () => {
      // Arrange
      const payload = [
        {
          event: 'delivered',
          email: 'test@example.com',
          providerMessageId: 'sg_12345',
        },
      ];

      // Act
      const response = await request(app)
        .post('/notifications/webhooks/notifications/email')
        .send(payload);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'signature_invalid');
    });

    it('should accept X-SendGrid-Signature header', async () => {
      // Arrange
      const payload = [
        {
          event: 'delivered',
          email: 'test@example.com',
          providerMessageId: 'sg_12345',
        },
      ];

      // Act
      const response = await request(app)
        .post('/notifications/webhooks/notifications/email')
        .set('X-SendGrid-Signature', EMAIL_WEBHOOK_SECRET)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('OK');
    });

    it('should handle multiple events in payload', async () => {
      // Arrange
      const payload = [
        {
          event: 'delivered',
          email: 'test1@example.com',
          providerMessageId: 'sg_111',
        },
        {
          event: 'bounce',
          email: 'bounce@example.com',
          providerMessageId: 'sg_222',
        },
        {
          event: 'opened',
          email: 'test2@example.com',
          providerMessageId: 'sg_333',
        },
      ];

      // Act
      const response = await request(app)
        .post('/notifications/webhooks/notifications/email')
        .set('X-Email-Signature', EMAIL_WEBHOOK_SECRET)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('OK');
    });

    it('should handle empty payload array', async () => {
      // Arrange
      const payload: any[] = [];

      // Act
      const response = await request(app)
        .post('/notifications/webhooks/notifications/email')
        .set('X-Email-Signature', EMAIL_WEBHOOK_SECRET)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('OK');
    });
  });
});

