// src/models/dispatchAttempt.model.ts
import { Schema, model, Types } from 'mongoose';
import { INotification } from './notification.model';

export interface IDispatchAttempt {
  _id?: Types.ObjectId;
  notificationRef: Types.ObjectId;
  recipientUserId?: Types.ObjectId;
  channel: INotification['channels'][number];
  provider: string; // e.g., 'sendgrid', 'fcm'
  providerReferenceId?: string;
  status: 'pending' | 'success' | 'failed' | 'permanent_failed';
  error?: { code?: string; message?: string };
  attemptNumber: number;
  nextRetryAt?: Date;
  createdAt?: Date;
}

const DispatchAttemptSchema = new Schema<IDispatchAttempt>(
  {
    notificationRef: { type: Schema.Types.ObjectId, ref: 'Notification', required: true, index: true },
    recipientUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    channel: { type: String, enum: ['in_app', 'email', 'push', 'webhook'], required: true },
    provider: { type: String, required: true },
    providerReferenceId: { type: String },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed', 'permanent_failed'],
      default: 'pending',
      index: true,
    },
    error: { type: Schema.Types.Mixed },
    attemptNumber: { type: Number, default: 1 },
    nextRetryAt: { type: Date, index: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

export const DispatchAttemptModel = model<IDispatchAttempt>('DispatchAttempt', DispatchAttemptSchema);

