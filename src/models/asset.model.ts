import { Schema, model, Types } from 'mongoose';

// SENSITIVE: Internal-only metadata for a specific version/file in storage
export interface IAssetVersion {
  versionNumber: number;
  storageKey: string; // S3 Key (internal)
  sha256: string; // Hash for integrity check
  size: number;
  uploaderId: Types.ObjectId;
  createdAt: Date;
}

export interface IAsset {
  _id?: Types.ObjectId;
  projectId?: Types.ObjectId;
  uploaderId: Types.ObjectId;
  filename: string;
  mimeType: string;
  isSensitive: boolean; // PII flag
  processed: boolean; // Flag for thumbnail/transcode completion
  thumbnailAssetId?: Types.ObjectId; // Reference to a derived asset (thumbnail)
  versions: IAssetVersion[]; // All versions of this asset
  createdAt?: Date;
  updatedAt?: Date;
}

const AssetVersionSchema = new Schema<IAssetVersion>(
  {
    versionNumber: { type: Number, required: true },
    storageKey: { type: String, required: true, index: true },
    sha256: { type: String, required: true },
    size: { type: Number, required: true },
    uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AssetSchema = new Schema<IAsset>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    filename: { type: String, required: true, maxlength: 1024 },
    mimeType: { type: String, required: true },
    isSensitive: { type: Boolean, default: false },
    processed: { type: Boolean, default: false },
    thumbnailAssetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
    versions: { type: [AssetVersionSchema], default: [], required: true },
  },
  { timestamps: true }
);

export const AssetModel = model<IAsset>('Asset', AssetSchema);

