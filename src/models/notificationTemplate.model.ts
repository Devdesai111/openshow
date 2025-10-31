import { Schema, model, Types } from 'mongoose';

// Defines the structure of content parts required for a template's channels
export interface IChannelParts {
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface INotificationTemplate {
  _id?: Types.ObjectId;
  templateId: string; // Machine-readable key (e.g., 'project.invite.v1')
  name: string;
  description?: string;
  channels: ('in_app' | 'email' | 'push' | 'webhook')[]; // Channels this template supports
  contentTemplate: {
    in_app?: IChannelParts;
    email?: { subject: string; html: string; text?: string };
    push?: IChannelParts;
    webhook?: { payloadTemplate: Record<string, unknown> };
  };
  requiredVariables: string[]; // Variables needed for rendering (e.g., ['inviter', 'projectTitle'])
  defaultLocale: string;
  version: number;
  active: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const TemplateSchema = new Schema<INotificationTemplate>(
  {
    templateId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    description: { type: String },
    channels: {
      type: [String],
      enum: ['in_app', 'email', 'push', 'webhook'],
      required: true,
    },
    contentTemplate: {
      // Schema.Types.Mixed allows for flexible content structures per channel
      type: Schema.Types.Mixed,
      required: true,
    },
    requiredVariables: { type: [String], default: [] },
    defaultLocale: { type: String, default: 'en' },
    version: { type: Number, default: 1 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

export const NotificationTemplateModel = model<INotificationTemplate>('NotificationTemplate', TemplateSchema);
