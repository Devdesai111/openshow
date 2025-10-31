// src/models/payout.model.ts
import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

// --- Payout Item (The individual payment to a recipient) ---
export interface IPayoutItem {
  _id?: Types.ObjectId;
  userId: Types.ObjectId; // Recipient
  amount: number; // Gross amount before fees/tax (for audit/reconciliation)
  fees: number; // Platform fee deducted from this share
  taxWithheld: number; // Tax deducted from this share
  netAmount: number; // Final amount to be paid (amount - fees - tax)
  providerPayoutId?: string; // PSP reference ID (e.g., Stripe transfer ID)
  status: 'scheduled' | 'processing' | 'paid' | 'failed' | 'cancelled' | 'pending_kyc';
  failureReason?: string;
  attempts: number;
  processedAt?: Date;
}

// --- Payout Batch (A collection of items scheduled together for an escrow event) ---
export interface IPayoutBatch {
  _id?: Types.ObjectId;
  batchId: string;
  escrowId: Types.ObjectId; // Critical link to Escrow Event
  projectId?: Types.ObjectId;
  milestoneId?: Types.ObjectId;
  scheduledBy: Types.ObjectId; // System or Admin ID
  currency: string;
  items: IPayoutItem[]; // Embedded array of individual payouts
  totalNet: number; // Sum of all netAmounts in items
  status: 'scheduled' | 'processing' | 'completed' | 'failed' | 'partial';
  createdAt?: Date;
  updatedAt?: Date;
}

const PayoutItemSchema = new Schema<IPayoutItem>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    fees: { type: Number, default: 0 },
    taxWithheld: { type: Number, default: 0 },
    netAmount: { type: Number, required: true },
    providerPayoutId: { type: String },
    status: {
      type: String,
      enum: ['scheduled', 'processing', 'paid', 'failed', 'cancelled', 'pending_kyc'],
      default: 'scheduled',
    },
    failureReason: { type: String },
    attempts: { type: Number, default: 0 },
    processedAt: { type: Date },
  },
  { _id: true }
); // Embedded item needs its own ID

const PayoutBatchSchema = new Schema<IPayoutBatch>(
  {
    batchId: {
      type: String,
      required: true,
      unique: true,
      default: () => `batch_${crypto.randomBytes(6).toString('hex')}`,
    },
    escrowId: {
      type: Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    }, // Idempotency key for scheduling
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    milestoneId: { type: Schema.Types.ObjectId },
    scheduledBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    currency: { type: String, required: true },
    items: { type: [PayoutItemSchema], required: true },
    totalNet: { type: Number, required: true },
    status: {
      type: String,
      enum: ['scheduled', 'processing', 'completed', 'failed', 'partial'],
      default: 'scheduled',
      index: true,
    },
  },
  { timestamps: true }
);

export const PayoutBatchModel = model<IPayoutBatch>('PayoutBatch', PayoutBatchSchema);
