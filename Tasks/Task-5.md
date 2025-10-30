Following the structured plan, here is the detailed implementation for **Task 5: Logout, Two-Factor Authentication (2FA) Enablement (Step 1)**.

This task finalizes the session management by implementing logout and begins the security enhancement process by starting the 2FA enrollment flow.

***

## **Task 5: Logout, Two-Factor Authentication (2FA) Enablement (Step 1)**

**Goal:** Implement the secure logout functionality (`POST /auth/logout`) and the first step of the TOTP 2FA enablement flow (`POST /auth/2fa/enable`) by generating and returning the shared secret/QR code.

**Service:** `Auth & Identity Service`
**Phase:** A - Foundations
**Dependencies:** Task 1 (User Model, AuthSession Model, Token/Session Logic), Task 2 (Authentication Middleware).

**Output Files:**
1.  `src/services/auth.service.ts` (Updated: `logout`, `enable2FA`)
2.  `src/controllers/auth.controller.ts` (Updated: `logoutController`, `enable2FAController`)
3.  `src/routes/auth.routes.ts` (Updated: new protected routes)
4.  `test/integration/logout_2fa.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Headers) | Response (204 No Content/200 OK) | Error (401 Unauthorized/400 Bad Request) |
| :--- | :--- | :--- | :--- |
| **POST /auth/logout** | `Auth: Bearer <access-token>`, Body: `{ refreshToken: string }` | **204 No Content** | `{ error: { code: 'session_not_found', message: '...' } }` |
| **POST /auth/2fa/enable** | `Auth: Bearer <access-token>` | `{ tempSecretId: string, otpauthUrl: string, expiresAt: string }` | `{ error: { code: 'already_enabled', message: '...' } }` |

**Runtime & Env Constraints:**
*   Requires a robust library for TOTP secret generation, like `speakeasy` (or similar utility).
*   Password hash library (`bcryptjs`) is still needed for token management.
*   Temporary 2FA secrets must be saved with a short TTL (e.g., 10 minutes) for security, often in a separate ephemeral collection/cache.

**Acceptance Criteria:**
*   `POST /auth/logout` revokes the specified refresh token session and returns **204 No Content**.
*   `POST /auth/logout` without a `refreshToken` returns **400 Bad Request**.
*   `POST /auth/2fa/enable` generates a unique secret, saves an *encrypted* temporary reference (`tempSecretId`), and returns the secure `otpauthUrl`.
*   Attempting to enable 2FA when already enabled returns **400 Bad Request** (`already_enabled`).

**Tests to Generate:**
*   **Integration Test (Logout):** Test successful revocation and subsequent failure when using the revoked refresh token.
*   **Integration Test (2FA Enable):** Test successful secret generation and failure on re-enabling.

**Non-Goals / Out-of-Scope (for Task 5):**
*   2FA verification and final enablement (Task 6).
*   Admin audit logging (covered in Task 60, but service-level events will be noted).

**Performance / Security Notes:**
*   Logout requires token hash comparison and a DB delete/update (fast enough).
*   2FA secret **MUST** be encrypted/hashed before persistence, and the temporary record should have a short TTL.

***

### **Task 5 Code Implementation**

#### **5.1. `src/models/twoFATemp.model.ts`** (New Ephemeral Model)

```typescript
// src/models/twoFATemp.model.ts
import { Schema, model, Types } from 'mongoose';

// SENSITIVE: Store temporary 2FA secrets for the verification window
export interface ITwoFATemp {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  tempSecretEncrypted: string; // The secret the user needs to enter into authenticator app
  createdAt: Date;
  expiresAt: Date;
}

const TwoFATempSchema = new Schema<ITwoFATemp>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tempSecretEncrypted: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

// SECURITY: TTL Index for automatic cleanup of expired temp secrets
TwoFATempSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TwoFATempModel = model<ITwoFATemp>('TwoFATemp', TwoFATempSchema);
```

#### **5.2. `src/services/auth.service.ts` (Updates)**

*(Assume a utility for encryption/decryption (KMS mock) and TOTP generation (Speakeasy mock) exists)*

```typescript
// src/services/auth.service.ts (partial update)
// ... (Imports, Types, generateTokens, saveRefreshToken from Task 1/3) ...

import { compare, hash } from 'bcryptjs'; 
import { TwoFATempModel, ITwoFATemp } from '../models/twoFATemp.model';
import { IUser } from '../models/user.model';
import * as speakeasy from 'speakeasy'; // Mocking speakeasy as the TOTP library

// --- Mocks/Placeholders for External/Internal Services ---

// Mock KMS or simple encryption utility for sensitive field storage
class KMSEncryption {
    public encrypt(data: string): string {
        // PRODUCTION: Use actual KMS/Vault
        return `encrypted:${data}`;
    }
    public decrypt(data: string): string {
        return data.replace('encrypted:', '');
    }
}
const kms = new KMSEncryption();

const APP_NAME = "OpenShow";
const TEMP_SECRET_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class AuthService {
    // ... (signup, login, oauthLogin, refreshTokens, getAuthMe, requestPasswordReset methods) ...

    /** 
     * Revokes a specific refresh token session (Logout).
     * @param refreshToken - The plain opaque refresh token.
     * @throws {Error} - 'SessionNotFound'.
     */
    public async logout(refreshToken: string): Promise<void> {
        if (!refreshToken) {
            throw new Error('RefreshTokenRequired');
        }

        // Find the session matching the plain token (must check all hashes)
        const sessions = await AuthSessionModel.find({}); 
        let matchedSession = null;
        for (const session of sessions) {
            // ASYNC AWAIT: Use async hash comparison
            const isMatch = await compare(refreshToken, session.refreshTokenHash);
            if (isMatch) {
                matchedSession = session;
                break;
            }
        }
        
        if (!matchedSession) {
            throw new Error('SessionNotFound');
        }

        // Revoke the session (delete is cleaner than setting expiresAt=now)
        await AuthSessionModel.deleteOne({ _id: matchedSession._id });

        // PRODUCTION: Emit 'user.loggedOut' event for audit logging (Task 60)
        console.log(`[Event] User ${matchedSession.userId.toString()} logged out.`);
    }

    /**
     * Starts the 2FA enrollment process by generating a secret and temporary enrollment ID.
     * @throws {Error} - 'AlreadyEnabled' | 'UserNotFound'.
     */
    public async enable2FA(userId: string, email: string): Promise<{ tempSecretId: string, otpauthUrl: string, expiresAt: Date }> {
        const user = await UserModel.findById(new Types.ObjectId(userId)).select('twoFA').lean() as IUser;
        
        if (!user || !user.twoFA) {
            throw new Error('UserNotFound');
        }
        if (user.twoFA.enabled) {
            throw new Error('AlreadyEnabled');
        }

        // 1. Generate the TOTP secret
        const secret = speakeasy.generateSecret({
            name: `${APP_NAME}:${email}`,
            length: 20
        });

        // 2. Encrypt the secret for temporary storage (SECURITY)
        const tempSecretEncrypted = kms.encrypt(secret.base32);
        const expiresAt = new Date(Date.now() + TEMP_SECRET_TTL_MS);

        // 3. Store the temporary secret (awaiting verification in Task 6)
        const tempRecord = new TwoFATempModel({
            userId: new Types.ObjectId(userId),
            tempSecretEncrypted,
            expiresAt,
        });
        await tempRecord.save();

        // 4. Return necessary data for client (otpauthUrl for QR code display)
        return {
            tempSecretId: tempRecord._id.toString(),
            otpauthUrl: secret.otpauth_url!,
            expiresAt,
        };
    }
}
```

#### **5.3. `src/controllers/auth.controller.ts` (Updates)**

```typescript
// src/controllers/auth.controller.ts (partial update)

// ... (Imports, authService initialization, validation functions) ...

/** Handles user logout. POST /auth/logout */
export const logoutController = async (req: Request, res: Response) => {
    // 1. Input Check
    const refreshToken = req.body.refreshToken as string;
    
    if (!refreshToken) {
        return res.status(400).json({ 
            error: { code: 'bad_request', message: 'Refresh token is required in the body for revocation.' } 
        });
    }

    try {
        // 2. Service Call: Find and delete the session
        await authService.logout(refreshToken);

        // 3. Success (204 No Content - standard for successful delete)
        return res.status(204).send();
    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'SessionNotFound') {
            return res.status(400).json({ 
                error: { code: 'session_not_found', message: 'Session not found or already revoked.' } 
            });
        }
        // Fallback
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during logout.' } });
    }
};

/** Handles 2FA enablement step 1 (secret generation). POST /auth/2fa/enable */
export const enable2FAController = async (req: Request, res: Response) => {
    // 1. Authorization check (via req.user from 'authenticate' middleware)
    if (!req.user) { 
        return res.status(401).send(); 
    }

    const userId = req.user.sub;
    const email = req.user.email;
    
    try {
        // 2. Service Call: Generates secret and stores temporarily
        const { tempSecretId, otpauthUrl, expiresAt } = await authService.enable2FA(userId, email);

        // 3. Success (200 OK)
        return res.status(200).json({
            tempSecretId,
            otpauthUrl,
            expiresAt: expiresAt.toISOString(),
            message: 'Scan the QR code with your authenticator app. Verify in next step.',
        });
    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'AlreadyEnabled') {
            return res.status(400).json({ 
                error: { code: 'already_enabled', message: '2FA is already enabled on this account.' } 
            });
        }
        // Fallback
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during 2FA setup.' } });
    }
};
```

#### **5.4. `src/routes/auth.routes.ts` (Updates)**

```typescript
// src/routes/auth.routes.ts (partial update)
import { Router } from 'express';
import { 
    // ... (Task 1/3/4 Imports)
    logoutController,
    enable2FAController,
} from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();

// ... (Public Endpoints from Task 1/3/4) ...

// --- Protected Endpoints (Cont.) ---

// POST /auth/logout - Revoke refresh token / logout (Task 5)
router.post('/logout', authenticate, logoutController); 

// POST /auth/2fa/enable - Begin enable 2FA (TOTP) (Task 5)
router.post('/2fa/enable', authenticate, enable2FAController);


// ... (GET /auth/me from Task 4) ...

export default router;
```

#### **5.5. Test Specification**

| Test ID | Endpoint | Description | Input/Headers | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T5.1** | `POST /auth/logout` | Happy Path: Revoke Session | `Auth: Bearer <access-token>`, Body: `{ refreshToken: "valid_token" }` | **204 No Content** | N/A |
| **T5.2** | `POST /auth/logout` | Fail: Missing Refresh Token | `Auth: Bearer <access-token>`, Body: `{}` | **400 Bad Request** | `bad_request` |
| **T5.3** | `POST /auth/logout` | Fail: Already Revoked/Invalid | `Auth: Bearer <access-token>`, Body: `{ refreshToken: "already_revoked" }` | **400 Bad Request** | `session_not_found` |
| **T5.4** | `POST /auth/2fa/enable` | Happy Path: Secret Generation | `Auth: Bearer <access-token>` | **200 OK** | N/A |
| **T5.5** | `POST /auth/2fa/enable` | Fail: Already Enabled | `Auth: Bearer <2fa-enabled-token>` | **400 Bad Request** | `already_enabled` |

---

**Task 5 Complete.** Session management is robust with token-based logout, and the platform is ready to proceed to the verification and finalization of 2FA enrollment.

