Following the structured plan, here is the detailed implementation for **Task 6: 2FA Verification & Finalization, Admin Suspension/Unsuspension**.

This task completes the 2FA security layer and introduces the first set of powerful, protected Admin endpoints for managing user accounts.

***

## **Task 6: 2FA Verification & Finalization, Admin Suspension/Unsuspension**

**Goal:** Complete the 2FA enrollment flow (`POST /auth/2fa/verify`) and implement core Admin-only endpoints for user account management (`POST /auth/users/:userId/suspend` and `/unsuspend`) with full RBAC protection.

**Service:** `Auth & Identity Service`, `Admin & Audit Service` (integration)
**Phase:** A - Foundations
**Dependencies:** Task 1 (User Model, Token/Session Logic), Task 2 (RBAC Middleware), Task 5 (2FA Enablement Start, TwoFATemp Model).

**Output Files:**
1.  `src/services/auth.service.ts` (Updated: `verify2FA`, `disable2FA`, `suspendUser`, `unsuspendUser`)
2.  `src/controllers/auth.controller.ts` (Updated: `verify2FAController`, `disable2FAController`, `suspendUserController`, `unsuspendUserController`)
3.  `src/routes/auth.routes.ts` (Updated: new protected routes)
4.  `test/integration/2fa_admin.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (200 OK/204 No Content) | Error (400/403/404/422) |
| :--- | :--- | :--- | :--- |
| **POST /auth/2fa/verify** | `{ tempSecretId: string, token: string }` | `{ status: 'enabled', enabledAt: string }` | `422 (invalid_token)` |
| **POST /auth/2fa/disable** | `Auth: Bearer <token>` | **200 OK** | `400 (not_enabled)` |
| **POST /auth/users/:id/suspend** | `{ reason: string, until?: string }` | `{ status: 'suspended', suspendedAt: string }` | `403 (permission_denied)` |
| **POST /auth/users/:id/unsuspend** | `{ reason?: string }` | `{ status: 'active' }` | `403 (permission_denied)` |

**Runtime & Env Constraints:**
*   Requires `speakeasy` (mocked) for TOTP token verification.
*   The `authorize` middleware must enforce the `ADMIN_DASHBOARD` and `USER_MANAGE_ALL` permissions for admin actions.

**Acceptance Criteria:**
*   2FA verification successfuly moves the secret from the temp collection to the `UserModel` and sets `twoFA.enabled=true`.
*   Invalid TOTP code or expired/invalid `tempSecretId` returns **422 Unprocessable Entity** (`invalid_token` / `expired_secret`).
*   Admin Suspension/Unsuspension endpoints require Admin role and `USER_MANAGE_ALL` permission.
*   Admin actions must target a valid user ID (404 if not found).

**Tests to Generate:**
*   **Integration Test (2FA Verify):** Test successful verification using a generated secret/token pair, and failure cases (wrong token, expired ID).
*   **Integration Test (Admin):** Test suspension/unsuspension by Admin (200) and attempts by Creator (403).

**Non-Goals / Out-of-Scope (for Task 6):**
*   Full AuditLog integration for Admin actions (only console logs/service events for now, full logging in Task 60).

**Performance / Security Notes:**
*   **Security:** 2FA verification code must use the shared secret correctly and check against potential replay attacks (though typically managed by TOTP lib/server clock).
*   **Security:** Admin actions must be logged and the target user ID validated against the DB to prevent logic errors.

***

### **Task 6 Code Implementation**

#### **6.1. `src/services/auth.service.ts` (Updates)**

*(Assume `kms` and `speakeasy` are available, as mocked in Task 5.)*

```typescript
// src/services/auth.service.ts (partial update)
// ... (Imports, KMSEncryption mock, TwoFATempModel, UserModel, etc.) ...

import * as speakeasy from 'speakeasy'; 

export class AuthService {
    // ... (signup, login, logout, enable2FA, etc. methods) ...

    /**
     * Verifies the TOTP code against the temporary secret and finalizes 2FA enrollment.
     * @throws {Error} - 'SecretNotFound' | 'TokenInvalid' | 'SecretExpired'.
     */
    public async verify2FA(tempSecretId: string, token: string, userId: string): Promise<Date> {
        // 1. Retrieve and validate the temporary secret
        const tempRecord = await TwoFATempModel.findById(new Types.ObjectId(tempSecretId));

        if (!tempRecord) {
            throw new Error('SecretNotFound');
        }
        if (tempRecord.userId.toString() !== userId) {
            throw new Error('SecretMismatch'); // Failsafe for security
        }
        if (tempRecord.expiresAt < new Date()) {
            await TwoFATempModel.deleteOne({ _id: tempSecretId });
            throw new Error('SecretExpired');
        }

        // 2. Decrypt the secret
        const secretBase32 = kms.decrypt(tempRecord.tempSecretEncrypted);

        // 3. Verify the TOTP token (ASYNC/AWAIT not needed for speakeasy verify)
        const isVerified = speakeasy.totp.verify({
            secret: secretBase32,
            encoding: 'base32',
            token: token,
            window: 1, // Allow 1 step (30s) either side of the current time
        });

        if (!isVerified) {
            throw new Error('TokenInvalid');
        }

        // 4. Finalize enrollment: Move secret to permanent user storage
        const enabledAt = new Date();
        const user = await UserModel.findById(new Types.ObjectId(userId));

        if (!user) { throw new Error('UserNotFound'); }

        user.twoFA = {
            enabled: true,
            totpSecretEncrypted: tempRecord.tempSecretEncrypted, // Store encrypted permanent secret
            enabledAt: enabledAt,
        };
        await user.save();

        // 5. Clean up temporary record (important for security)
        await TwoFATempModel.deleteOne({ _id: tempSecretId });

        // PRODUCTION: Emit '2fa.enabled' event
        console.log(`[Event] User ${userId} successfully enabled 2FA.`);

        return enabledAt;
    }

    /**
     * Disables 2FA (requires re-auth/password/TOTP confirmation in a robust system).
     */
    public async disable2FA(userId: string): Promise<void> {
        const user = await UserModel.findById(new Types.ObjectId(userId)).select('twoFA');
        
        if (!user || !user.twoFA || !user.twoFA.enabled) {
            throw new Error('NotEnabled');
        }

        user.twoFA.enabled = false;
        user.twoFA.totpSecretEncrypted = undefined;
        user.twoFA.enabledAt = undefined;
        await user.save();

        // PRODUCTION: Emit '2fa.disabled' event
        console.log(`[Event] User ${userId} successfully disabled 2FA.`);
    }

    // --- Admin Endpoints ---

    /** Suspends a target user account. */
    public async suspendUser(targetUserId: string, reason: string, until?: Date): Promise<IUser> {
        const user = await UserModel.findById(new Types.ObjectId(targetUserId));
        if (!user) { throw new Error('TargetUserNotFound'); }

        user.status = 'suspended';
        // PRODUCTION: Store suspension metadata (reason, suspendedBy, until) in a separate log/collection
        await user.save();

        // PRODUCTION: Emit 'user.suspended' event
        console.log(`[Event] User ${targetUserId} suspended until ${until?.toISOString()}`);
        return user.toObject() as IUser;
    }

    /** Unsuspends a target user account. */
    public async unsuspendUser(targetUserId: string): Promise<IUser> {
        const user = await UserModel.findById(new Types.ObjectId(targetUserId));
        if (!user) { throw new Error('TargetUserNotFound'); }

        user.status = 'active';
        await user.save();
        
        // PRODUCTION: Emit 'user.unsuspended' event
        console.log(`[Event] User ${targetUserId} unsuspended.`);
        return user.toObject() as IUser;
    }
}
```

#### **6.2. `src/controllers/auth.controller.ts` (Updates)**

```typescript
// src/controllers/auth.controller.ts (partial update)
// ... (Imports, authService initialization, validation functions) ...

import { body, param, validationResult } from 'express-validator';
import { Types } from 'mongoose';


// --- Validation Middleware ---

export const verify2FAValidation = [
    body('tempSecretId').isMongoId().withMessage('Invalid temporary secret ID.').bail(),
    body('token').isNumeric().isLength({ min: 6, max: 6 }).withMessage('Token must be a 6-digit number.'),
];

export const suspendUserValidation = [
    param('userId').isMongoId().withMessage('Invalid User ID format.'),
    body('reason').isString().isLength({ min: 10 }).withMessage('Reason must be at least 10 characters.'),
    body('until').optional().isISO8601().toDate().withMessage('Until date must be a valid ISO 8601 format.'),
];

export const userParamValidation = [ // Reusable check for param userId
    param('userId').isMongoId().withMessage('Invalid User ID format.'),
];


/** Handles 2FA verification and finalization. POST /auth/2fa/verify */
export const verify2FAController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: errors.array() }});
    }

    try {
        const { tempSecretId, token } = req.body;
        const userId = req.user!.sub; // Authenticated user ID

        // 2. Service Call
        const enabledAt = await authService.verify2FA(tempSecretId, token, userId);

        // 3. Success (200 OK)
        return res.status(200).json({ status: 'enabled', enabledAt: enabledAt.toISOString() });

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'TokenInvalid') {
            return res.status(422).json({ error: { code: 'invalid_token', message: 'Invalid 2FA token provided.' } });
        }
        if (error.message === 'SecretNotFound' || error.message === 'SecretMismatch') {
            return res.status(404).json({ error: { code: 'expired_secret', message: '2FA enrollment session not found or expired.' } });
        }
        // Fallback
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during 2FA verification.' } });
    }
};

/** Handles 2FA disabling. POST /auth/2fa/disable */
export const disable2FAController = async (req: Request, res: Response) => {
     // NOTE: A real-world app requires password re-auth or TOTP confirmation here
    try {
        await authService.disable2FA(req.user!.sub);
        
        return res.status(200).json({ status: 'disabled', disabledAt: new Date().toISOString() });
    } catch (error: any) {
        if (error.message === 'NotEnabled') {
            return res.status(400).json({ error: { code: 'not_enabled', message: '2FA is not currently enabled for this account.' } });
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during 2FA disable.' } });
    }
};

// --- Admin Controllers ---

/** Admin Suspends a user. POST /auth/users/:userId/suspend */
export const suspendUserController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: errors.array() }});
    }
    
    try {
        const targetUserId = req.params.userId;
        const { reason, until } = req.body;
        
        // 2. Service Call
        const updatedUser = await authService.suspendUser(targetUserId, reason, until);

        // 3. Success (200 OK)
        return res.status(200).json({
            userId: updatedUser._id?.toString(),
            status: updatedUser.status,
            reason: reason,
            until: until?.toISOString() || null,
        });
    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'TargetUserNotFound') {
            return res.status(404).json({ error: { code: 'user_not_found', message: 'Target user account not found.' } });
        }
        // Fallback
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during suspension.' } });
    }
};

/** Admin Unsuspends a user. POST /auth/users/:userId/unsuspend */
export const unsuspendUserController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid user ID format.' }});
    }

    try {
        const targetUserId = req.params.userId;
        
        // 2. Service Call
        const updatedUser = await authService.unsuspendUser(targetUserId);

        // 3. Success (200 OK)
        return res.status(200).json({
            userId: updatedUser._id?.toString(),
            status: updatedUser.status,
        });
    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'TargetUserNotFound') {
            return res.status(404).json({ error: { code: 'user_not_found', message: 'Target user account not found.' } });
        }
        // Fallback
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during unsuspension.' } });
    }
};
```

#### **6.3. `src/routes/auth.routes.ts` (Updates)**

```typescript
// src/routes/auth.routes.ts (partial update)
import { Router } from 'express';
import { 
    // ... (Task 1/3/4/5 Imports)
    verify2FAController,
    verify2FAValidation,
    disable2FAController,
    suspendUserController,
    unsuspendUserController,
    suspendUserValidation,
    userParamValidation,
} from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions'; // Import for RBAC checks

const router = Router();

// ... (Public Endpoints from Task 1/3) ...

// --- Protected Endpoints (Cont.) ---

// 2FA Verification & Finalization (Task 6)
router.post('/2fa/verify', authenticate, verify2FAValidation, verify2FAController);
router.post('/2fa/disable', authenticate, disable2FAController);


// --- Admin Endpoints (RBAC protected) ---

// POST /auth/users/:userId/suspend (Task 6)
router.post('/users/:userId/suspend', 
    authenticate,
    authorize([PERMISSIONS.USER_MANAGE_ALL]), // RBAC check
    suspendUserValidation,
    suspendUserController
);

// POST /auth/users/:userId/unsuspend (Task 6)
router.post('/users/:userId/unsuspend',
    authenticate,
    authorize([PERMISSIONS.USER_MANAGE_ALL]), // RBAC check
    userParamValidation,
    unsuspendUserController
);


// ... (GET /auth/me and POST /auth/logout from previous tasks) ...

export default router;
```

#### **6.4. Test Specification**

| Test ID | Endpoint | Description | Perm. Required | Role/Status | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T6.1** | `POST /auth/2fa/verify` | Happy Path: Finalize 2FA | N/A | Active | **200 OK** | N/A |
| **T6.2** | `POST /auth/2fa/verify` | Fail: Invalid TOTP Token | N/A | Active | **422 Unprocessable** | `invalid_token` |
| **T6.3** | `POST /auth/2fa/verify` | Fail: Expired Temp Secret | N/A | Active | **404 Not Found** | `expired_secret` |
| **T6.4** | `POST /auth/2fa/disable` | Happy Path: Disable 2FA | N/A | Active/2FA-Enabled | **200 OK** | N/A |
| **T6.5** | `POST /auth/users/:id/suspend` | Happy Path: Admin Suspend | `USER_MANAGE_ALL` | Admin | **200 OK** | N/A |
| **T6.6** | `POST /auth/users/:id/suspend` | Fail: Role Denied | `USER_MANAGE_ALL` | Creator | **403 Forbidden** | `permission_denied` |
| **T6.7** | `POST /auth/users/:id/unsuspend` | Fail: Target Not Found | `USER_MANAGE_ALL` | Admin | **404 Not Found** | `user_not_found` |

---

**Task 6 Complete.** The security and session foundation of the Auth Service is now largely finished, including advanced features like 2FA and administrative control over the user base.

