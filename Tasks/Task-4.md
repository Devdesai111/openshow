Following the structured plan, here is the detailed implementation for **Task 4: Refresh Token Rotation & JWT Access**, completing the core authentication endpoints.

This task is crucial for maintaining platform security by implementing refresh token rotation and providing a protected endpoint for clients to retrieve their identity details.

***

## **Task 4: Refresh Token Rotation & JWT Access (`/auth/refresh`, `/auth/me`)**

**Goal:** Implement the refresh token endpoint (`POST /auth/refresh`) for token rotation/renewal and the secure current user lookup endpoint (`GET /auth/me`) for retrieving identity details using the Access Token.

**Service:** `Auth & Identity Service`
**Phase:** A - Foundations
**Dependencies:** Task 1 (User Model, AuthSession Model, JWT/Refresh Token Logic), Task 2 (Authentication Middleware).

**Output Files:**
1.  `src/services/auth.service.ts` (Updated: `refreshTokens`, `getAuthMe`)
2.  `src/controllers/auth.controller.ts` (Updated: `refreshController`, `meController`)
3.  `src/routes/auth.routes.ts` (Updated: new public and protected routes)
4.  `test/integration/token_access.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Headers) | Response (200 OK) | Error (401 Unauthorized/403 Forbidden) |
| :--- | :--- | :--- | :--- |
| **POST /auth/refresh** | `{ refreshToken: string }` | `{ accessToken: string, refreshToken: string, expiresIn: number }` | `{ error: { code: 'session_expired'\|'session_revoked', message: '...' } }` |
| **GET /auth/me** | `Auth: Bearer <access-token>` | `{ id: string, email: string, role: string, status: string, twoFAEnabled: boolean, ... }` | `{ error: { code: 'invalid_token', message: '...' } }` |

**Runtime & Env Constraints:**
*   Node v18+, MongoDB, Mongoose, Express.
*   Requires `bcryptjs` for comparing stored refresh token hashes.
*   Token hash generation/comparison must be consistent.

**Acceptance Criteria:**
*   `POST /auth/refresh` must invalidate the old refresh token (set `expiresAt = now` or delete the session) and issue a new pair of tokens (rotation).
*   Using an expired/revoked refresh token returns **401 Unauthorized** (`session_expired`/`session_revoked`).
*   `GET /auth/me` returns **200 OK** with essential user details.
*   `GET /auth/me` on a suspended account returns **403 Forbidden** (checked via middleware/DB fetch).

**Tests to Generate:**
*   **Integration Test (Refresh):** Test token renewal, re-using old refresh token (should fail after first use), and expired refresh token.
*   **Integration Test (AuthMe):** Test successful retrieval and check forbidden status for a suspended user.

**Non-Goals / Out-of-Scope (for Task 4):**
*   Full 2FA enforcement on refresh/me endpoints.
*   OAuth/Password Reset/Logout logic.

**Performance / Security Notes:**
*   Refresh token validation requires a DB lookup and a hash comparison (performance hit, but essential for security).
*   Token rotation mitigates token hijacking (if a refresh token is stolen, the attacker gets only one use).

***

### **Task 4 Code Implementation**

#### **4.1. `src/services/auth.service.ts` (Updates)**

*(Assume utility functions `generateTokens` and `saveRefreshToken` are available from Task 1/3.)*

```typescript
// src/services/auth.service.ts (partial update)

// ... (Imports, Types, generateTokens, saveRefreshToken from Task 1/3) ...

export class AuthService {
    // ... (signup, login, oauthLogin, requestPasswordReset methods) ...

    /**
     * Renews tokens using a Refresh Token. Implements token rotation.
     * @throws {Error} - 'SessionExpired' | 'SessionRevoked' | 'UserNotFound'.
     */
    public async refreshTokens(refreshToken: string, req: Request): Promise<ITokenPair> {
        // 1. Find the session by comparing the plain token to all hashed tokens in DB (expensive but secure)
        const sessions = await AuthSessionModel.find({ 
            expiresAt: { $gt: new Date() } // Only check non-expired sessions
        });

        // Use a loop + async compare to find the match
        let matchedSession = null;
        for (const session of sessions) {
            const isMatch = await compare(refreshToken, session.refreshTokenHash);
            if (isMatch) {
                matchedSession = session;
                break;
            }
        }
        
        if (!matchedSession) {
            throw new Error('SessionExpired');
        }

        // 2. Fetch the user associated with the session
        const user = await UserModel.findById(matchedSession.userId).lean() as IUser;
        if (!user) {
            throw new Error('UserNotFound');
        }

        // 3. Invalidate the old refresh token (Rotation: mark as expired/used)
        // SECURITY: This prevents replay attacks if the old token was compromised
        matchedSession.expiresAt = new Date(); // Set expiry to now
        await matchedSession.save();

        // 4. Generate new tokens and save the new session
        const tokenPair = generateTokens(user);
        await saveRefreshToken(user._id as Types.ObjectId, tokenPair.refreshToken, req, true); // Assume 'rememberMe: true' for refresh

        return tokenPair;
    }

    /**
     * Retrieves the current user's profile information.
     * @throws {Error} - 'UserNotFound' | 'AccountSuspended'.
     */
    public async getAuthMe(userId: string): Promise<IUser> {
        // 1. Find user (select all fields explicitly for DTO mapping)
        const user = await UserModel.findById(new Types.ObjectId(userId)).lean() as IUser;

        if (!user) {
            throw new Error('UserNotFound');
        }

        // 2. Status check
        if (user.status !== 'active' && user.status !== 'pending') {
            throw new Error('AccountSuspended'); 
        }

        // 3. Update lastSeenAt (optional, minimal write)
        await UserModel.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date() } });

        // 4. Return sanitized DTO
        return user;
    }
}
```

#### **4.2. `src/controllers/auth.controller.ts` (Updates)**

```typescript
// src/controllers/auth.controller.ts (partial update)

// ... (Imports, authService initialization, validation functions) ...

import { IAuthUser } from '../middlewares/auth.middleware'; // Import DTO for req.user

// DTO for /auth/me response
interface AuthMeResponseDTO {
    id: string;
    email: string;
    fullName?: string;
    preferredName?: string;
    role: 'creator'|'owner'|'admin';
    status: 'active'|'pending'|'suspended';
    twoFAEnabled: boolean;
    socialAccounts: Array<{ provider: string; providerId: string; connectedAt: string }>;
    createdAt: string;
    lastSeenAt?: string;
}

/** Handles refresh token renewal and rotation. POST /auth/refresh */
export const refreshController = async (req: Request, res: Response) => {
    // 1. Input Validation (minimal: token presence)
    const refreshToken = req.body.refreshToken as string;

    if (!refreshToken || typeof refreshToken !== 'string') {
        return res.status(400).json({ 
            error: { code: 'bad_request', message: 'Refresh token is required.' } 
        });
    }

    try {
        // 2. Service Call: Invalidates old token and issues new pair
        const { accessToken, refreshToken: newRefreshToken, expiresIn } = await authService.refreshTokens(refreshToken, req);
        
        // 3. Success (200 OK)
        return res.status(200).json({ 
            accessToken, 
            refreshToken: newRefreshToken, 
            expiresIn 
        });

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'SessionExpired' || error.message === 'UserNotFound') {
            return res.status(401).json({ 
                error: { code: 'session_expired', message: 'Refresh token is expired or invalid. Please log in again.' } 
            });
        }
        // Fallback
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during token refresh.' } });
    }
};

/** Handles user profile retrieval from Access Token. GET /auth/me */
export const meController = async (req: Request, res: Response) => {
    // Assumes Task 2's `authenticate` middleware successfully ran
    const userId = req.user!.sub; 

    try {
        // 1. Service Call
        const user = await authService.getAuthMe(userId);

        // 2. Response Mapping (Strict DTO)
        const responseUser: AuthMeResponseDTO = {
            id: user._id?.toString()!,
            email: user.email,
            fullName: user.fullName,
            preferredName: user.preferredName,
            role: user.role,
            status: user.status,
            twoFAEnabled: user.twoFA.enabled,
            socialAccounts: user.socialAccounts.map(acc => ({
                provider: acc.provider,
                providerId: acc.providerId,
                connectedAt: acc.connectedAt.toISOString(),
            })),
            createdAt: user.createdAt!.toISOString(),
            lastSeenAt: user.lastSeenAt?.toISOString(),
        };

        // 3. Success (200 OK)
        return res.status(200).json(responseUser);

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'UserNotFound') {
             return res.status(404).json({ 
                 error: { code: 'user_not_found', message: 'Authenticated user not found.' } 
            });
        }
        if (error.message === 'AccountSuspended') {
            return res.status(403).json({ 
                error: { code: 'account_suspended', message: 'Your account is suspended. Access denied.' } 
            });
        }
        // Fallback
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error fetching user profile.' } });
    }
};
```

#### **4.3. `src/routes/auth.routes.ts` (Updates)**

```typescript
// src/routes/auth.routes.ts (partial update)
import { Router } from 'express';
import { 
    // ... (Task 1/3 Imports)
    refreshController,
    meController,
} from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware'; // Used for /auth/me

const router = Router();

// ... (Task 1/3 Public Endpoints) ...

// --- Public Endpoints (Cont.) ---

// POST /auth/refresh - Exchange refresh token for new access token (Task 4)
router.post('/refresh', refreshController); 


// --- Protected Endpoints ---

// GET /auth/me - Get current user profile & roles (Task 4)
router.get('/me', authenticate, meController); // Requires only authentication


export default router;
```

#### **4.4. Test Specification**

| Test ID | Endpoint | Description | Input/Headers | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T4.1** | `POST /auth/refresh` | Happy Path: New Token Pair Issued (Rotation) | `{ refreshToken: "valid_token" }` | **200 OK** | N/A |
| **T4.2** | `POST /auth/refresh` | Fail: Re-use Old Token (Revoked/Expired) | `{ refreshToken: "old_token" }` | **401 Unauthorized** | `session_expired` |
| **T4.3** | `POST /auth/refresh` | Fail: Non-existent/Expired Token | `{ refreshToken: "non_existent" }` | **401 Unauthorized** | `session_expired` |
| **T4.4** | `GET /auth/me` | Happy Path: Retrieve Profile | `Auth: Bearer <access-token>` | **200 OK** | N/A |
| **T4.5** | `GET /auth/me` | Fail: Suspended User | `Auth: Bearer <suspended-user-token>` | **403 Forbidden** | `account_suspended` |
| **T4.6** | `GET /auth/me` | Fail: Invalid Access Token | `Auth: Bearer invalid-jwt` | **401 Unauthorized** | `invalid_token` |

---

**Task 4 Complete.** The core authentication system is now functionally complete, including user registration, login, token rotation, and identity retrieval, all secured by the Task 2 RBAC middleware structure.

