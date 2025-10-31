import { Schema, model, Types, Document } from 'mongoose';

// --- Nested Interfaces ---

export interface IProjectRole {
  _id?: Types.ObjectId;
  title: string; // 'Prompt Engineer'
  description?: string;
  slots: number;
  assignedUserIds: Types.ObjectId[]; // Links to User
  requiredSkills?: string[];
}

export interface IRevenueSplit {
  _id?: Types.ObjectId;
  userId?: Types.ObjectId; // User ID if assigned, or null if placeholder
  placeholder?: string; // e.g., 'Team Pool' or 'Director'
  percentage?: number; // 0..100
  fixedAmount?: number; // In smallest currency units (if using fixed-rate model)
  conditions?: Record<string, unknown>; // Structured or mixed JSON
}

export interface IMilestone {
  _id?: Types.ObjectId;
  title: string;
  description?: string;
  dueDate?: Date;
  amount?: number; // In smallest currency unit (cents/paise)
  currency?: string;
  escrowId?: Types.ObjectId; // Reference to Escrow (Task 8)
  status: 'pending' | 'funded' | 'completed' | 'approved' | 'disputed' | 'rejected';
  createdAt?: Date;
  updatedAt?: Date;
}

// --- Main Project Interface ---

export interface IProject {
  _id?: Types.ObjectId;
  ownerId: Types.ObjectId;
  title: string;
  description?: string;
  category: string;
  coverAssetId?: Types.ObjectId; // Reference to Asset (Task 19)
  visibility: 'public' | 'private';
  collaborationType: 'open' | 'invite';
  roles: IProjectRole[];
  revenueSplits: IRevenueSplit[];
  milestones: IMilestone[];
  teamMemberIds: Types.ObjectId[]; // Denormalized list of all member IDs
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  createdAt?: Date;
  updatedAt?: Date;
}

// --- Nested Schemas ---

const ProjectRoleSchema = new Schema<IProjectRole>(
  {
    title: { type: String, required: true, maxlength: 100 },
    description: { type: String, maxlength: 500 },
    slots: { type: Number, required: true, min: 1, max: 50 },
    assignedUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    requiredSkills: [{ type: String, maxlength: 50 }],
  },
  { _id: true } // Important: sub-documents need _id for later reference/updates
);

const RevenueSplitSchema = new Schema<IRevenueSplit>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    placeholder: { type: String, maxlength: 100 },
    percentage: { type: Number, min: 0, max: 100 },
    fixedAmount: { type: Number, min: 0 },
    conditions: { type: Schema.Types.Mixed },
  },
  { _id: true }
);

const MilestoneSchema = new Schema<IMilestone>(
  {
    title: { type: String, required: true, maxlength: 200 },
    description: { type: String, maxlength: 1000 },
    dueDate: { type: Date },
    amount: { type: Number, min: 0 },
    currency: { type: String, default: 'USD', maxlength: 3 },
    escrowId: { type: Schema.Types.ObjectId, ref: 'Escrow' },
    status: {
      type: String,
      enum: ['pending', 'funded', 'completed', 'approved', 'disputed', 'rejected'],
      default: 'pending',
    },
  },
  { _id: true, timestamps: true }
);

// --- Main Schema and Custom Validation ---

const ProjectSchema = new Schema<IProject>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, index: true, maxlength: 200 },
    description: { type: String, maxlength: 2000 },
    category: { type: String, required: true, index: true, maxlength: 100 },
    coverAssetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
    visibility: { type: String, enum: ['public', 'private'], default: 'private' },
    collaborationType: { type: String, enum: ['open', 'invite'], default: 'invite' },
    roles: { type: [ProjectRoleSchema], default: [] },
    revenueSplits: { type: [RevenueSplitSchema], default: [] },
    milestones: { type: [MilestoneSchema], default: [] },
    teamMemberIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'completed', 'archived'],
      default: 'draft',
      index: true,
    },
  },
  { timestamps: true }
);

/** Custom Pre-Save Hook for Business Rule Validation */
ProjectSchema.pre('save', function (next) {
  const project = this as IProject & Document;

  // Validate Revenue Split Sum = 100% (only if percentages are present)
  const percentageSplits = project.revenueSplits.filter(
    (split: IRevenueSplit) => split.percentage !== undefined && split.percentage !== null
  );

  if (percentageSplits.length > 0) {
    const totalPercentage = percentageSplits.reduce((sum: number, split: IRevenueSplit) => sum + (split.percentage || 0), 0);
    if (Math.abs(totalPercentage - 100) > 0.01) {
      // Allow for small floating point errors
      const error = new Error('Revenue splits must sum to 100%.');
      error.name = 'ValidatorError';
      return next(error);
    }
  }

  // Set initial team members: only owner is assigned initially
  if (project.isNew && project.teamMemberIds.length === 0) {
    project.teamMemberIds = [project.ownerId];
  }

  next();
});

export const ProjectModel = model<IProject>('Project', ProjectSchema);
