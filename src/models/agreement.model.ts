import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

// --- Nested Interfaces ---

export interface ISigner {
  signerId?: Types.ObjectId; // Platform User ID
  name?: string; // Non-platform signer name
  email: string; // Required for all signers
  role?: string;
  signed: boolean;
  signedAt?: Date;
  signatureMethod?: 'esign' | 'typed' | 'wet';
  // Note: providerRef/signatureHash omitted from primary schema for minimal PII/complexity
}

// Defines the content to be legally signed (canonical source of truth)
export interface IPayloadJson {
  title: string;
  licenseType: 'Exclusive Ownership' | 'Non-Exclusive (royalty-based)' | 'Creative Commons';
  terms: string;
  splits: { userId?: string; placeholder?: string; percentage: number }[];
  // ... other core legal terms
}

// --- Main Agreement Interface ---

export interface IAgreement {
  _id?: Types.ObjectId;
  agreementId: string;
  projectId: Types.ObjectId;
  createdBy: Types.ObjectId; // Project owner who generated it
  templateId?: string;
  title: string;
  payloadJson: IPayloadJson; // Canonical JSON payload for hashing
  status: 'draft' | 'pending_signatures' | 'partially_signed' | 'signed' | 'cancelled' | 'expired';
  signers: ISigner[];
  signOrderEnforced: boolean;
  pdfAssetId?: Types.ObjectId; // Asset ID of the final signed PDF (Task 55)
  version: number;
  immutableHash?: string; // SHA256 of canonical payload + signatures
  blockchainAnchors?: Array<{ txId: string; chain: string; createdAt: Date }>; // Blockchain transaction anchors (Task 57)
  createdAt?: Date;
  updatedAt?: Date;
}

// --- Nested Schemas ---

const SignerSchema = new Schema<ISigner>(
  {
    signerId: { type: Schema.Types.ObjectId, ref: 'User' },
    name: { type: String },
    email: { type: String, required: true },
    role: { type: String },
    signed: { type: Boolean, default: false },
    signedAt: { type: Date },
    signatureMethod: { type: String, enum: ['esign', 'typed', 'wet'] },
  },
  { _id: false }
);

const AgreementSchema = new Schema<IAgreement>(
  {
    agreementId: {
      type: String,
      required: true,
      unique: true,
      default: () => `ag_${crypto.randomBytes(8).toString('hex')}`,
      index: true,
    },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    templateId: { type: String },
    title: { type: String, required: true, maxlength: 255 },
    payloadJson: { type: Schema.Types.Mixed, required: true }, // Store as Mixed/JSONB
    status: {
      type: String,
      enum: ['draft', 'pending_signatures', 'partially_signed', 'signed', 'cancelled', 'expired'],
      default: 'draft',
      index: true,
    },
    signers: { type: [SignerSchema], default: [], required: true },
    signOrderEnforced: { type: Boolean, default: false },
    pdfAssetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
    version: { type: Number, default: 1 },
    immutableHash: { type: String },
    blockchainAnchors: [{
      txId: { type: String, required: true },
      chain: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    }],
  },
  { timestamps: true }
);

export const AgreementModel = model<IAgreement>('Agreement', AgreementSchema);

