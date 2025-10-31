import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

// Evidence sub-document
export interface IEvidence {
  type: 'portfolio' | 'id_document' | 'social' | 'work_sample' | 'other';
  assetId?: Types.ObjectId; // Reference to Asset (Task 22)
  url?: string; // External URL
  notes?: string;
  isSensitive: boolean; // Flag for PII
}

export interface IVerificationApplication {
  _id?: Types.ObjectId;
  applicationId: string; // Unique, short ID
  userId: Types.ObjectId;
  statement?: string; // Message to reviewer
  evidence: IEvidence[];
  status: 'pending' | 'approved' | 'rejected' | 'needs_more_info';
  adminNotes?: string;
  reviewedBy?: Types.ObjectId; // Admin who reviewed
  reviewedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const EvidenceSchema = new Schema<IEvidence>(
  {
    type: {
      type: String,
      enum: ['portfolio', 'id_document', 'social', 'work_sample', 'other'],
      required: true,
    },
    assetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
    url: { type: String, maxlength: 500 },
    notes: { type: String, maxlength: 1000 },
    isSensitive: { type: Boolean, default: false },
  },
  { _id: false }
);

const VerificationApplicationSchema = new Schema<IVerificationApplication>(
  {
    applicationId: {
      type: String,
      required: true,
      unique: true,
      default: () => `verif_${crypto.randomBytes(6).toString('hex')}`,
      index: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    statement: { type: String, maxlength: 2000 },
    evidence: { type: [EvidenceSchema], required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'needs_more_info'],
      default: 'pending',
      index: true,
    },
    adminNotes: { type: String, maxlength: 2000 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

export const VerificationApplicationModel = model<IVerificationApplication>(
  'VerificationApplication',
  VerificationApplicationSchema
);

