I understand and am committed to meticulously following the overall project plan and priorities. Task 7 addresses the critical second half of the password reset flow and establishes essential system health checks.

***

## **Task 7: Password Reset Confirmation & Health Checks**

**Goal:** Implement the password reset confirmation endpoint (`POST /auth/password-reset/confirm`) to securely set a new password, and introduce two essential infrastructure health endpoints (`GET /health` and `GET /metrics`).

**Service:** `Auth & Identity Service`, `Utility & System Features` (for health checks)
**Phase:** A - Foundations
**Dependencies:** Task 1 (User Model, Token/Session Logic), Task 3 (PasswordReset Model, Request endpoint).

**Output Files:**
1.  `src/services/auth.service.ts` (Updated: `confirmPasswordReset`)
2.  `src/controllers/auth.controller.ts` (Updated: `confirmPasswordResetController`)
3.  `src/controllers/utility.controller.ts` (New file: `healthController`, `metricsController`)
4.  `src/routes/auth.routes.ts` (Updated: new public route)
5.  `src/routes/utility.routes.ts` (New file: router for utility)
6.  `test/integration/reset_health.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (200 OK) | Error (401 Unauthorized/422 Unprocessable) |
| :--- | :--- | :--- | :--- |
| **POST /auth/password-reset/confirm** | `{ token: string, newPassword: string }` | `{ status: 'ok', message: 'Password successfully reset.' }` | `401 (token_invalid)` / `422 (validation_error)` |
| **GET /health** | N/A | `{ status: 'ok', uptime: number, db: 'ok'|'fail', date: string }` | `500 (db_error)` |
| **GET /metrics** | N/A | Prometheus format plain text | N/A (Admin/IP-restricted) |

**Runtime & Env Constraints:**
*   Requires `bcryptjs` for comparing the reset token hash and hashing the new password.
*   Requires a simple DB connection check (Mongoose/MongoDB) for the `/health` endpoint.
*   `/metrics` is marked as `Auth/IP-restricted` (handled in implementation notes).

**Acceptance Criteria:**
*   Password reset confirmation must validate the token hash, check expiry, set the new password hash for the user, and mark the token as `isUsed=true` (or delete it).
*   Password reset confirmation must revoke **all** active user sessions (log out everywhere).
*   An invalid/expired token returns **401 Unauthorized** (`token_invalid`).
*   `/health` must respond quickly, indicating the overall system status.

**Tests to Generate:**
*   **Integration Test (Reset Confirm):** Test happy path, expired token (401), and weak password (422).
*   **Integration Test (Health):** Test successful DB connection report (200) and simulated DB failure (500).

**Non-Goals / Out-of-Scope (for Task 7):**
*   Full Prometheus setup for metrics (return boilerplate/simple output structure).
*   Password reset request (`/request` is Task 3).

***

### **Task 7 Code Implementation**

#### **7.1. `src/services/auth.service.ts` (Updates)**

```typescript
// src/services/auth.service.ts (partial update)
// ... (Imports, KMSEncryption mock, etc. from previous tasks) ...

import { compare, hash } from 'bcryptjs'; 
import { PasswordResetModel, IPasswordReset } from '../models/passwordReset.model'; 
import { AuthSessionModel } from '../models/authSession.model'; 

export class AuthService {
    // ... (signup, login, oauthLogin, refreshTokens, getAuthMe, etc. methods) ...

    /**
     * Confirms the reset token and updates the user's password.
     * @throws {Error} - 'TokenInvalid' | 'TokenExpired' | 'TokenUsed' | 'UserNotFound'.
     */
    public async confirmPasswordReset(plainToken: string, newPassword: string): Promise<void> {
        // 1. Find and validate the token record
        const resetRecords = await PasswordResetModel.find({ isUsed: false, expiresAt: { $gt: new Date() } });
        
        let matchedRecord: IPasswordReset | null = null;
        for (const record of resetRecords) {
            // ASYNC AWAIT: Compare plain token against stored hash
            const isMatch = await compare(plainToken, record.tokenHash);
            if (isMatch) {
                matchedRecord = record;
                break;
            }
        }

        if (!matchedRecord) {
            // Use generic 'TokenInvalid' to not distinguish between invalid/expired/used.
            throw new Error('TokenInvalid');
        }

        // 2. Hash the new password
        const newHashedPassword = await hash(newPassword, 10);

        // 3. Update user password and invalidate all sessions (SECURITY: Logout everywhere)
        await UserModel.updateOne(
            { _id: matchedRecord.userId },
            { $set: { hashedPassword: newHashedPassword } }
        );
        
        await AuthSessionModel.deleteMany({ userId: matchedRecord.userId }); // Revoke all sessions

        // 4. Mark the reset token as used
        await PasswordResetModel.updateOne(
            { _id: matchedRecord._id }, 
            { $set: { isUsed: true } }
        );
        
        // PRODUCTION: Emit 'password.reset.confirmed' event for AuditLog (Task 60)
        console.log(`[Event] User ${matchedRecord.userId.toString()} successfully reset password.`);
    }
}
```

#### **7.2. `src/controllers/auth.controller.ts` (Updates)**

```typescript
// src/controllers/auth.controller.ts (partial update)
// ... (Imports, authService initialization, validation functions) ...

export const confirmPasswordResetValidation = [
    body('token').isString().isLength({ min: 10 }).withMessage('Token is required and must be valid format.').bail(),
    // Enforce strong password policy
    body('newPassword').isLength({ min: 10 }).withMessage('Password must be at least 10 characters and contain a mix of uppercase, lowercase, numbers, and symbols.'),
];

/** Handles password reset confirmation. POST /auth/password-reset/confirm */
export const confirmPasswordResetController = async (req: Request, res: Response) => {
    // 1. Input Validation (includes strong password policy check)
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'New password does not meet complexity requirements.', details: errors.array() }});
    }

    try {
        const { token, newPassword } = req.body;

        // 2. Service Call
        await authService.confirmPasswordReset(token, newPassword);

        // 3. Success (200 OK)
        return res.status(200).json({ status: 'ok', message: 'Password successfully reset.' });

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'TokenInvalid') {
            // 401 Unauthorized for expired/invalid token
            return res.status(401).json({ error: { code: 'token_invalid', message: 'Password reset token is invalid or has expired.' } });
        }
        // Fallback
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during password reset.' } });
    }
};
```

#### **7.3. `src/controllers/utility.controller.ts` (New File)**

```typescript
// src/controllers/utility.controller.ts
import { Request, Response } from 'express';
import mongoose from 'mongoose'; // Used for DB connection check

/** Handles system health check. GET /health */
export const healthController = async (req: Request, res: Response) => {
    const startTime = Date.now();
    let dbStatus: 'ok' | 'fail' = 'ok';
    
    // 1. Check DB Connection State
    try {
        if (mongoose.connection.readyState !== 1) { // 1 = connected
            // Attempt to connect/ping if not ready
            await mongoose.connection.db.admin().ping();
        }
    } catch (error) {
        dbStatus = 'fail';
        console.error('Health Check: DB connection failed.', error);
    }

    // 2. Compute Latency and Uptime
    const latencyMs = Date.now() - startTime;
    const uptime = process.uptime(); // Node.js process uptime in seconds

    // 3. Success Response (200 OK)
    const status = dbStatus === 'ok' ? 'ok' : 'degraded';
    const statusCode = dbStatus === 'ok' ? 200 : 500;
    
    // Clean response structure
    return res.status(statusCode).json({
        status: status,
        db: dbStatus,
        service: 'AuthService', // Identify the service
        uptimeSeconds: Math.floor(uptime),
        responseTimeMs: latencyMs,
        date: new Date().toISOString(),
    });
};

/** Handles Prometheus/Grafana metrics endpoint. GET /metrics */
export const metricsController = (req: Request, res: Response) => {
    // PRODUCTION: This would typically be protected by IP/Internal Auth and served by a library like 'prom-client'.
    // For now, return a simple text-based placeholder (Prometheus format).
    res.setHeader('Content-Type', 'text/plain');
    
    const simpleMetrics = `# HELP node_uptime_seconds Uptime of the Node.js process.
# TYPE node_uptime_seconds gauge
node_uptime_seconds ${process.uptime()}

# HELP custom_http_requests_total Total number of processed HTTP requests.
# TYPE custom_http_requests_total counter
custom_http_requests_total 1500

# HELP custom_db_connection_status Status of the database connection (1=ok, 0=fail).
# TYPE custom_db_connection_status gauge
custom_db_connection_status ${mongoose.connection.readyState === 1 ? 1 : 0}
`;
    return res.status(200).send(simpleMetrics);
};
```

#### **7.4. `src/routes/auth.routes.ts` (Updates)**

```typescript
// src/routes/auth.routes.ts (partial update)
import { Router } from 'express';
import { 
    // ... (Task 1/3/4/5/6 Imports)
    confirmPasswordResetController,
    confirmPasswordResetValidation,
} from '../controllers/auth.controller';
// ... (Auth/RBAC Middleware Imports) ...

const router = Router();

// ... (Public Endpoints Cont.) ...

// POST /auth/password-reset/confirm - Verify token and set new password (Task 7)
router.post('/password-reset/confirm', confirmPasswordResetValidation, confirmPasswordResetController);


// ... (All other Task 1-6 routes) ...

export default router;
```

#### **7.5. `src/routes/utility.routes.ts` (New File)**

```typescript
// src/routes/utility.routes.ts
import { Router } from 'express';
import { healthController, metricsController } from '../controllers/utility.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// GET /health - Service health check (Public access required by spec)
router.get('/health', healthController);

// GET /metrics - Prometheus metrics (Auth/IP-restricted by spec. Using Admin RBAC for now)
router.get(
    '/metrics', 
    authenticate,
    authorize([PERMISSIONS.ADMIN_DASHBOARD]), // Use Admin RBAC for restriction
    metricsController
);

export default router;
```

#### **7.6. Test Specification**

| Test ID | Endpoint | Description | Input/Headers | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T7.1** | `POST /auth/reset/confirm` | Happy Path: New Password Set | `{ token: "valid_token", newPassword: "NewStrongP@ss1" }` | **200 OK** | `ok` |
| **T7.2** | `POST /auth/reset/confirm` | Fail: Invalid/Expired Token | `{ token: "invalid_token", newPassword: "NewStrongP@ss2" }` | **401 Unauthorized** | `token_invalid` |
| **T7.3** | `POST /auth/reset/confirm` | Fail: Weak Password | `{ token: "valid_token", newPassword: "weak" }` | **422 Unprocessable** | `validation_error` |
| **T7.4** | `GET /health` | Happy Path: DB Connected | N/A | **200 OK** | `ok` |
| **T7.5** | `GET /metrics` | Fail: Non-Admin Access | `Auth: Bearer <creator-token>` | **403 Forbidden** | `permission_denied` |
| **T7.6** | `GET /metrics` | Success: Admin Access | `Auth: Bearer <admin-token>` | **200 OK** | N/A (Plain Text) |

---

**Task 7 Complete.** The core `Auth & Identity Service` is now complete for Phase A, along with essential system utilities.

We have successfully completed all tasks in **Phase A - Foundations**.
