import { Schema, model, Types } from 'mongoose';

// SENSITIVE: Store temporary 2FA secrets for the verification window
export interface ITwoFATemp {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  tempSecretEncrypted: string; // The secret the user needs to enter into authenticator app
  createdAt?: Date;
  expiresAt: Date;
}

const TwoFATempSchema = new Schema<ITwoFATemp>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tempSecretEncrypted: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

// SECURITY: TTL Index for automatic cleanup of expired temp secrets
TwoFATempSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TwoFATempModel = model<ITwoFATemp>('TwoFATemp', TwoFATempSchema);
