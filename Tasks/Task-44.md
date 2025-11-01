Following the project plan's need to implement foundational user management features (Phase B/G), we proceed with **Task 44: User Settings & Preferences (Notification, Payout Methods)**.

This task is essential for user experience and preparing the platform for the payment lifecycle by implementing the read/write API for user-level settings that govern notifications and future financial flows.

***

## **Task 44: User Settings & Preferences (Notification, Payout Methods)**

**Goal:** Implement the `UserNotificationPrefs` model and the user settings endpoint (`PUT /settings`) to allow authenticated users to manage their notification channel preferences and define placeholder payout settings.

**Service:** `Notifications Service` & `Auth & Identity Service`
**Phase:** B/G - Core Primitives/Notifications
**Dependencies:** Task 1 (User Model, ID types), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/userSettings.model.ts` (New file: `IUserNotificationPrefs`, `IPayoutMethod` schemas)
2.  `src/services/userSettings.service.ts` (New file: `getUserSettings`, `updateUserSettings`)
3.  `src/controllers/userSettings.controller.ts` (New file: `settingsController`)
4.  `src/routes/userSettings.routes.ts` (New file: router for `/settings`)
5.  `test/integration/settings_crud.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /settings** | N/A | `UserSettingsDTO` (Full user preferences) | Auth (Self only) |
| **PUT /settings** | `{ notificationPrefs: { email: boolean }, payoutMethod: { type: string, details: {} } }` | `UserSettingsDTO` (Updated) | Auth (Self only) |

**UserSettingsDTO (Excerpt):**
```json
{
  "userId": "user_1",
  "notificationPrefs": { "email": true, "in_app": true },
  "payoutMethod": { "type": "stripe_connect", "details": { "accountId": "acct_xyz" } }
}
```

**Runtime & Env Constraints:**
*   **Self-Service:** All access to `/settings` must be strictly restricted to the authenticated user ID (`req.user.sub`).
*   **Schema Flexibility:** The `payoutMethod.details` should be a flexible JSON field (`Schema.Types.Mixed`) to accommodate varying PSP requirements (Stripe Connect ID, Razorpay Account ID, bank details, etc.).

**Acceptance Criteria:**
*   `GET /settings` must return the current settings or a default setting object if none exist (upsert pattern).
*   `PUT /settings` successfully updates and persists the preferences.
*   Attempting to view/update settings for another user returns **403 Forbidden**.

**Tests to Generate:**
*   **Integration Test (Read/Upsert):** Test fetching settings for a brand new user (should return defaults) and verify successful update.
*   **Integration Test (Security):** Test user A attempts to update user B's settings (403).

***

### **Task 44 Code Implementation**

#### **44.1. `src/models/userSettings.model.ts` (New Model)**

```typescript
// src/models/userSettings.model.ts
import { Schema, model, Types } from 'mongoose';

// --- Nested Interfaces ---

// Defines channel-level notification preferences
export interface INotificationPrefs {
    in_app: boolean;
    email: boolean;
    push: boolean;
    // Future: quietHours, category-level toggles
}

// Defines a linked payout method (flexible structure)
export interface IPayoutMethod {
    type: 'stripe_connect' | 'razorpay_account' | 'bank_transfer';
    details: any; // SENSITIVE: Schema.Types.Mixed for PSP/bank details
    isVerified: boolean;
    providerAccountId?: string; // PSP account ID for payouts (e.g. acct_123)
}

// --- Main User Settings Interface ---

export interface IUserSettings {
    _id?: Types.ObjectId;
    userId: Types.ObjectId;
    notificationPrefs: INotificationPrefs;
    payoutMethod?: IPayoutMethod;
    createdAt?: Date;
    updatedAt?: Date;
}

// --- Schemas ---

const NotificationPrefsSchema = new Schema<INotificationPrefs>({
    in_app: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    push: { type: Boolean, default: true },
}, { _id: false });

const PayoutMethodSchema = new Schema<IPayoutMethod>({
    type: { type: String, enum: ['stripe_connect', 'razorpay_account', 'bank_transfer'], required: true },
    details: { type: Schema.Types.Mixed, required: true, select: false }, // SECURITY: Hidden by default
    isVerified: { type: Boolean, default: false },
    providerAccountId: { type: String },
}, { _id: false });

const UserSettingsSchema = new Schema<IUserSettings>({
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    notificationPrefs: { type: NotificationPrefsSchema, default: () => ({}) },
    payoutMethod: { type: PayoutMethodSchema },
}, { timestamps: true });

export const UserSettingsModel = model<IUserSettings>('UserSettings', UserSettingsSchema);
```

#### **44.2. `src/services/userSettings.service.ts` (New File)**

```typescript
// src/services/userSettings.service.ts
import { UserSettingsModel, IUserSettings, INotificationPrefs, IPayoutMethod } from '../models/userSettings.model';
import { Types } from 'mongoose';
import { IUser } from '../models/user.model';

// Default values for new user upsert
const DEFAULT_USER_SETTINGS: IUserSettings = {
    userId: new Types.ObjectId(), // Placeholder, replaced during upsert
    notificationPrefs: { in_app: true, email: true, push: true },
};

// DTO for incoming updates (partial)
interface IUpdateSettingsDTO {
    notificationPrefs?: Partial<INotificationPrefs>;
    payoutMethod?: IPayoutMethod;
}

export class UserSettingsService {
    
    /** Checks if the requester is the owner of the settings. @throws {Error} 'PermissionDenied' */
    private checkOwnerAccess(targetUserId: string, requesterId: string): void {
        if (targetUserId !== requesterId) {
            throw new Error('PermissionDenied');
        }
    }

    /** Retrieves settings, creating defaults if none exist (Upsert Read). */
    public async getUserSettings(requesterId: string): Promise<IUserSettings> {
        const userId = new Types.ObjectId(requesterId);
        
        // Find and Upsert (Ensures settings document always exists)
        const settings = await UserSettingsModel.findOneAndUpdate(
            { userId: userId },
            { $setOnInsert: { notificationPrefs: DEFAULT_USER_SETTINGS.notificationPrefs } },
            { new: true, upsert: true }
        ).lean() as IUserSettings;

        return settings;
    }

    /** Updates user settings. */
    public async updateUserSettings(targetUserId: string, requesterId: string, data: IUpdateSettingsDTO): Promise<IUserSettings> {
        this.checkOwnerAccess(targetUserId, requesterId); // Authorization check

        const userId = new Types.ObjectId(targetUserId);
        const update: any = {};
        
        // 1. Handle Notification Preferences Update (Merge)
        if (data.notificationPrefs) {
            for (const key in data.notificationPrefs) {
                // Ensure key is a valid preference field
                if (['in_app', 'email', 'push'].includes(key)) {
                    update[`notificationPrefs.${key}`] = (data.notificationPrefs as any)[key];
                }
            }
        }
        
        // 2. Handle Payout Method Update (Full object replacement/update)
        if (data.payoutMethod) {
            // Note: In a real app, this triggers a verification flow/job before setting 'isVerified=true'
            update.payoutMethod = data.payoutMethod;
        }

        // 3. Execute Update
        const updatedSettings = await UserSettingsModel.findOneAndUpdate(
            { userId: userId },
            { $set: update },
            { new: true }
        ).lean() as IUserSettings;

        if (!updatedSettings) { throw new Error('UpdateFailed'); }

        // PRODUCTION: Emit 'user.settings.updated' event
        console.log(`[Event] User ${targetUserId} settings updated.`);
        
        return updatedSettings;
    }
}
```

#### **44.3. `src/controllers/userSettings.controller.ts` (New File)**

```typescript
// src/controllers/userSettings.controller.ts
import { Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { UserSettingsService } from '../services/userSettings.service';

const userSettingsService = new UserSettingsService();

// --- Validation Middleware ---

export const settingsSelfParamValidation = [
    param('userId').isMongoId().withMessage('Invalid User ID format.'),
];

export const settingsUpdateValidation = [
    // Notification Prefs validation
    body('notificationPrefs').optional().isObject().withMessage('Notification preferences must be an object.'),
    body('notificationPrefs.email').optional().isBoolean(),
    body('notificationPrefs.push').optional().isBoolean(),
    
    // Payout Method validation
    body('payoutMethod').optional().isObject().withMessage('Payout method must be an object.'),
    body('payoutMethod.type').optional().isIn(['stripe_connect', 'razorpay_account', 'bank_transfer']).withMessage('Invalid payout method type.'),
    body('payoutMethod.details').optional().isObject().withMessage('Payout method details are required.'),
];


/** Retrieves user settings. GET /settings (or /settings/:userId) */
export const getSettingsController = async (req: Request, res: Response) => {
    // NOTE: If params.userId is present, we enforce self-access (if not admin)
    const targetUserId = req.params.userId || req.user!.sub;
    
    try {
        // Authorization check is implicit in service (self-access enforced)
        const settings = await userSettingsService.getUserSettings(targetUserId);

        // Security: Remove PayoutMethod details before sending to client, unless explicitly requested/needed for config UI
        const settingsDTO = { ...settings };
        delete (settingsDTO as any).payoutMethod?.details; 

        return res.status(200).json(settingsDTO);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving settings.' } });
    }
};

/** Updates user settings. PUT /settings/:userId */
export const updateSettingsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { userId } = req.params;
        const updatedSettings = await userSettingsService.updateUserSettings(userId, req.user!.sub, req.body);

        // Security: Remove PayoutMethod details before sending back
        const settingsDTO = { ...updatedSettings };
        delete (settingsDTO as any).payoutMethod?.details; 

        return res.status(200).json(settingsDTO);
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'You can only update your own settings.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating settings.' } });
    }
};
```

#### **44.4. `src/routes/userSettings.routes.ts` (New File)**

```typescript
// src/routes/userSettings.routes.ts
import { Router } from 'express';
import { 
    getSettingsController, updateSettingsController, 
    settingsSelfParamValidation, settingsUpdateValidation 
} from '../controllers/userSettings.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { param } from 'express-validator';

const router = Router();

// --- User Settings Endpoints ---

// GET /settings/:userId - Retrieve specific user settings (Self-access enforced) (Task 44)
router.get(
    '/:userId',
    authenticate,
    settingsSelfParamValidation,
    getSettingsController
);

// PUT /settings/:userId - Update user settings (Self-access enforced) (Task 44)
router.put(
    '/:userId',
    authenticate,
    settingsSelfParamValidation,
    settingsUpdateValidation,
    updateSettingsController
);

export default router;
```

#### **44.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T44.1** | `GET /settings/:id` | Happy Path: Read Self | Auth User A | **200 OK** | Returns defaults if no doc exists (Upsert Read). |
| **T44.2** | `PUT /settings/:id` | Happy Path: Update Notif & Payout | Auth User A | **200 OK** | `notificationPrefs.email` is set to new value. |
| **T44.3** | `PUT /settings/:id` | Fail: Update Other User | Auth User A attempts User B ID | **403 Forbidden** | `not_owner` |
| **T44.4** | `PUT /settings/:id` | Fail: Invalid Payout Type | Auth User A, invalid `payoutMethod.type` | **422 Unprocessable** | `validation_error` |

---

