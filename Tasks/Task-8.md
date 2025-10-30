Following the established plan, we are now beginning **Phase B: Core Platform Primitives** with **Task 8: User Profile Service (CRUD)**.

This task is essential as it implements the core persistence and retrieval logic for user profiles, setting the stage for the Creator Directory (Task 10) and other personalized views.

***

## **Task 8: User Profile Service (CRUD)**

**Goal:** Implement the User Profile and Creator Profile database schemas and the CRUD endpoints (`GET /users/:userId`, `PUT /users/:userId`) with access controls to retrieve public/private profile views and allow self-editing.

**Service:** `User Profile & Creator Directory Service`
**Phase:** B - Core Platform Primitives
**Dependencies:** Task 1 (User Model, ID types), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/creatorProfile.model.ts` (ICreatorProfile, CreatorProfileSchema/Model)
2.  `src/services/userProfile.service.ts` (New file: `getUserProfile`, `updateUserProfile`)
3.  `src/controllers/userProfile.controller.ts` (New file: `getUserController`, `updateUserController`)
4.  `src/routes/userProfile.routes.ts` (New file: router for `/users` and `/creators`)
5.  `test/integration/user_crud.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /users/:userId** | `Params: { userId: string }` | `UserPublicDTO` (limited) or `UserFullDTO` (if owner/admin) | Public (limited) / Auth (full) |
| **PUT /users/:userId** | `Params: { userId: string }`, Body: `{ preferredName?, bio?, ... }` | `UserFullDTO` (updated) | Auth (Owner or Admin) |

**UserFullDTO (Excerpt - Owner/Admin View):**
```json
{
  "id": "64f1a2b3...", "email": "dev@example.com", "role": "creator", 
  "headline": "AI prompt engineer", "bio": "I build short films...", 
  "languages": ["English", "Hindi"], "isOwner": true 
}
```

**Runtime & Env Constraints:**
*   Mongoose must handle populating user-related fields efficiently (`lean()` reads recommended for public views).
*   The `updateUserProfile` service method must handle updates across both `UserModel` and `CreatorProfileModel` (if the user is a creator).

**Acceptance Criteria:**
*   `GET /users/:userId` for a public user must redact private fields like `email`.
*   `GET /users/:userId` for the authenticated owner or admin must return the full `UserFullDTO`.
*   `PUT /users/:userId` only allows the authenticated user (`req.user.sub`) or an Admin to update the profile (RBAC required).
*   Updates to fields like `headline`, `bio`, and `skills` must write to the `CreatorProfileModel`.

**Tests to Generate:**
*   **Integration Test (GET):** Test anonymous access (redacted), owner access (full), and admin access (full).
*   **Integration Test (PUT):** Test owner successfully updating profile, and unauthorized user failing (403).

**Non-Goals / Out-of-Scope (for Task 8):**
*   Creator Directory searching/listing (Task 10).
*   Linking/updating `avatarAssetId` (depends on Task 19).

**Performance / Security Notes:**
*   Use Mongoose `lean()` queries extensively for high-read endpoints (like public profile views).
*   Security: Profile editing must use strong **Identity Validation** (check `req.user.sub === params.userId` OR `req.user.role === 'admin'`).

***

### **Task 8 Code Implementation**

#### **8.1. `src/models/creatorProfile.model.ts` (New Model)**

```typescript
// src/models/creatorProfile.model.ts
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
  hourlyRate?: number; // In smallest currency unit
  projectRate?: number;
  locations?: string[];
  languages?: string[];
  availability: 'open' | 'busy' | 'invite-only';
  portfolioItems: IPortfolioItem[];
  verified: boolean;
  rating?: { avg: number; count: number };
  stats?: { completedProjects: number };
  createdAt?: Date;
  updatedAt?: Date;
}

const PortfolioItemSchema = new Schema<IPortfolioItem>({
  assetId: { type: Schema.Types.ObjectId, ref: 'Asset', required: true },
  title: { type: String },
  description: { type: String },
  externalLink: { type: String },
}, { _id: false });

const CreatorProfileSchema = new Schema<ICreatorProfile>({
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
  availability: { type: String, enum: ['open', 'busy', 'invite-only'], default: 'open', index: true },
  portfolioItems: { type: [PortfolioItemSchema], default: [] },
  verified: { type: Boolean, default: false, index: true },
  rating: {
    avg: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
  },
  stats: {
    completedProjects: { type: Number, default: 0 },
  },
}, { timestamps: true });

export const CreatorProfileModel = model<ICreatorProfile>('CreatorProfile', CreatorProfileSchema);
```

#### **8.2. `src/services/userProfile.service.ts` (New File)**

```typescript
// src/services/userProfile.service.ts
import { UserModel, IUser } from '../models/user.model';
import { CreatorProfileModel, ICreatorProfile } from '../models/creatorProfile.model';
import { Types } from 'mongoose';

// DTOs for Service Layer communication
interface IProfileUpdateData {
    preferredName?: string;
    fullName?: string;
    headline?: string;
    bio?: string;
    languages?: string[];
    // Add other fields that can be updated on both models
}

export class UserProfileService {
    /**
     * Retrieves a user profile, handling visibility based on the requester.
     * @param targetUserId - The ID of the user whose profile is requested.
     * @param requesterRole - The role of the authenticated requester.
     * @param requesterId - The ID of the authenticated requester (for self-check).
     * @returns Full or Public DTO.
     */
    public async getUserProfile(targetUserId: string, requesterRole?: IUser['role'], requesterId?: string): Promise<any> {
        const targetObjectId = new Types.ObjectId(targetUserId);

        // 1. Fetch User and Creator Profile Data
        const [user, creatorProfile] = await Promise.all([
            UserModel.findById(targetObjectId).lean() as Promise<IUser | null>,
            CreatorProfileModel.findOne({ userId: targetObjectId }).lean() as Promise<ICreatorProfile | null>,
        ]);

        if (!user) {
            throw new Error('UserNotFound');
        }

        // 2. Determine Access Level (Public, Owner, Admin)
        const isOwner = user._id?.toString() === requesterId;
        const isAdmin = requesterRole === 'admin';
        const isFullAccess = isOwner || isAdmin;

        // 3. Build Base DTO (always public fields)
        const baseProfile = {
            id: user._id.toString(),
            preferredName: user.preferredName,
            role: user.role,
            headline: creatorProfile?.headline,
            bio: creatorProfile?.bio,
            verified: creatorProfile?.verified || false,
            skills: creatorProfile?.skills || [],
            languages: creatorProfile?.languages || user.languages || [], // Use denormalized/user data
            createdAt: user.createdAt?.toISOString(),
        };

        // 4. Return Full DTO or Public DTO
        if (isFullAccess) {
            // Full DTO (Owner/Admin) includes email, status, and full details
            return {
                ...baseProfile,
                email: user.email,
                fullName: user.fullName,
                status: user.status,
                // Add all private fields needed for full access
            };
        } else {
            // Public DTO (redacted)
            return baseProfile;
        }
    }

    /**
     * Updates a user's profile information across User and CreatorProfile models.
     */
    public async updateUserProfile(targetUserId: string, requesterId: string, requesterRole: IUser['role'], updateData: IProfileUpdateData): Promise<any> {
        const targetObjectId = new Types.ObjectId(targetUserId);

        // 1. Security Check: Only self or Admin can update
        const isOwner = targetUserId === requesterId;
        const isAdmin = requesterRole === 'admin';
        if (!isOwner && !isAdmin) {
            // NOTE: Controller should catch this via RBAC middleware, but safety check here is good practice
            throw new Error('PermissionDenied');
        }

        // 2. Separate Updates for User Model fields
        const userUpdate: any = {};
        if (updateData.preferredName !== undefined) userUpdate.preferredName = updateData.preferredName;
        if (updateData.fullName !== undefined) userUpdate.fullName = updateData.fullName;
        
        if (Object.keys(userUpdate).length > 0) {
            await UserModel.updateOne({ _id: targetObjectId }, { $set: userUpdate });
        }

        // 3. Upsert/Update Creator Profile fields
        const creatorUpdate: any = {};
        if (updateData.headline !== undefined) creatorUpdate.headline = updateData.headline;
        if (updateData.bio !== undefined) creatorUpdate.bio = updateData.bio;
        if (updateData.languages !== undefined) creatorUpdate.languages = updateData.languages;
        
        if (Object.keys(creatorUpdate).length > 0) {
            // Upsert: Create a profile if it doesn't exist (only needed for Creators)
            await CreatorProfileModel.updateOne(
                { userId: targetObjectId },
                { $set: creatorUpdate },
                { upsert: true }
            );
        }

        // 4. Fetch and return the updated Full DTO
        const updatedProfile = await this.getUserProfile(targetUserId, requesterRole, requesterId);
        
        // PRODUCTION: Emit 'user.profile.updated' event for Search Service indexing
        console.log(`[Event] User ${targetUserId} profile updated.`);
        
        return updatedProfile;
    }
}
```

#### **8.3. `src/controllers/userProfile.controller.ts` (New File)**

```typescript
// src/controllers/userProfile.controller.ts
import { Request, Response } from 'express';
import { param, body, validationResult } from 'express-validator';
import { UserProfileService } from '../services/userProfile.service';
import { IUser } from '../models/user.model';

const userProfileService = new UserProfileService();

// --- Validation Middleware ---
export const userIdParamValidation = [
    param('userId').isMongoId().withMessage('Invalid User ID format.'),
];

export const profileUpdateValidation = [
    ...userIdParamValidation,
    body('preferredName').optional().isString().trim().isLength({ max: 50 }).withMessage('Preferred name max 50 chars.'),
    body('bio').optional().isString().trim().isLength({ max: 2000 }).withMessage('Bio max 2000 chars.'),
    body('headline').optional().isString().trim().isLength({ max: 140 }).withMessage('Headline max 140 chars.'),
    body('languages').optional().isArray().withMessage('Languages must be an array of strings.'),
];


/** Handles fetching a user profile. GET /users/:userId */
export const getUserController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid ID format.' }});
    }

    try {
        const targetUserId = req.params.userId;
        const requesterId = req.user?.sub; // Optional: will be present if user is authenticated
        const requesterRole = req.user?.role as IUser['role'] | undefined;

        // 2. Service Call
        const profile = await userProfileService.getUserProfile(targetUserId, requesterRole, requesterId);

        // 3. Success (200 OK)
        return res.status(200).json(profile);

    } catch (error: any) {
        if (error.message === 'UserNotFound') {
            return res.status(404).json({ error: { code: 'user_not_found', message: 'User profile not found.' } });
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error fetching profile.' } });
    }
};


/** Handles updating a user profile. PUT /users/:userId */
export const updateUserController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: errors.array() }});
    }

    const targetUserId = req.params.userId;
    const requesterId = req.user!.sub; // Authenticated user ID (must be present)
    const requesterRole = req.user!.role as IUser['role']; 

    // 2. Security Check (RBAC Logic moved to service, but quick ownership check here)
    if (targetUserId !== requesterId && requesterRole !== 'admin') {
         // This should primarily be caught by Task 2's authorization (USER_MANAGE_ALL) for admins, but for self-edit, we check here:
        return res.status(403).json({ error: { code: 'permission_denied', message: 'You can only update your own profile.' } });
    }
    
    try {
        // 3. Service Call
        const updatedProfile = await userProfileService.updateUserProfile(targetUserId, requesterId, requesterRole, req.body);

        // 4. Success (200 OK)
        return res.status(200).json(updatedProfile);

    } catch (error: any) {
        if (error.message === 'UserNotFound') {
            return res.status(404).json({ error: { code: 'user_not_found', message: 'User account not found.' } });
        }
        // Fallback
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating profile.' } });
    }
};
```

#### **8.4. `src/routes/userProfile.routes.ts` (New File)**

```typescript
// src/routes/userProfile.routes.ts
import { Router } from 'express';
import { getUserController, updateUserController, userIdParamValidation, profileUpdateValidation } from '../controllers/userProfile.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Public/Auth Endpoints ---

// GET /users/:userId - Fetch user (public partial / full if owner/admin) (Task 8)
router.get('/:userId', userIdParamValidation, authenticate, getUserController); 
// NOTE: authenticate is optional for public access, but required to retrieve requester details for full/private view.

// PUT /users/:userId - Update user profile (self or admin) (Task 8)
router.put(
    '/:userId',
    authenticate,
    profileUpdateValidation,
    // RBAC: Requires 'USER_MANAGE_ALL' for Admin, but authenticated user can update their own profile (checked in controller/service)
    authorize([PERMISSIONS.USER_MANAGE_ALL, PERMISSIONS.CREATOR_PROFILE_EDIT]),
    updateUserController
);

// --- NOTE: Creator directory endpoints (Task 10) will go here too ---


export default router;
```

---

