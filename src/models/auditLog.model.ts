// src/models/auditLog.model.ts
import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

export interface IAuditLog {
  _id?: Types.ObjectId;
  auditId: string; // Internal identifier
  resourceType: string; // e.g., 'project', 'user', 'payment'
  resourceId?: Types.ObjectId;
  action: string; // e.g., 'user.suspended', 'refund.initiated'
  actorId?: Types.ObjectId; // User/System who performed action
  actorRole?: string;
  timestamp: Date;
  ip?: string;
  details: any; // Full context/payload of the action
  previousHash: string; // Hash of the immediately preceding log
  hash: string; // SHA256 of canonicalized record + previousHash
  immutable: boolean; // Flag to indicate if archived/verified
  createdAt?: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    auditId: {
      type: String,
      required: true,
      unique: true,
      default: () => `audit_${crypto.randomBytes(6).toString('hex')}`,
    },
    resourceType: { type: String, required: true, index: true },
    resourceId: { type: Schema.Types.ObjectId, index: true },
    action: { type: String, required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    actorRole: { type: String },
    timestamp: { type: Date, required: true, default: Date.now, index: true },
    ip: { type: String },
    details: { type: Schema.Types.Mixed },
    previousHash: { type: String, required: true }, // The chain link
    hash: { type: String, required: true, unique: true }, // The unique hash
    immutable: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
); // Append-only

// PERFORMANCE: Primary index for chronological query
AuditLogSchema.index({ timestamp: -1, resourceType: 1 });

export const AuditLogModel = model<IAuditLog>('AuditLog', AuditLogSchema);

