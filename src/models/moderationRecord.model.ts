// src/models/moderationRecord.model.ts
import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

export interface IModerationAction {
  action: 'takedown' | 'suspend_user' | 'warn' | 'no_action' | 'escalate' | 'report_filed';
  by: Types.ObjectId; // Admin/Moderator ID
  notes?: string;
  createdAt: Date;
}

export interface IModerationRecord {
  _id?: Types.ObjectId;
  modId: string;
  resourceType: 'project' | 'asset' | 'user' | 'comment' | 'other';
  resourceId: Types.ObjectId; // The ID of the reported content/user
  reporterId?: Types.ObjectId; // The user who filed the report (optional if anonymous)
  severity: 'low' | 'medium' | 'high' | 'legal';
  status: 'open' | 'in_review' | 'actioned' | 'appealed' | 'closed';
  actions: IModerationAction[];
  evidenceAssetIds?: Types.ObjectId[];
  assignedTo?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const ModerationActionSchema = new Schema<IModerationAction>(
  {
    action: {
      type: String,
      enum: ['takedown', 'suspend_user', 'warn', 'no_action', 'escalate', 'report_filed'],
      required: true,
    },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    notes: { type: String, maxlength: 500 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ModerationRecordSchema = new Schema<IModerationRecord>(
  {
    modId: {
      type: String,
      required: true,
      unique: true,
      default: () => `mod_${crypto.randomBytes(6).toString('hex')}`,
      index: true,
    },
    resourceType: {
      type: String,
      enum: ['project', 'asset', 'user', 'comment', 'other'],
      required: true,
      index: true,
    },
    resourceId: { type: Schema.Types.ObjectId, required: true, index: true },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'legal'],
      default: 'medium',
      index: true,
    },
    status: {
      type: String,
      enum: ['open', 'in_review', 'actioned', 'appealed', 'closed'],
      default: 'open',
      index: true,
    },
    actions: { type: [ModerationActionSchema], default: [] },
    evidenceAssetIds: [{ type: Schema.Types.ObjectId, ref: 'Asset' }],
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  },
  { timestamps: true }
);

// Compound indexes for efficient querying
ModerationRecordSchema.index({ status: 1, severity: 1 });
ModerationRecordSchema.index({ createdAt: 1 });

export const ModerationRecordModel = model<IModerationRecord>('ModerationRecord', ModerationRecordSchema);

