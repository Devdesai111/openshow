import { Schema, model, Types } from 'mongoose';
import * as crypto from 'crypto';

export interface IActivity {
  _id?: Types.ObjectId;
  activityId: string; // Unique short ID
  projectId: Types.ObjectId;
  actorId?: Types.ObjectId; // User or System actor
  type: string; // e.g., 'asset.uploaded', 'milestone.approved'
  summary: string; // Human-readable summary (5-500 chars)
  payload?: any; // Structured JSON for deep linking/context
  createdAt?: Date;
}

const ActivitySchema = new Schema<IActivity>(
  {
    activityId: {
      type: String,
      required: true,
      unique: true,
      default: () => `act_${crypto.randomBytes(8).toString('hex')}`,
      index: true,
    },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    type: { type: String, required: true, index: true },
    summary: { type: String, required: true, maxlength: 500 },
    payload: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

// PERFORMANCE: Primary index for chronological retrieval
ActivitySchema.index({ projectId: 1, createdAt: -1 });

export const ActivityModel = model<IActivity>('Activity', ActivitySchema);
