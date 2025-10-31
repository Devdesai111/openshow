import { Schema, model, Types } from 'mongoose';

// Defines a single recipient for a notification
interface IRecipient {
  userId?: Types.ObjectId;
  email?: string; // Fallback or external email
  pushToken?: string;
  channelOverrides?: ('in_app' | 'email' | 'push' | 'webhook')[];
}

// Defines the final rendered content snapshot
interface IRenderedContent {
  in_app?: { title: string; body: string; metadata?: Record<string, unknown> };
  email?: { subject: string; html: string; text?: string };
  push?: { title: string; body: string; metadata?: Record<string, unknown> };
  webhook?: { payloadTemplate: Record<string, unknown> };
}

export interface INotification {
  _id?: Types.ObjectId;
  notificationId: string; // Unique, human-readable ID
  projectId?: Types.ObjectId;
  type: string; // E.g., 'project.invite', 'payment.succeeded'
  templateId?: string;
  recipients: IRecipient[];
  content: IRenderedContent; // Snapshot of the rendered content
  channels: ('in_app' | 'email' | 'push' | 'webhook')[]; // Final channels to attempt dispatch
  status: 'queued' | 'processing' | 'sent' | 'partial' | 'failed' | 'cancelled';
  scheduledAt?: Date;
  expiresAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    notificationId: { type: String, required: true, unique: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    type: { type: String, required: true, index: true },
    templateId: { type: String, index: true },
    recipients: [{ type: Schema.Types.Mixed, required: true }], // Mixed for flexibility in recipient data
    content: { type: Schema.Types.Mixed, required: true },
    channels: {
      type: [String],
      enum: ['in_app', 'email', 'push', 'webhook'],
      required: true,
    },
    status: {
      type: String,
      enum: ['queued', 'processing', 'sent', 'partial', 'failed', 'cancelled'],
      default: 'queued',
      index: true,
    },
    scheduledAt: { type: Date, index: true },
    expiresAt: { type: Date, index: true },
  },
  { timestamps: true }
);

export const NotificationModel = model<INotification>('Notification', NotificationSchema);
