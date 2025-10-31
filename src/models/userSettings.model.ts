// src/models/userSettings.model.ts
import { Schema, model, Types } from 'mongoose';

// --- Nested Interfaces ---

// Defines channel-level notification preferences
export interface INotificationPrefs {
  in_app: boolean;
  email: boolean;
  push: boolean;
  // Future: quietHours, category-level toggles
}

// Defines a linked payout method (flexible structure)
export interface IPayoutMethod {
  type: 'stripe_connect' | 'razorpay_account' | 'bank_transfer';
  details: any; // SENSITIVE: Schema.Types.Mixed for PSP/bank details
  isVerified: boolean;
  providerAccountId?: string; // PSP account ID for payouts (e.g. acct_123)
}

// --- Main User Settings Interface ---

export interface IUserSettings {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  notificationPrefs: INotificationPrefs;
  payoutMethod?: IPayoutMethod;
  createdAt?: Date;
  updatedAt?: Date;
}

// --- Schemas ---

const NotificationPrefsSchema = new Schema<INotificationPrefs>(
  {
    in_app: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    push: { type: Boolean, default: true },
  },
  { _id: false }
);

const PayoutMethodSchema = new Schema<IPayoutMethod>(
  {
    type: {
      type: String,
      enum: ['stripe_connect', 'razorpay_account', 'bank_transfer'],
      required: true,
    },
    details: { type: Schema.Types.Mixed, required: true, select: false }, // SECURITY: Hidden by default
    isVerified: { type: Boolean, default: false },
    providerAccountId: { type: String },
  },
  { _id: false }
);

const UserSettingsSchema = new Schema<IUserSettings>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    notificationPrefs: { type: NotificationPrefsSchema, default: () => ({ in_app: true, email: true, push: true }) },
    payoutMethod: { type: PayoutMethodSchema },
  },
  { timestamps: true }
);

export const UserSettingsModel = model<IUserSettings>('UserSettings', UserSettingsSchema);

