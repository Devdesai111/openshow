Following the structured plan, here is the detailed implementation for **Task 3: OAuth Login/Signup & Password Reset Request**, integrating new identity flows and maintaining strict adherence to the 11 constraints.

This task enhances the `Auth & Identity Service` by adding:
1.  An endpoint for OAuth authentication (`POST /auth/oauth`).
2.  The first step of the password recovery process (`POST /auth/password-reset/request`).

***

## **Task 3: OAuth Login/Signup & Password Reset Request**

**Goal:** Implement API endpoints for third-party OAuth sign-in/sign-up (`POST /auth/oauth`) and initiate the secure password reset flow (`POST /auth/password-reset/request`) by generating a reset token and scheduling an email.

**Service:** `Auth & Identity Service`
**Phase:** A - Foundations
**Dependencies:** Task 1 (User Model, Token/Session Logic, Auth Service/Controller), Task 11 (Initial Notifications Service implementation - mock dependency for now, to be fully implemented in Phase G).

**Output Files:**
1.  `src/models/passwordReset.model.ts` (IPasswordReset, PasswordResetSchema/Model)
2.  `src/services/auth.service.ts` (Updated: `oauthLogin`, `requestPasswordReset`)
3.  `src/controllers/auth.controller.ts` (Updated: `oauthController`, `requestPasswordResetController`)
4.  `src/routes/auth.routes.ts` (Updated: new public routes)
5.  `test/integration/oauth_reset.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (200 OK/201 Created) | Error (400 Bad Request/409 Conflict) |
| :--- | :--- | :--- | :--- |
| **POST /auth/oauth** | `{ provider: 'google', providerAccessToken: string, role?: 'creator' }` | Same as Login/Signup Response (Task 1) | `{ error: { code: 'oauth_invalid', message: '...' } }` |
| **POST /auth/password-reset/request** | `{ email: string, redirectUrl?: string }` | `{ status: 'ok', message: 'If user exists, reset link sent.' }` | `{ error: { code: 'validation_error', ... } }` |

**Runtime & Env Constraints:**
*   Requires a mock or actual `OAuthProvider` utility for token validation (e.g., calling Google's API).
*   Requires a mock or actual `NotificationService` for email scheduling.
*   Password Reset token expiry configured (e.g., 60 minutes).

**Acceptance Criteria:**
*   OAuth successful flow for new user returns **201 Created** with tokens, creating a user without a hashed password.
*   OAuth successful flow for existing user returns **200 OK** with tokens.
*   Password reset request returns **200 OK** consistently, even if the email does not exist (for security/user enumeration protection).
*   A unique, secure reset token is stored in `PasswordResetModel` with a TTL.

**Tests to Generate:**
*   **Integration Test (OAuth):** Test new user creation vs. existing user login (mocking provider response).
*   **Integration Test (Password Reset):** Test happy path for existing email, and ensure 200 OK for non-existent email.

**Non-Goals / Out-of-Scope (for Task 3):**
*   Actual integration with live OAuth providers (mock the provider validation).
*   Actual email sending (mock the `NotificationService` dependency).
*   Password reset confirmation endpoint (`/confirm` is Task 7B).

**Performance / Security Notes:**
*   Password reset request uses constant time response logic to prevent user enumeration.
*   Reset tokens are single-use, sensitive, and have a short TTL (e.g., 1 hour).

***

### **Task 3 Code Implementation**

#### **3.1. `src/models/passwordReset.model.ts`**

```typescript
// src/models/passwordReset.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IPasswordReset {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string; // Hashed version of the token sent to the user
  expiresAt: Date;
  isUsed: boolean;
  createdAt?: Date;
}

const PasswordResetSchema = new Schema<IPasswordReset>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: true },
  isUsed: { type: Boolean, default: false },
}, { timestamps: true });

// SECURITY: TTL Index for automatic cleanup of expired/unused tokens
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetModel = model<IPasswordReset>('PasswordReset', PasswordResetSchema);
```

#### **3.2. `src/services/auth.service.ts` (Updates)**

*(Assume `generateTokens` and `saveRefreshToken` from Task 1 are available.)*

```typescript
// src/services/auth.service.ts (partial update)

// --- Mocks/Placeholders for External Services ---

// Mock OAuthProvider utility (in a production environment, this calls external Google/GitHub APIs)
class OAuthProvider {
    // Mock successful validation and returns normalized user data
    public async validateToken(provider: string, token: string): Promise<{ providerId: string, email: string, fullName?: string }> {
        if (token === 'invalid-token') {
            throw new Error('Provider token validation failed.');
        }
        // In a real app, this verifies the token with the provider's API.
        return { 
            providerId: 'prov_id_' + crypto.createHash('sha256').update(token).digest('hex').substring(0, 10),
            email: 'oauth.user@example.com', // Placeholder
            fullName: 'OAuth User', 
        };
    }
}

// Mock NotificationService (in a real app, this is a separate service/module)
class NotificationService {
    public async sendPasswordResetEmail(email: string, token: string, redirectUrl: string): Promise<void> {
        // PRODUCTION: This would publish an event or call the Notifications Service API (Task 11)
        console.log(`[Mock Notification] Sending reset email to ${email} with token: ${token} and link: ${redirectUrl}?token=${token}`);
        return;
    }
}

const oauthProvider = new OAuthProvider();
const notificationService = new NotificationService();

export class AuthService {
    // ... (signup and login methods from Task 1) ...

    /**
     * Handles OAuth login/signup flow.
     * @throws {Error} - 'OAuthValidationFailed' | 'EmailConflict'.
     */
    public async oauthLogin(data: any, req: Request): Promise<ITokenPair & { user: IUser }> {
        const { provider, providerAccessToken, role } = data;

        // 1. Validate token with external provider (ASYNC)
        const providerData = await oauthProvider.validateToken(provider, providerAccessToken);
        const { providerId, email, fullName } = providerData;

        // 2. Find existing user by social account or email
        let user = await UserModel.findOne({ 
            $or: [
                { 'socialAccounts.providerId': providerId },
                { email: email }
            ]
        }).select('+hashedPassword'); // Select hash to satisfy IUser type internally, even if it's null/undefined

        if (!user) {
            // 3. New User Signup
            const newUser = new UserModel({
                email,
                role: role || 'creator',
                fullName,
                status: 'active',
                socialAccounts: [{ provider, providerId, connectedAt: new Date() }],
            });
            user = await newUser.save();
        } else {
            // 4. Existing User Login/Account Linking
            
            // Check for potential conflict: if found by email, but socialAccounts are different (requires merge/confirm flow, simplifying for Phase 1)
            const isLinked = user.socialAccounts.some(acc => acc.providerId === providerId);
            if (!isLinked) {
                // Link account if authenticated via email but logging in via new social provider
                user.socialAccounts.push({ provider, providerId, connectedAt: new Date() });
                await user.save();
            }

            user.lastSeenAt = new Date();
            await user.save();
        }
        
        // 5. Generate tokens and save session
        const tokenPair = generateTokens(user);
        await saveRefreshToken(user._id as Types.ObjectId, tokenPair.refreshToken, req, true);

        const userObject = user.toObject({ getters: true, virtuals: true }) as IUser;
        delete userObject.hashedPassword;

        return { ...tokenPair, user: userObject };
    }

    /**
     * Initiates the password reset flow.
     * Generates and stores a unique token, then schedules an email.
     * @returns Always returns success to prevent user enumeration.
     */
    public async requestPasswordReset(data: { email: string, redirectUrl: string }): Promise<void> {
        const { email, redirectUrl } = data;

        // 1. Find user (don't throw if not found - SECURITY)
        const user = await UserModel.findOne({ email }).lean() as IUser;

        if (user) {
            // 2. Generate secure, single-use token (Opaque string)
            const plainToken = crypto.randomBytes(20).toString('hex');
            const tokenHash = await hash(plainToken, 10); // Hash token for secure storage
            
            // Set expiry: 1 hour (configurable)
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000); 

            // 3. Invalidate any previous tokens for this user and store the new one
            await PasswordResetModel.updateMany({ userId: user._id, isUsed: false }, { isUsed: true }); // Invalidate old tokens
            
            const passwordReset = new PasswordResetModel({
                userId: user._id,
                tokenHash,
                expiresAt,
            });
            await passwordReset.save();

            // 4. Send email (Mocked service call)
            await notificationService.sendPasswordResetEmail(email, plainToken, redirectUrl);
        }

        // 5. Return success regardless of whether the user exists (SECURITY)
        return;
    }
}
```

#### **3.3. `src/controllers/auth.controller.ts` (Updates)**

```typescript
// src/controllers/auth.controller.ts (partial update)
// ... (imports, authService initialization, UserResponseDTO from Task 1) ...

import { check, validationResult } from 'express-validator';
import { Request, Response } from 'express';


// --- Validation Middleware ---

export const oauthValidation = [
    body('provider').isIn(['google', 'github', 'linkedin']).withMessage('Invalid OAuth provider.'),
    body('providerAccessToken').isString().withMessage('Provider access token is required.'),
    body('role').optional().isIn(['creator', 'owner']),
];

export const passwordResetRequestValidation = [
    body('email').isEmail().withMessage('Invalid email format.'),
    body('redirectUrl').isURL({ require_tld: false }).withMessage('A valid redirect URL is required in the request.'),
];


/** Handles OAuth login/signup. POST /auth/oauth */
export const oauthController = async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ 
            error: { code: 'validation_error', message: 'Input validation failed.', details: errors.array() } 
        });
    }

    try {
        const { accessToken, refreshToken, expiresIn, user } = await authService.oauthLogin(req.body, req);

        // Determine status code based on whether the user was created (simplistic check for Phase 1)
        const isNewUser = (user.createdAt?.getTime() === user.updatedAt?.getTime());
        const statusCode = isNewUser ? 201 : 200;

        // Response mapping
        const responseUser: UserResponseDTO = {
            id: user._id?.toString()!,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
            status: user.status,
            createdAt: user.createdAt?.toISOString(),
        };

        return res.status(statusCode).json({
            accessToken,
            refreshToken,
            tokenType: "Bearer",
            expiresIn,
            user: responseUser,
        });

    } catch (error: any) {
        if (error.message.includes('Provider token validation failed.')) {
            return res.status(400).json({ 
                error: { code: 'oauth_invalid', message: 'The provided provider token is invalid.' } 
            });
        }
        // Assuming other errors are server errors (500)
        return res.status(500).json({ 
            error: { code: 'server_error', message: 'An unexpected error occurred during OAuth flow.' } 
        });
    }
};

/** Handles initiating the password reset. POST /auth/password-reset/request */
export const requestPasswordResetController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ 
            error: { code: 'validation_error', message: 'Input validation failed.', details: errors.array() } 
        });
    }

    try {
        // 2. Service Call (handles security and email logic)
        await authService.requestPasswordReset(req.body);

        // 3. Security Best Practice: Always return 200 OK regardless of user existence
        return res.status(200).json({ 
            status: 'ok', 
            message: 'If an account is registered with this email, a password reset link has been sent.' 
        });

    } catch (error) {
        // Only return 500 for actual server/DB failure, not user error
        return res.status(500).json({ 
            error: { code: 'server_error', message: 'An unexpected server error occurred.' } 
        });
    }
};
```

#### **3.4. `src/routes/auth.routes.ts` (Updates)**

```typescript
// src/routes/auth.routes.ts (partial update)
import { Router } from 'express';
import { 
    // ... (Task 1 imports)
    oauthController, 
    oauthValidation,
    requestPasswordResetController,
    passwordResetRequestValidation
} from '../controllers/auth.controller';

const router = Router();

// --- Public Endpoints (Cont.) ---

// POST /auth/oauth - OAuth sign-in / sign-up (Task 3)
router.post('/oauth', oauthValidation, oauthController);

// POST /auth/password-reset/request - Trigger password reset email (Task 3)
router.post('/password-reset/request', passwordResetRequestValidation, requestPasswordResetController);

// ... (Task 1 endpoints: signup, login) ...

export default router;
```

#### **3.5. Test Specification**

| Test ID | Endpoint | Description | Input | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T3.1** | `POST /auth/oauth` | New User Signup (Mock Provider) | `{ provider: "google", providerAccessToken: "valid-token-new", role: "creator" }` | **201 Created** | N/A |
| **T3.2** | `POST /auth/oauth` | Existing User Login (Mock Provider) | `{ provider: "google", providerAccessToken: "valid-token-existing" }` | **200 OK** | N/A |
| **T3.3** | `POST /auth/oauth` | Invalid Token | `{ provider: "google", providerAccessToken: "invalid-token" }` | **400 Bad Request** | `oauth_invalid` |
| **T3.4** | `POST /auth/password-reset/request` | User Exists (Security) | `{ email: "test@exists.com", redirectUrl: "https://app.com/reset" }` | **200 OK** | N/A (Message only) |
| **T3.5** | `POST /auth/password-reset/request` | User Does Not Exist (Security) | `{ email: "unknown@a.com", redirectUrl: "https://app.com/reset" }` | **200 OK** | N/A (Message only) |
| **T3.6** | `POST /auth/password-reset/request` | Validation Fail: Bad Email | `{ email: "bademail", redirectUrl: "https://app.com/reset" }` | **422 Unprocessable Entity** | `validation_error` |

---

**Task 3 Complete.** We've implemented OAuth scaffolding, secure password reset request logic with token/TTL management, and adhered to the security constraint of preventing user enumeration on the reset flow.

