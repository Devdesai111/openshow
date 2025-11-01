Following the structured plan and focusing on compliance and user rights, we proceed with **Task 87: Data Privacy & GDPR Flows**.

This task implements the user-facing and administrative mechanisms required to satisfy data protection regulations (like GDPR and CCPA), including the "Right to be Forgotten" (data deletion) and data portability (data export).

***

## **Task 87: Data Privacy & GDPR Flows**

**Goal:** Implement the data deletion workflow (`DELETE /auth/me/data`) and the data export mechanism (`GET /auth/me/data/export`) for authenticated users, ensuring that deletion is a secure soft-delete/redaction process compliant with audit trail requirements (Task 60).

**Service:** `Auth & Identity Service` / `Admin & Audit Service`
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 6 (Auth Logic), Task 60 (AuditLog Service), Task 62 (Audit Export Job - leveraged).

**Output Files:**
1.  `src/services/auth.service.ts` (Updated: `requestDataDeletion`, `requestDataExport`)
2.  `src/controllers/auth.controller.ts` (Updated: new controllers)
3.  `src/routes/auth.routes.ts` (Updated: new protected routes)
4.  `test/integration/gdpr_flow.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (202 Accepted) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **DELETE /auth/me/data** | N/A | **202 Accepted** | Auth (Self only) |
| **GET /auth/me/data/export** | N/A | **202 Accepted** | Auth (Self only) |

**Deletion Workflow (Conceptual):**
1.  User calls `DELETE /auth/me/data`.
2.  `AuthService` sets `UserModel.status = 'deleted'`.
3.  System enqueues `job.data.purge` (redaction) job.
4.  Job safely redacts/removes PII from other models (soft delete logic used heavily).

**Runtime & Env Constraints:**
*   **Irreversible Action:** Data deletion must be a multi-step, asynchronous process handled by a job to ensure atomicity across microservices.
*   **Audit Compliance:** PII is never truly *deleted* from financial/legal records; instead, it is **redacted** (`[REDACTED]`) and an audit trail of the redaction is kept.
*   **Authorization:** Strictly restricted to the authenticated user ID.

**Acceptance Criteria:**
*   Both endpoints return **202 Accepted** and enqueue a background job (Task 52).
*   The deletion process sets the user's status to `'deleted'` and triggers an audit log.
*   The export process triggers a system job with the correct user ID as a filter.

**Tests to Generate:**
*   **Integration Test (Deletion):** Test user successfully initiating deletion and verifying the user status update.
*   **Integration Test (Export):** Test user successfully initiating data export.

***

### **Task 87 Code Implementation**

#### **87.1. `src/services/auth.service.ts` (Updates - GDPR Flows)**

```typescript
// src/services/auth.service.ts (partial update)
// ... (Imports from Task 6, AuditService) ...
import { JobService } from './job.service'; // Task 52 Dependency
import { AuthSessionModel } from '../models/authSession.model';

const jobService = new JobService();


export class AuthService {
    // ... (All previous Auth methods) ...

    /** Initiates the permanent user data deletion/redaction process (Right to be Forgotten). */
    public async requestDataDeletion(userId: string): Promise<string> {
        const userObjectId = new Types.ObjectId(userId);
        
        // 1. Invalidate all sessions immediately (preemptive logout)
        await AuthSessionModel.deleteMany({ userId: userObjectId });
        
        // 2. Set user status to 'deleted'
        await UserModel.updateOne({ _id: userObjectId }, { $set: { status: 'deleted' } });

        // 3. Audit Log (CRITICAL)
        await auditService.logAuditEntry({
            resourceType: 'user',
            resourceId: userId,
            action: 'user.deletion.requested',
            actorId: userId,
            details: { message: 'Initiated GDPR deletion process.' },
        });

        // 4. Enqueue Asynchronous Redaction Job (Task 52)
        const job = await jobService.enqueueJob({
            type: 'data.purge', // New job type
            payload: { userId, timestamp: new Date().toISOString() },
            priority: 90, // High priority
            createdBy: userId,
        });

        return job.jobId;
    }

    /** Initiates the user data export process (Right to Portability). */
    public async requestDataExport(userId: string): Promise<string> {
        // 1. Audit Log (CRITICAL)
        await auditService.logAuditEntry({
            resourceType: 'user',
            resourceId: userId,
            action: 'user.data.export.requested',
            actorId: userId,
            details: { message: 'Initiated data portability export.' },
        });

        // 2. Enqueue Asynchronous Export Job (Leveraging Task 62 logic/job type)
        const job = await jobService.enqueueJob({
            type: 'export.user_data', // New job type
            payload: { userId, format: 'ndjson', requesterId: userId },
            priority: 30, 
            createdBy: userId,
        });

        return job.jobId;
    }
}
```

#### **87.2. `src/controllers/auth.controller.ts` (Updates)**

```typescript
// src/controllers/auth.controller.ts (partial update)
// ... (Imports, authService initialization, previous controllers) ...

// --- GDPR Controllers ---

/** Initiates user data deletion. DELETE /auth/me/data */
export const requestDeletionController = async (req: Request, res: Response) => {
    // 1. Authorization (Self-service check via token)
    if (!req.user) { return res.status(401).send(); }
    
    try {
        const jobId = await authService.requestDataDeletion(req.user.sub);

        // 2. Success (202 Accepted)
        return res.status(202).json({
            status: 'accepted',
            message: 'Data deletion process initiated. Your account will be marked for deletion shortly.',
            jobId: jobId,
        });
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error requesting deletion.' } });
    }
};

/** Initiates user data export. GET /auth/me/data/export */
export const requestExportController = async (req: Request, res: Response) => {
    // 1. Authorization (Self-service check via token)
    if (!req.user) { return res.status(401).send(); }
    
    try {
        const jobId = await authService.requestDataExport(req.user.sub);

        // 2. Success (202 Accepted)
        return res.status(202).json({
            status: 'accepted',
            message: 'Data export job successfully queued. You will be notified when the download link is ready.',
            jobId: jobId,
        });
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error queuing data export.' } });
    }
};
```

#### **87.3. `src/routes/auth.routes.ts` (Updates)**

```typescript
// src/routes/auth.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 73) ...
import { requestDeletionController, requestExportController } from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();

// ... (All other Task 1-73 endpoints) ...


// --- GDPR / Data Management Endpoints (Task 87) ---

// DELETE /auth/me/data - Request account deletion (Right to be Forgotten)
router.delete(
    '/me/data',
    authenticate,
    requestDeletionController
);

// GET /auth/me/data/export - Request data export (Right to Portability)
router.get(
    '/me/data/export',
    authenticate,
    requestExportController
);


export default router;
```

#### **87.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T87.1** | `DELETE /auth/me/data` | Happy Path: Deletion Request | Auth User | **202 Accepted** | `UserModel.status` is 'deleted'; all sessions for user are revoked. |
| **T87.2** | `DELETE /auth/me/data` | Fail: Not Authenticated | Anonymous | **401 Unauthorized** | N/A |
| **T87.3** | `GET /auth/me/data/export` | Happy Path: Export Request | Auth User | **202 Accepted** | `job.export.user_data` job type is successfully enqueued. |
| **T87.4** | `DB Check` | Audit Trail | T87.1 success | `AuditLog` written for `user.deletion.requested`. |

---
