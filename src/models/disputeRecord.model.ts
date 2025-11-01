// src/models/disputeRecord.model.ts
import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

// Defines the final action taken to resolve the dispute
export interface IResolution {
  outcome: 'release' | 'refund' | 'split' | 'deny';
  resolvedAmount?: number; // The amount released/refunded (if full/split)
  refundAmount?: number;
  notes: string;
  resolvedBy: Types.ObjectId;
  resolvedAt: Date;
}

export interface IDisputeRecord {
  _id?: Types.ObjectId;
  disputeId: string;
  projectId: Types.ObjectId;
  escrowId: Types.ObjectId;
  milestoneId: Types.ObjectId;
  raisedBy: Types.ObjectId;
  reason: string;
  status: 'open' | 'under_review' | 'resolved' | 'escalated' | 'closed';
  resolution?: IResolution;
  evidenceAssetIds?: Types.ObjectId[];
  assignedTo?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const ResolutionSchema = new Schema<IResolution>(
  {
    outcome: {
      type: String,
      enum: ['release', 'refund', 'split', 'deny'],
      required: true,
    },
    resolvedAmount: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },
    notes: { type: String, required: true, maxlength: 1000 },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    resolvedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const DisputeRecordSchema = new Schema<IDisputeRecord>(
  {
    disputeId: {
      type: String,
      required: true,
      unique: true,
      default: () => `dsp_${crypto.randomBytes(6).toString('hex')}`,
      index: true,
    },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    escrowId: { type: Schema.Types.ObjectId, ref: 'Escrow', required: true, unique: true, index: true },
    milestoneId: { type: Schema.Types.ObjectId, required: true },
    raisedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: { type: String, required: true, maxlength: 2000 },
    status: {
      type: String,
      enum: ['open', 'under_review', 'resolved', 'escalated', 'closed'],
      default: 'open',
      index: true,
    },
    resolution: { type: ResolutionSchema },
    evidenceAssetIds: [{ type: Schema.Types.ObjectId, ref: 'Asset' }],
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  },
  { timestamps: true }
);

// Compound indexes for efficient querying
DisputeRecordSchema.index({ status: 1, createdAt: 1 });
DisputeRecordSchema.index({ escrowId: 1, status: 1 });

export const DisputeRecordModel = model<IDisputeRecord>('DisputeRecord', DisputeRecordSchema);

