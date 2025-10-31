// src/models/escrow.model.ts
import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

export interface IEscrow {
  _id?: Types.ObjectId;
  escrowId: string;
  projectId: Types.ObjectId;
  milestoneId: Types.ObjectId;
  payerId: Types.ObjectId;
  amount: number;
  currency: string;
  provider: 'stripe' | 'razorpay' | 'other';
  providerEscrowId?: string; // PSP ID used for fund identification (charge/intent ID)
  status: 'locked' | 'released' | 'refunded' | 'disputed';
  lockedAt?: Date;
  releasedAt?: Date;
  refundedAt?: Date;
  transactions: Types.ObjectId[]; // References to PaymentTransaction IDs
  createdAt?: Date;
  updatedAt?: Date;
}

const EscrowSchema = new Schema<IEscrow>(
  {
    escrowId: {
      type: String,
      required: true,
      unique: true,
      default: () => `esc_${crypto.randomBytes(8).toString('hex')}`,
    },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    milestoneId: {
      type: Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    }, // UNIQUE per milestone
    payerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    provider: { type: String, enum: ['stripe', 'razorpay', 'other'], required: true },
    providerEscrowId: { type: String },
    status: {
      type: String,
      enum: ['locked', 'released', 'refunded', 'disputed'],
      default: 'locked',
      index: true,
    },
    lockedAt: { type: Date, default: Date.now },
    releasedAt: { type: Date },
    refundedAt: { type: Date },
    transactions: [{ type: Schema.Types.ObjectId, ref: 'PaymentTransaction' }],
  },
  { timestamps: true }
);

export const EscrowModel = model<IEscrow>('Escrow', EscrowSchema);

