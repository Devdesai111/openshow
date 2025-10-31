import { Schema, model, Types } from 'mongoose';

// --- Invite Model (Used for tracking owner-initiated invitations) ---
export interface IProjectInvite {
  _id?: Types.ObjectId;
  projectId: Types.ObjectId;
  roleId: Types.ObjectId;
  invitedBy: Types.ObjectId;
  invitedUserId: Types.ObjectId;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  message?: string;
  token?: string; // Optional: for non-user email invites (future)
  createdAt?: Date;
  updatedAt?: Date;
}

const ProjectInviteSchema = new Schema<IProjectInvite>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    roleId: { type: Schema.Types.ObjectId, required: true }, // References Project.roles sub-doc _id
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    invitedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'expired'],
      default: 'pending',
      index: true,
    },
    message: { type: String, maxlength: 500 },
    token: { type: String }, // For email-based invites
  },
  { timestamps: true }
);

// Compound index for efficient queries
ProjectInviteSchema.index({ projectId: 1, invitedUserId: 1, status: 1 });

export const ProjectInviteModel = model<IProjectInvite>('ProjectInvite', ProjectInviteSchema);

// --- Application Model (Used for tracking user-initiated applications to open roles) ---
export interface IProjectApplication {
  _id?: Types.ObjectId;
  projectId: Types.ObjectId;
  roleId: Types.ObjectId;
  applicantId: Types.ObjectId;
  message?: string;
  proposedRate?: number; // Cents
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn';
  reviewedBy?: Types.ObjectId; // Project owner who reviewed
  reviewedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const ProjectApplicationSchema = new Schema<IProjectApplication>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    roleId: { type: Schema.Types.ObjectId, required: true },
    applicantId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    message: { type: String, maxlength: 1000 },
    proposedRate: { type: Number, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'withdrawn'],
      default: 'pending',
      index: true,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

// Ensure a user can only have one application per role per project
ProjectApplicationSchema.index({ projectId: 1, roleId: 1, applicantId: 1 }, { unique: true });

export const ProjectApplicationModel = model<IProjectApplication>('ProjectApplication', ProjectApplicationSchema);
