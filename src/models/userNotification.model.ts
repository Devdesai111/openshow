// src/models/userNotification.model.ts
import { Schema, model, Types } from 'mongoose';

// Dedicated model for a user's view of an existing notification
export interface IUserInbox {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  notificationId: Types.ObjectId; // Reference to the main Notification record
  read: boolean;
  readAt?: Date;
  deleted: boolean; // User-level soft delete/archive
  createdAt?: Date; // For sorting
}

const UserInboxSchema = new Schema<IUserInbox>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    notificationId: { type: Schema.Types.ObjectId, ref: 'Notification', required: true },
    read: { type: Boolean, default: false, index: true },
    deleted: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

// PERFORMANCE: Primary index for fast unread counts and sorting
UserInboxSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const UserInboxModel = model<IUserInbox>('UserInbox', UserInboxSchema);

