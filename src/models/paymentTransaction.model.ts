// src/models/paymentTransaction.model.ts
import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

export interface IPaymentTransaction {
  _id?: Types.ObjectId;
  intentId: string; // Internal identifier for payment flow
  projectId?: Types.ObjectId;
  milestoneId?: Types.ObjectId;
  payerId: Types.ObjectId; // User who paid
  provider: 'stripe' | 'razorpay' | 'other';
  providerPaymentIntentId?: string; // PSP PaymentIntent/Order/Checkout ID
  providerPaymentId?: string; // PSP final charge/payment ID (set on success webhook)
  type: 'payment' | 'refund' | 'payout' | 'fee' | 'chargeback' | 'escrow_lock';
  amount: number; // In smallest currency unit
  currency: string;
  status: 'created' | 'pending' | 'succeeded' | 'failed' | 'refunded' | 'disputed';
  metadata?: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
}

const PaymentTransactionSchema = new Schema<IPaymentTransaction>(
  {
    intentId: {
      type: String,
      required: true,
      unique: true,
      default: () => `payint_${crypto.randomBytes(8).toString('hex')}`,
    },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    milestoneId: { type: Schema.Types.ObjectId },
    payerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, enum: ['stripe', 'razorpay', 'other'], required: true },
    providerPaymentIntentId: { type: String, index: true },
    providerPaymentId: { type: String, index: true },
    type: {
      type: String,
      enum: ['payment', 'refund', 'payout', 'fee', 'chargeback', 'escrow_lock'],
      required: true,
    },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    status: {
      type: String,
      enum: ['created', 'pending', 'succeeded', 'failed', 'refunded', 'disputed'],
      default: 'created',
      index: true,
    },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

export const PaymentTransactionModel = model<IPaymentTransaction>(
  'PaymentTransaction',
  PaymentTransactionSchema
);

