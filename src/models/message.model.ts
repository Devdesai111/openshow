import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

export interface IMessage {
  _id?: Types.ObjectId;
  messageId: string; // Unique, short ID for public reference
  projectId: Types.ObjectId;
  senderId: Types.ObjectId;
  body: string; // Max 5000 chars for chat body
  attachments?: Types.ObjectId[]; // Asset IDs (Task 19)
  replyToMessageId?: Types.ObjectId | null;
  mentionedUserIds?: Types.ObjectId[];
  reactions?: Array<{ emoji: string; userIds: Types.ObjectId[] }>;
  editedAt?: Date | null;
  deleted: boolean; // Soft delete flag
  createdAt?: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    messageId: {
      type: String,
      required: true,
      unique: true,
      default: () => `msg_${crypto.randomBytes(8).toString('hex')}`,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    body: {
      type: String,
      required: true,
      maxlength: 5000,
    },
    attachments: [{ type: Schema.Types.ObjectId, ref: 'Asset' }],
    replyToMessageId: {
      type: Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    mentionedUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    reactions: {
      type: Schema.Types.Mixed,
      default: [],
    }, // Simplified for chat reactions
    editedAt: {
      type: Date,
      default: null,
    },
    deleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: false }, // Only track createdAt automatically
  }
);

// PERFORMANCE: Primary index for chat history retrieval (cursor-based)
MessageSchema.index({ projectId: 1, createdAt: -1 });
// Index for soft-deleted message filtering
MessageSchema.index({ projectId: 1, deleted: 1, createdAt: -1 });

export const MessageModel = model<IMessage>('Message', MessageSchema);
