// src/notificationAdapters/email.interface.ts

// DTO for sending email from the Notification Service
export interface IEmailSendDTO {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Internal reference to correlate webhook events
  providerRefId: string;
}

// DTO for the response after sending
export interface IEmailSendResponseDTO {
  providerMessageId: string; // ID used by provider to track delivery
  status: 'sent' | 'pending';
}

/**
 * The Standard Interface for all Email Service Provider (ESP) Adapters.
 */
export interface IEmailAdapter {
  providerName: string;

  /** Sends a templated or raw email. */
  sendEmail(data: IEmailSendDTO): Promise<IEmailSendResponseDTO>;

  /** Verifies the webhook signature. */
  verifyWebhookSignature(payload: string, signature: string): boolean;
}

