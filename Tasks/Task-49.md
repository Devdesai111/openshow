Following the structured plan, we proceed with **Task 49: Push Provider Adapter & Token Management**.

This task implements the final delivery channel for the `Notifications Service`, establishing the adapter for push notifications (FCM/APNs) and the endpoints required for users to securely manage their device subscription tokens.

***

## **Task 49: Push Provider Adapter & Token Management**

**Goal:** Implement the `IPushAdapter` (mocking FCM/APNs), and create the secure API endpoints for users to register and remove their device push tokens (`POST /settings/push-token`, `DELETE /settings/push-token`).

**Service:** `Notifications Service` & `Auth & Identity Service` (for token storage)
**Phase:** G - Notifications, Webhooks...
**Dependencies:** Task 44 (User Settings Model - for preferences/security).

**Output Files:**
1.  `src/notificationAdapters/push.interface.ts` (New file: Adapter Interface)
2.  `src/notificationAdapters/fcm.adapter.ts` (New file: Mock FCM implementation)
3.  `src/services/userSettings.service.ts` (Updated: `registerPushToken`, `deletePushToken`)
4.  `src/controllers/userSettings.controller.ts` (Updated: push token controllers)
5.  `src/routes/userSettings.routes.ts` (Updated: new protected routes)
6.  `test/integration/push_token.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (200 OK/204 No Content) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /settings/push-token** | `{ token: string, deviceId: string }` | **200 OK** | Auth (Self only) |
| **DELETE /settings/push-token** | `{ token: string }` | **204 No Content** | Auth (Self only) |

**Runtime & Env Constraints:**
*   **Decoupling:** The `NotificationService`'s push logic (future task) must call the adapter interface.
*   **Data Structure:** Push tokens and associated device IDs must be stored on the `UserModel` or a linked document for self-management. We will link them to the **`UserModel`** for direct access.
*   **Security:** Token registration/deletion is strictly restricted to the authenticated user.

**Acceptance Criteria:**
*   `POST /push-token` successfully adds the token to the user's list, ensuring the token is unique per user (update if deviceId exists).
*   `DELETE /push-token` removes the specified token and returns **204 No Content**.
*   Both endpoints enforce self-service only (403 Forbidden on wrong user ID).

**Tests to Generate:**
*   **Integration Test (Register):** Test successful token addition and verify DB update.
*   **Integration Test (Delete):** Test successful token removal and verify DB delete.
*   **Integration Test (Security):** Test unauthorized user attempts (403).

***

### **Task 49 Code Implementation**

#### **49.1. `src/notificationAdapters/push.interface.ts` (New Interface File)**

```typescript
// src/notificationAdapters/push.interface.ts

// DTO for a single push notification payload
export interface IPushNotificationDTO {
    token: string; // Target device token (FCM or APNs)
    title: string;
    body: string;
    data?: Record<string, string>; // Custom data payload (deep link, etc.)
}

// DTO for the response after sending
export interface IPushSendResponseDTO {
    providerMessageId: string;
    status: 'success' | 'token_invalid' | 'failure';
}

/**
 * The Standard Interface for all Mobile Push Notification Adapters.
 */
export interface IPushAdapter {
    providerName: string;

    /** Sends a batch of notifications (or a single one). */
    sendPush(data: IPushNotificationDTO[]): Promise<IPushSendResponseDTO[]>;
}
```

#### **49.2. `src/notificationAdapters/fcm.adapter.ts` (Mock Implementation)**

```typescript
// src/notificationAdapters/fcm.adapter.ts
import { IPushAdapter, IPushNotificationDTO, IPushSendResponseDTO } from './push.interface';

export class FCMAdapter implements IPushAdapter {
    public providerName = 'fcm';

    public async sendPush(notifications: IPushNotificationDTO[]): Promise<IPushSendResponseDTO[]> {
        // PRODUCTION: Use Firebase Admin SDK for batch sending
        return notifications.map((n, index) => ({
            providerMessageId: `fcm_msg_${crypto.randomBytes(6).toString('hex')}_${index}`,
            status: 'success',
        }));
    }
}
```

#### **49.3. `src/models/user.model.ts` (Update - Add Push Tokens)**

```typescript
// src/models/user.model.ts (partial update)
// ... (All previous imports) ...

// Defines a registered push token and its device association
export interface IPushToken {
    token: string;
    deviceId: string; // Unique ID per device (helps manage multiple tokens)
    provider: 'fcm' | 'apns' | 'web';
    lastUsed: Date;
}

export interface IUser {
    // ... (Existing fields) ...
    pushTokens: IPushToken[]; // New field for push tokens
}

const PushTokenSchema = new Schema<IPushToken>({
    token: { type: String, required: true, unique: true },
    deviceId: { type: String, required: true },
    provider: { type: String, enum: ['fcm', 'apns', 'web'], required: true },
    lastUsed: { type: Date, default: Date.now },
}, { _id: false });

const UserSchema = new Schema<IUser>({
    // ... (Existing schema fields) ...
    pushTokens: { type: [PushTokenSchema], default: [] }, // Added pushTokens
}, { timestamps: true });

export const UserModel = model<IUser>('User', UserSchema);
```

#### **49.4. `src/services/userSettings.service.ts` (Updates)**

```typescript
// src/services/userSettings.service.ts (partial update)
// ... (Imports from Task 44) ...
import { UserModel, IPushToken } from '../models/user.model'; 
import { IAuthUser } from '../middlewares/auth.middleware';

// DTO for incoming push token registration
interface IPushTokenRegisterDTO {
    token: string;
    deviceId: string;
    provider: IPushToken['provider'];
}


export class UserSettingsService {
    // ... (getUserSettings, updateUserSettings, checkOwnerAccess methods) ...

    /** Registers a new push token for the authenticated user. */
    public async registerPushToken(requesterId: string, data: IPushTokenRegisterDTO): Promise<void> {
        const userId = new Types.ObjectId(requesterId);
        
        // 1. Find existing token or device for update/upsert
        const existingToken = await UserModel.findOne({ 'pushTokens.token': data.token });
        const existingDevice = await UserModel.findOne({ 'pushTokens.deviceId': data.deviceId });

        // 2. Prepare new token structure
        const newToken: IPushToken = {
            token: data.token,
            deviceId: data.deviceId,
            provider: data.provider,
            lastUsed: new Date(),
        };

        if (existingToken) {
            // Case 1: Token exists (e.g., re-registration/update) -> Update lastUsed
            await UserModel.updateOne({ 'pushTokens.token': data.token }, { $set: { 'pushTokens.$.lastUsed': new Date() } });
        } else if (existingDevice) {
            // Case 2: Device exists with OLD token -> Remove old token and add new one
            await UserModel.updateOne({ _id: userId, 'pushTokens.deviceId': data.deviceId }, { $pull: { pushTokens: { deviceId: data.deviceId } } });
            await UserModel.updateOne({ _id: userId }, { $push: { pushTokens: newToken } });
        } else {
            // Case 3: Completely new token/device -> Push new token
            await UserModel.updateOne({ _id: userId }, { $push: { pushTokens: newToken } });
        }

        // PRODUCTION: Emit 'user.pushToken.registered' event
        console.log(`[Event] User ${requesterId} registered push token for device ${data.deviceId}.`);
    }

    /** Deletes a specified push token (e.g., on app uninstall or logout). */
    public async deletePushToken(requesterId: string, token: string): Promise<void> {
        const userId = new Types.ObjectId(requesterId);
        
        // Atomic pull operation
        const result = await UserModel.updateOne(
            { _id: userId },
            { $pull: { pushTokens: { token: token } } }
        );

        if (result.modifiedCount === 0) {
            throw new Error('TokenNotFound');
        }

        // PRODUCTION: Emit 'user.pushToken.deleted' event
        console.log(`[Event] User ${requesterId} deleted push token.`);
    }
}
```

#### **49.5. `src/controllers/userSettings.controller.ts` (Updates)**

```typescript
// src/controllers/userSettings.controller.ts (partial update)
// ... (Imports, userSettingsService initialization, previous controllers) ...
import { body, param, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const pushTokenRegisterValidation = [
    body('token').isString().withMessage('Push token is required.'),
    body('deviceId').isString().withMessage('Device ID is required.'),
    body('provider').isIn(['fcm', 'apns', 'web']).withMessage('Invalid provider type.'),
];

export const pushTokenDeleteValidation = [
    body('token').isString().withMessage('Push token is required.'),
];


// --- Push Token Controllers (Self-Service) ---

/** Registers a new push token. POST /settings/push-token */
export const registerPushTokenController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        await userSettingsService.registerPushToken(req.user!.sub, req.body);
        
        // 200 OK on success/upsert
        return res.status(200).json({ status: 'ok', message: 'Push token registered successfully.' });
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error registering push token.' } });
    }
};

/** Deletes a push token. DELETE /settings/push-token */
export const deletePushTokenController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        await userSettingsService.deletePushToken(req.user!.sub, req.body.token);
        
        // 204 No Content on successful deletion
        return res.status(204).send();
    } catch (error: any) {
        if (error.message === 'TokenNotFound') { return res.status(404).json({ error: { code: 'token_not_found', message: 'Token not found for this user/device.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error deleting push token.' } });
    }
};
```

#### **49.6. `src/routes/userSettings.routes.ts` (Updates)**

```typescript
// src/routes/userSettings.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 44) ...
import { 
    registerPushTokenController, deletePushTokenController, 
    pushTokenRegisterValidation, pushTokenDeleteValidation 
} from '../controllers/userSettings.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();

// ... (GET/PUT /settings/:userId from Task 44) ...

// --- Push Token Management (Task 49) ---

// POST /settings/:userId/push-token - Register device token
router.post(
    '/:userId/push-token',
    authenticate,
    settingsSelfParamValidation, // Check URL ID matches user
    pushTokenRegisterValidation,
    registerPushTokenController
);

// DELETE /settings/:userId/push-token - Delete device token
router.delete(
    '/:userId/push-token',
    authenticate,
    settingsSelfParamValidation, // Check URL ID matches user
    pushTokenDeleteValidation,
    deletePushTokenController
);

export default router;
```

#### **49.7. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T49.1** | `POST /push-token` | Happy Path: New Token | Auth User, Valid Payload | **200 OK** | N/A |
| **T49.2** | `POST /push-token` | Happy Path: Upsert Device | Same `deviceId`, New `token` | **200 OK** | Previous token for device removed from DB. |
| **T49.3** | `DELETE /push-token` | Happy Path: Delete Token | Auth User, Valid `token` | **204 No Content** | N/A |
| **T49.4** | `DELETE /push-token` | Fail: Token Not Found | Auth User, Invalid `token` | **404 Not Found** | `token_not_found` |

---
