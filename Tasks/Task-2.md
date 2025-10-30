Following the plan, here is the detailed implementation for **Task 2: RBAC & Permissions Engine**, strictly adhering to the 11 constraints.

This task builds upon the core `User` model and the authentication flow established in Task 1.

***

## **Task 2: RBAC & Permissions Engine**

**Goal:** Implement robust middleware (`authenticate` and `authorize`) to enforce Role-Based Access Control (RBAC) by validating user JWT, account status, and required permissions against protected routes.

**Service:** `Auth & Identity Service`
**Phase:** A - Foundations
**Dependencies:** Task 1 (User Model, AuthSession Model, JWT infrastructure)

**Output Files:**
1.  `src/config/permissions.ts` (Permission constants and access checker functions)
2.  `src/middlewares/auth.middleware.ts` (JWT extraction and validation, populating `req.user`)
3.  `src/middlewares/rbac.middleware.ts` (Permission enforcement logic: checks status and role)
4.  `src/routes/user.routes.ts` (Updated to include an example protected route)
5.  `test/integration/rbac.test.ts` (Test specification)

**Input/Output Shapes:**
*   **Input (Headers):** `Authorization: Bearer <access-token>`
*   **Input (Middleware):** `requiredPermissions: string[]` (passed to `authorize` HOF)
*   **Output (Success):** Request proceeds to controller.
*   **Output (Failure 401):** `{ error: { code: 'no_token'\|'invalid_token', message: '...' } }`
*   **Output (Failure 403):** `{ error: { code: 'account_inactive'\|'permission_denied', message: '...' } }`

**Runtime & Env Constraints:**
*   Node v18+, MongoDB, Mongoose, Express, JWTs.
*   Strict TypeScript compiler.
*   JWT Secret from `process.env.ACCESS_TOKEN_SECRET`.

**Acceptance Criteria:**
*   Missing/Invalid JWT returns **401 Unauthorized** (`no_token`/`invalid_token`).
*   User with `suspended` status returns **403 Forbidden** (`account_inactive`).
*   User lacking required permissions returns **403 Forbidden** (`permission_denied`).
*   Admin accessing an Admin route returns **200 OK** from the controller.

**Tests to Generate:**
*   **Unit Test (`test/unit/auth.middleware.test.ts`):** Test JWT verification (missing, expired, malformed token).
*   **Integration Test (`test/integration/rbac.test.ts`):** Test route access for: Anonymous, Creator (lacks permission), Admin (has permission), and Suspended user.

**Non-Goals / Out-of-Scope:**
*   Full OAuth and Refresh Token implementation (Tasks 3, 4).
*   Resource-Based Access Control (e.g., checking ownership of a specific project).

**Performance / Security Notes:**
*   The `authenticate` middleware should be fast; only decrypts the JWT.
*   The `authorize` middleware performs one essential DB call to check the user's latest `status`.

**Example Request/Responses:**
*   **Req (Admin):** `GET /api/v1/admin/users`, `Auth: Bearer <admin-token>` $\rightarrow$ **200 OK**
*   **Req (Creator):** `GET /api/v1/admin/users`, `Auth: Bearer <creator-token>` $\rightarrow$ **403 Forbidden** with `permission_denied`.

***

### **Task 2 Code Implementation**

#### **2.1. `src/config/permissions.ts`**

```typescript
// src/config/permissions.ts
import { IUser } from '../models/user.model';

/** Global permission constants (UPPER_SNAKE_CASE). */
export const PERMISSIONS = {
    ADMIN_DASHBOARD: 'admin:dashboard_access',
    USER_MANAGE_ALL: 'user:manage_all',
    PROJECT_CREATE: 'project:create',
    VERIFICATION_REVIEW: 'verification:review',
    FINANCE_MANAGE: 'finance:manage',
    CREATOR_PROFILE_EDIT: 'profile:edit',
};

/** Defines permissions granted to each user role. */
export const ROLE_PERMISSIONS: Record<IUser['role'], string[]> = {
    'admin': [
        PERMISSIONS.ADMIN_DASHBOARD, 
        PERMISSIONS.USER_MANAGE_ALL, 
        PERMISSIONS.PROJECT_CREATE, 
        PERMISSIONS.VERIFICATION_REVIEW,
        PERMISSIONS.FINANCE_MANAGE,
        PERMISSIONS.CREATOR_PROFILE_EDIT,
    ],
    'owner': [
        PERMISSIONS.PROJECT_CREATE,
    ],
    'creator': [
        PERMISSIONS.CREATOR_PROFILE_EDIT,
    ],
};

/**
 * Checks if a role has all the required permissions.
 * @param userRole The user's role (from JWT or DB).
 * @param requiredPermissions An array of permission strings.
 * @returns true if all permissions are present.
 */
export const checkPermissions = (userRole: IUser['role'], requiredPermissions: string[]): boolean => {
    const userPermissions = ROLE_PERMISSIONS[userRole] || [];
    // Every required permission must be included in the user's granted permissions
    return requiredPermissions.every(perm => userPermissions.includes(perm));
};

/** Checks if the user status is valid for authenticated action. */
export const checkStatus = (userStatus: IUser['status']): boolean => {
    return userStatus === 'active';
};
```

#### **2.2. `src/middlewares/auth.middleware.ts`**

```typescript
// src/middlewares/auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev_access_secret';

/** Defines the structure of the payload after JWT decoding. */
export interface IAuthUser extends JwtPayload {
    sub: string; // The user ID (MongoDB ObjectId string)
    role: 'creator' | 'owner' | 'admin';
    email: string;
}

// Global declaration merging to add 'user' property to Request
declare module 'express-serve-static-core' {
    interface Request {
        user?: IAuthUser;
    }
}

/**
 * Middleware to extract and validate the JWT.
 * On success, populates req.user with decoded payload.
 */
export const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    // 1. Check for token presence (401 Unauthorized)
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
            error: { 
                code: 'no_token', 
                message: 'Authentication token is missing or malformed.' 
            } 
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        // 2. Verify token (async/await is not strictly necessary for sync JWT verification, but best practice for consistency)
        const decoded = verify(token, ACCESS_TOKEN_SECRET) as IAuthUser;
        
        // 3. Populate req.user (Strict Typing)
        if (!decoded.sub || !decoded.role || !decoded.email) {
            throw new Error('Required token claims missing.');
        }

        req.user = decoded;
        next();

    } catch (error) {
        // 4. Handle expired/invalid token (401 Unauthorized)
        return res.status(401).json({ 
            error: { 
                code: 'invalid_token', 
                message: 'Authentication token is invalid or has expired.' 
            } 
        });
    }
};
```

#### **2.3. `src/middlewares/rbac.middleware.ts`**

```typescript
// src/middlewares/rbac.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { checkPermissions, checkStatus } from '../config/permissions';
import { UserModel, IUser } from '../models/user.model';
import { Types } from 'mongoose';

/**
 * Middleware function generator for Role-Based Access Control (RBAC).
 * Checks user's status and ensures they possess all required permissions.
 * @param requiredPermissions An array of permission constants (from src/config/permissions.ts).
 * @returns An Express middleware function.
 */
export const authorize = (requiredPermissions: string[]) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        
        // Assumes authenticate middleware has run and req.user is present
        if (!req.user) {
            // Failsafe: Should be caught by the authenticate middleware (401)
            return res.status(500).json({ 
                error: { code: 'server_error', message: 'Authorization error: missing authenticated user data.' } 
            });
        }

        const { sub: userId } = req.user;

        try {
            // 1. Fetch User Status from DB (Security: Do not rely on potentially stale JWT claims for status/suspension)
            // Explicitly include status and role fields
            const user = await UserModel.findById(new Types.ObjectId(userId)).select('status role').lean() as IUser;

            if (!user) {
                // User may have been deleted (401 Unauthorized)
                return res.status(401).json({ 
                    error: { code: 'user_not_found', message: 'Authenticated user account not found.' } 
                });
            }

            // 2. Status Check (e.g., 'active' status required)
            if (!checkStatus(user.status)) {
                // 403 Forbidden: Account is suspended/inactive
                return res.status(403).json({ 
                    error: { code: 'account_inactive', message: `Account is ${user.status}. Access denied.` } 
                });
            }

            // 3. Permission Check (Role-based)
            if (!checkPermissions(user.role, requiredPermissions)) {
                // 403 Forbidden: User role lacks the necessary permissions
                return res.status(403).json({ 
                    error: { code: 'permission_denied', message: 'You do not have the required role or permissions.' } 
                });
            }

            // 4. Success: Proceed to the controller
            next();

        } catch (error) {
            console.error(`RBAC Error for User ${userId}:`, error);
            // General 500 server error for DB/unforeseen failures
            return res.status(500).json({ 
                error: { code: 'server_error', message: 'An error occurred during permission check.' } 
            });
        }
    };
};
```

#### **2.4. `src/routes/user.routes.ts`** (Updated Example Route)

```typescript
// src/routes/user.routes.ts
import { Router, Request, Response } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Example Controller Logic (Placeholder for Task 13.1) ---
const listAllUsersController = (req: Request, res: Response) => {
    // This endpoint should eventually call the Admin & Audit Service to fetch user data
    res.status(200).json({ 
        message: 'ADMIN ACCESS GRANTED: Successfully retrieved mock list of all users.', 
        userId: req.user?.sub,
        role: req.user?.role
    });
};

// --- Protected Endpoint Definition ---

// GET /api/v1/users/admin/all 
// Access: Only users with the 'admin:dashboard_access' permission.
router.get(
    '/admin/all', 
    authenticate, // Step 1: Ensure JWT is valid
    authorize([PERMISSIONS.ADMIN_DASHBOARD]), // Step 2: Check status and permissions
    listAllUsersController // Step 3: Execute controller if authorized
);

export default router;
```

#### **2.5. Test Specification (Acceptance Criteria Reference)**

(Integration tests would simulate creating users with different roles/statuses and attempting to access the `/admin/all` endpoint.)

| Test ID | Description | Role/Status Setup | Request Headers | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T2.1** | Missing Token | N/A | `Authorization:` (Missing) | **401** | `no_token` |
| **T2.2** | Invalid/Expired Token | N/A | `Authorization: Bearer invalid-jwt` | **401** | `invalid_token` |
| **T2.3** | Forbidden Role | `creator`/`active` | Valid Creator Token | **403** | `permission_denied` |
| **T2.4** | Suspended Status | `admin`/`suspended` | Valid Admin Token | **403** | `account_inactive` |
| **T2.5** | Admin Success | `admin`/`active` | Valid Admin Token | **200** | N/A |

---

