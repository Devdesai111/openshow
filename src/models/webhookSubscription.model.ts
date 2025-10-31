// src/models/webhookSubscription.model.ts
import { Schema, model, Types } from 'mongoose';
import crypto from 'crypto';

export interface IWebhookSubscription {
  _id?: Types.ObjectId;
  subscriptionId: string;
  event: string; // The internal event name to subscribe to (e.g., 'project.milestone.approved')
  url: string; // Partner's endpoint URL
  secretHash: string; // Hashed version of the partner's shared secret (for verification)
  status: 'active' | 'inactive' | 'failed';
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
  lastAttemptedAt?: Date; // For monitoring/retries
}

const WebhookSubscriptionSchema = new Schema<IWebhookSubscription>(
  {
    subscriptionId: {
      type: String,
      required: true,
      unique: true,
      default: () => `whsub_${crypto.randomBytes(6).toString('hex')}`,
      index: true,
    },
    event: { type: String, required: true, index: true },
    url: { type: String, required: true, maxlength: 500 },
    secretHash: { type: String, required: true }, // SECURITY: Hashed secret
    status: {
      type: String,
      enum: ['active', 'inactive', 'failed'],
      default: 'active',
      index: true,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    lastAttemptedAt: { type: Date },
  },
  { timestamps: true }
);

// Compound index for efficient queries
WebhookSubscriptionSchema.index({ event: 1, status: 1 });

export const WebhookSubscriptionModel = model<IWebhookSubscription>(
  'WebhookSubscription',
  WebhookSubscriptionSchema
);

