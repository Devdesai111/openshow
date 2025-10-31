import { Schema, model, Types } from 'mongoose';

// Nested interface for Portfolio Items
interface IPortfolioItem {
  assetId: Types.ObjectId; // Reference to Asset (Task 19)
  title?: string;
  description?: string;
  externalLink?: string;
}

// Main Creator Profile Interface
export interface ICreatorProfile {
  _id?: Types.ObjectId;
  userId: Types.ObjectId; // Link to User
  headline?: string;
  bio?: string;
  avatarAssetId?: Types.ObjectId; // Reference to Asset (Task 19)
  coverAssetId?: Types.ObjectId;
  skills: string[]; // For filtering/search
  categories: string[];
  hourlyRate?: number; // In smallest currency unit (cents)
  projectRate?: number;
  locations?: string[];
  languages?: string[];
  availability: 'open' | 'busy' | 'invite-only';
  portfolioItems: IPortfolioItem[];
  verified: boolean;
  rating?: { average: number; count: number };
  stats?: { completedProjects: number };
  createdAt?: Date;
  updatedAt?: Date;
}

const PortfolioItemSchema = new Schema<IPortfolioItem>(
  {
    assetId: { type: Schema.Types.ObjectId, ref: 'Asset', required: true },
    title: { type: String },
    description: { type: String },
    externalLink: { type: String },
  },
  { _id: false }
);

const CreatorProfileSchema = new Schema<ICreatorProfile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    headline: { type: String, maxlength: 140 },
    bio: { type: String, maxlength: 2000 },
    avatarAssetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
    coverAssetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
    skills: { type: [String], default: [] },
    categories: { type: [String], default: [] },
    hourlyRate: { type: Number },
    projectRate: { type: Number },
    locations: { type: [String], default: [] },
    languages: { type: [String], default: [] },
    availability: {
      type: String,
      enum: ['open', 'busy', 'invite-only'],
      default: 'open',
      index: true,
    },
    portfolioItems: { type: [PortfolioItemSchema], default: [] },
    verified: { type: Boolean, default: false, index: true },
    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },
    stats: {
      completedProjects: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

export const CreatorProfileModel = model<ICreatorProfile>('CreatorProfile', CreatorProfileSchema);

