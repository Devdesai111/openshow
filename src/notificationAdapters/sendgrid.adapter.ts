// src/notificationAdapters/sendgrid.adapter.ts
import crypto from 'crypto';
import { IEmailAdapter, IEmailSendDTO, IEmailSendResponseDTO } from './email.interface';

// Utility for webhook signature verification (mocked)
const EMAIL_WEBHOOK_SECRET = process.env.EMAIL_WEBHOOK_SECRET || 'dev_email_secret';

export class SendGridAdapter implements IEmailAdapter {
  public providerName = 'sendgrid';

  public async sendEmail(_data: IEmailSendDTO): Promise<IEmailSendResponseDTO> {
    // PRODUCTION: Call SendGrid API Client
    const messageId = `sg_${crypto.randomBytes(12).toString('hex')}`;

    return {
      providerMessageId: messageId,
      status: 'pending', // Delivery is async
    };
  }

  public verifyWebhookSignature(_payload: string, signature: string): boolean {
    // PRODUCTION: This requires complex logic (e.g., verifying timestamp, generating HMAC)
    // Mocked for Phase 1: Only pass if signature matches secret
    return signature === EMAIL_WEBHOOK_SECRET;
  }
}

