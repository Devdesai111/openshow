// src/notificationAdapters/push.interface.ts

// DTO for a single push notification payload
export interface IPushNotificationDTO {
  token: string; // Target device token (FCM or APNs)
  title: string;
  body: string;
  data?: Record<string, string>; // Custom data payload (deep link, etc.)
}

// DTO for the response after sending
export interface IPushSendResponseDTO {
  providerMessageId: string;
  status: 'success' | 'token_invalid' | 'failure';
}

/**
 * The Standard Interface for all Mobile Push Notification Adapters.
 */
export interface IPushAdapter {
  providerName: string;

  /** Sends a batch of notifications (or a single one). */
  sendPush(data: IPushNotificationDTO[]): Promise<IPushSendResponseDTO[]>;
}

