import { Schema, model, Types } from 'mongoose';

// Define sub-interfaces for strict typing
export interface ISocialAccount {
  provider: 'google' | 'github' | 'linkedin';
  providerId: string;
  profileUrl?: string;
  connectedAt: Date;
}

export interface ITwoFA {
  enabled: boolean;
  totpSecretEncrypted?: string; // SENSITIVE: Encrypted at rest
  enabledAt?: Date;
}

// Defines a registered push token and its device association
export interface IPushToken {
  token: string;
  deviceId: string; // Unique ID per device (helps manage multiple tokens)
  provider: 'fcm' | 'apns' | 'web';
  lastUsed: Date;
}

// Define main User interface
export interface IUser {
  _id?: Types.ObjectId;
  email: string;
  hashedPassword?: string;
  fullName?: string;
  preferredName?: string;
  role: 'creator' | 'owner' | 'admin';
  status: 'active' | 'pending' | 'suspended' | 'deleted';
  socialAccounts: ISocialAccount[];
  twoFA: ITwoFA;
  pushTokens: IPushToken[]; // New field for push tokens
  lastSeenAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const SocialAccountSchema = new Schema<ISocialAccount>(
  {
    provider: { type: String, enum: ['google', 'github', 'linkedin'], required: true },
    providerId: { type: String, required: true },
    profileUrl: { type: String },
    connectedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const TwoFASchema = new Schema<ITwoFA>(
  {
    enabled: { type: Boolean, default: false },
    totpSecretEncrypted: { type: String },
    enabledAt: { type: Date },
  },
  { _id: false }
);

const PushTokenSchema = new Schema<IPushToken>(
  {
    token: { type: String, required: true },
    deviceId: { type: String, required: true },
    provider: { type: String, enum: ['fcm', 'apns', 'web'], required: true },
    lastUsed: { type: Date, default: Date.now },
  },
  { _id: false }
);

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    hashedPassword: { type: String, select: false }, // SECURITY: Exclude from default find queries
    fullName: { type: String },
    preferredName: { type: String },
    role: { type: String, enum: ['creator', 'owner', 'admin'], default: 'creator', index: true },
    status: {
      type: String,
      enum: ['active', 'pending', 'suspended', 'deleted'],
      default: 'active',
    },
    socialAccounts: { type: [SocialAccountSchema], default: [] },
    twoFA: { type: TwoFASchema, default: (): ITwoFA => ({ enabled: false }) },
    pushTokens: { type: [PushTokenSchema], default: [] }, // Added pushTokens
    lastSeenAt: { type: Date },
  },
  { timestamps: true }
);

export const UserModel = model<IUser>('User', UserSchema);
