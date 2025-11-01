// src/models/job.model.ts
import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

export interface IJob {
  _id?: Types.ObjectId;
  jobId: string;
  type: string;
  priority: number; // 0-100 (higher = sooner)
  status: 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'dlq';
  payload: any;
  attempt: number;
  maxAttempts: number;
  nextRunAt: Date; // When job is available for processing (used for scheduling/retry)
  leaseExpiresAt?: Date; // Time worker must finish or renew
  workerId?: string;
  lastError?: { code?: string; message?: string };
  result?: any; // Result payload on success
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const JobSchema = new Schema<IJob>({
  jobId: { type: String, required: true, unique: true, default: () => `job_${crypto.randomBytes(6).toString('hex')}` },
  type: { type: String, required: true, index: true },
  priority: { type: Number, default: 50, index: true },
  status: { type: String, enum: ['queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'dlq'], default: 'queued', index: true },
  payload: { type: Schema.Types.Mixed, required: true },
  attempt: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  nextRunAt: { type: Date, default: Date.now, index: true },
  leaseExpiresAt: { type: Date, index: true },
  workerId: { type: String },
  lastError: { type: Schema.Types.Mixed },
  result: { type: Schema.Types.Mixed },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// PERFORMANCE: Compound index for finding next job efficiently
JobSchema.index({ status: 1, nextRunAt: 1, priority: -1 });

export const JobModel = model<IJob>('Job', JobSchema);

