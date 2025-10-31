import { Schema, model, Types } from 'mongoose';

export interface IAuthSession {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  refreshTokenHash: string; // SENSITIVE: Hashed plain token for comparison
  userAgent?: string;
  ip?: string;
  expiresAt: Date;
  createdAt?: Date;
}

const AuthSessionSchema = new Schema<IAuthSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshTokenHash: { type: String, required: true },
    userAgent: { type: String },
    ip: { type: String },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

// SECURITY: TTL Index for automatic session cleanup after expiry
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthSessionModel = model<IAuthSession>('AuthSession', AuthSessionSchema);

