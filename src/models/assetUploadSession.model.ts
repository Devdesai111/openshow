import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

export interface IAssetUploadSession {
  _id?: Types.ObjectId;
  assetUploadId: string; // Unique short ID for client callback reference
  uploaderId: Types.ObjectId;
  projectId?: Types.ObjectId;
  filename: string;
  mimeType: string;
  expectedSha256?: string;
  isUsed: boolean; // Flag to prevent double-registration
  expiresAt: Date;
  createdAt?: Date;
}

const AssetUploadSessionSchema = new Schema<IAssetUploadSession>(
  {
    assetUploadId: {
      type: String,
      required: true,
      unique: true,
      default: () => `upl_${crypto.randomBytes(10).toString('hex')}`,
      index: true,
    },
    uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    expectedSha256: { type: String },
    isUsed: { type: Boolean, default: false, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// SECURITY: TTL Index for auto-cleanup of abandoned uploads (e.g., after 24 hours)
AssetUploadSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AssetUploadSessionModel = model<IAssetUploadSession>('AssetUploadSession', AssetUploadSessionSchema);

