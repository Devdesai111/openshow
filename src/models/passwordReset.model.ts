import { Schema, model, Types } from 'mongoose';

export interface IPasswordReset {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string; // Hashed version of the token sent to the user
  expiresAt: Date;
  isUsed: boolean;
  createdAt?: Date;
}

const PasswordResetSchema = new Schema<IPasswordReset>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: true },
    isUsed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// SECURITY: TTL Index for automatic cleanup of expired/unused tokens
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetModel = model<IPasswordReset>('PasswordReset', PasswordResetSchema);
