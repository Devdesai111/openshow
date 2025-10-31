import { SendGridAdapter } from '../../src/notificationAdapters/sendgrid.adapter';
import { IEmailAdapter } from '../../src/notificationAdapters/email.interface';

describe('Email Adapter Unit Tests', () => {
  let adapter: IEmailAdapter;

  beforeAll(() => {
    adapter = new SendGridAdapter();
  });

  describe('SendGridAdapter', () => {
    it('should have correct provider name', () => {
      expect(adapter.providerName).toBe('sendgrid');
    });

    it('T48.1 - should send email and return providerMessageId', async () => {
      // Arrange
      const sendDto = {
        to: 'test@example.com',
        subject: 'Test Subject',
        html: '<h1>Test HTML</h1>',
        text: 'Test Text',
        providerRefId: 'notif_123',
      };

      // Act
      const result = await adapter.sendEmail(sendDto);

      // Assert
      expect(result).toHaveProperty('providerMessageId');
      expect(typeof result.providerMessageId).toBe('string');
      expect(result.providerMessageId).toMatch(/^sg_/);
      expect(result).toHaveProperty('status');
      expect(['sent', 'pending']).toContain(result.status);
    });

    it('should verify webhook signature correctly', () => {
      // Arrange
      const secret = process.env.EMAIL_WEBHOOK_SECRET || 'dev_email_secret';
      const payload = JSON.stringify({ event: 'delivered', email: 'test@example.com' });

      // Act - Valid signature
      const isValid = adapter.verifyWebhookSignature(payload, secret);

      // Assert
      expect(isValid).toBe(true);

      // Act - Invalid signature
      const isInvalid = adapter.verifyWebhookSignature(payload, 'wrong_secret');

      // Assert
      expect(isInvalid).toBe(false);
    });
  });
});

