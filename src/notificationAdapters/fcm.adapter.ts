// src/notificationAdapters/fcm.adapter.ts
import crypto from 'crypto';
import { IPushAdapter, IPushNotificationDTO, IPushSendResponseDTO } from './push.interface';

export class FCMAdapter implements IPushAdapter {
  public providerName = 'fcm';

  public async sendPush(notifications: IPushNotificationDTO[]): Promise<IPushSendResponseDTO[]> {
    // PRODUCTION: Use Firebase Admin SDK for batch sending
    return notifications.map((_n, index) => ({
      providerMessageId: `fcm_msg_${crypto.randomBytes(6).toString('hex')}_${index}`,
      status: 'success' as const,
    }));
  }
}

