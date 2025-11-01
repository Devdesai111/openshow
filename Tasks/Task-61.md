Following the structured plan and maintaining the focus on compliance and reporting, we proceed with **Task 61: Audit Log Query & Export**.

This task implements the read-side of the immutable ledger, providing Admin users with the ability to query the audit trail and initiate exports, which is necessary for compliance and investigative work.

***

## **Task 61: Audit Log Query & Export**

**Goal:** Implement the Admin-only endpoints to query the audit log (`GET /admin/audit-logs`) with robust filters and to initiate an asynchronous job for data export (`POST /admin/audit-logs/export`).

**Service:** `Admin & Audit / Reporting Service`
**Phase:** D - Agreements, Licensing & Audit foundations
**Dependencies:** Task 60 (AuditLog Model), Task 52 (Jobs/Worker Queue).

**Output Files:**
1.  `src/services/audit.service.ts` (Updated: `queryAuditLogs`, `exportAuditLogs`)
2.  `src/controllers/admin.controller.ts` (Updated: new audit query/export controllers)
3.  `src/routes/admin.routes.ts` (Updated: new protected routes)
4.  `test/integration/audit_query.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query/Body) | Response (200 OK/202 Accepted) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /admin/audit-logs** | `query: { from?, action?, resourceType?, page? }` | `AuditLogListResponse` (Paginated) | Auth (Admin) |
| **POST /admin/audit-logs/export**| `{ filters: {}, format: 'csv'|'pdf' }` | `{ jobId: string, message: 'Export job queued' }` | Auth (Admin) |

**AuditLogListResponse (Excerpt):**
```json
{
  "meta": { "total": 500 },
  "data": [
    { "auditId": "audit_001", "action": "user.suspended", "timestamp": "..." }
  ]
}
```

**Runtime & Env Constraints:**
*   **Security:** Both endpoints must be strictly restricted to Admin roles (`ADMIN_DASHBOARD`).
*   **Performance:** Queries must use indexing (Task 60) for efficient filtering, especially for time-based range queries (`from`/`to`).
*   **Export:** Data export is a long-running task and **must** be implemented asynchronously via the Jobs Service (Task 52).

**Acceptance Criteria:**
*   `GET /audit-logs` successfully filters by date range, `action`, and `resourceType` and returns paginated results.
*   `POST /export` successfully queues a job (`job.export.audit` - to be registered in Task 62) and returns **202 Accepted** with a `jobId`.
*   All access attempts by non-Admin users return **403 Forbidden**.

**Tests to Generate:**
*   **Integration Test (Query):** Test filtering by time window and specific resource ID.
*   **Integration Test (Export):** Test successful job queuing and verify job payload correctness.

***

### **Task 61 Code Implementation**

#### **61.1. `src/services/audit.service.ts` (Updates)**

```typescript
// src/services/audit.service.ts (partial update)
// ... (Imports from Task 60) ...
import { JobService } from './job.service'; // Dependency on Task 52

const jobService = new JobService(); // Instantiate Job Service

interface IAuditQueryFilters {
    from?: Date;
    to?: Date;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    page?: number;
    per_page?: number;
}


export class AuditService {
    // ... (logAuditEntry, getLastLog methods from Task 60) ...

    /** Queries the immutable audit log ledger with filters. */
    public async queryAuditLogs(filters: IAuditQueryFilters): Promise<any> {
        const { from, to, action, resourceType, resourceId, page = 1, per_page = 20 } = filters;
        const limit = parseInt(per_page.toString());
        const skip = (page - 1) * limit;

        const query: any = {};
        
        // 1. Time Range Filtering (Indexed field)
        if (from || to) {
            query.timestamp = {};
            if (from) query.timestamp.$gte = from;
            if (to) query.timestamp.$lte = to;
        }

        // 2. Exact Filters (Indexed fields)
        if (action) query.action = action;
        if (resourceType) query.resourceType = resourceType;
        if (resourceId) query.resourceId = new Types.ObjectId(resourceId);

        // 3. Execution
        const [totalResults, logs] = await Promise.all([
            AuditLogModel.countDocuments(query),
            AuditLogModel.find(query)
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(limit)
                .select('-__v') // Exclude internal version key
                .lean() as Promise<IAuditLog[]>
        ]);
        
        // 4. Map to List DTO (Redacted/Simplified)
        const data = logs.map(log => ({
            auditId: log.auditId,
            resourceType: log.resourceType,
            action: log.action,
            actorId: log.actorId?.toString(),
            timestamp: log.timestamp.toISOString(),
            // NOTE: Details are kept full here as this is an Admin endpoint
            details: log.details,
            hash: log.hash.substring(0, 10) + '...',
        }));

        return {
            meta: { page, per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data,
        };
    }

    /** Initiates an asynchronous job for exporting audit logs. */
    public async exportAuditLogs(exportFilters: IAuditQueryFilters, format: string, requesterId: string): Promise<{ jobId: string }> {
        // 1. Payload and Job Type
        const jobPayload = {
            exportFilters,
            format,
            requesterId,
            requesterEmail: 'admin@example.com', // Mock email for notification
        };

        // 2. Enqueue Job (Task 52)
        const job = await jobService.enqueueJob({
            type: 'export.audit', // New job type registered in Task 62
            payload: jobPayload,
            priority: 20, // Lower priority
            createdBy: requesterId,
        });

        return { jobId: job.jobId };
    }
}
```

#### **61.2. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { body, query, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const auditQueryValidation = [
    query('from').optional().isISO8601().toDate().withMessage('From date must be valid ISO 8601.'),
    query('to').optional().isISO8601().toDate().withMessage('To date must be valid ISO 8601.'),
    query('action').optional().isString().withMessage('Action filter must be a string.'),
    query('resourceType').optional().isString().withMessage('Resource type filter must be a string.'),
    query('resourceId').optional().isMongoId().withMessage('Resource ID filter must be a valid Mongo ID.'),
    // ... (page/per_page validation reused)
];

export const auditExportValidation = [
    body('filters').isObject().withMessage('Filters object is required.'),
    body('format').isIn(['csv', 'pdf', 'ndjson']).withMessage('Format must be csv, pdf, or ndjson.'),
];


// --- Admin Audit Controllers ---

/** Queries the audit log ledger. GET /admin/audit-logs */
export const queryAuditLogsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        // Service handles query
        const list = await auditService.queryAuditLogs(req.query);
        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error querying audit logs.' } });
    }
};

/** Initiates an audit log export job. POST /admin/audit-logs/export */
export const exportAuditLogsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const requesterId = req.user!.sub;
        const { filters, format } = req.body;
        
        // Service queues the export job
        const { jobId } = await auditService.exportAuditLogs(filters, format, requesterId);

        // 202 Accepted: job queued
        return res.status(202).json({ 
            jobId, 
            status: 'queued', 
            message: 'Audit log export job successfully queued. You will be notified upon completion.' 
        });
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error queuing export job.' } });
    }
};
```

#### **61.3. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 39/42) ...
import { 
    queryAuditLogsController, exportAuditLogsController, 
    auditQueryValidation, auditExportValidation
} from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// ... (Admin Financial/Monitoring/Ranking Endpoints) ...


// --- Admin Audit Log Endpoints (Task 61) ---

// GET /admin/audit-logs - Query audit log ledger
router.get(
    '/audit-logs',
    authenticate,
    authorize(adminAccess), // RBAC check
    auditQueryValidation,
    queryAuditLogsController
);

// POST /admin/audit-logs/export - Initiate audit log export job
router.post(
    '/audit-logs/export',
    authenticate,
    authorize(adminAccess), // RBAC check
    auditExportValidation,
    exportAuditLogsController
);


export default router;
```

#### **61.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T61.1** | `GET /audit-logs` | Happy Path: Time Filter | Auth Admin, `query: { from: '2025-10-01' }` | **200 OK** | Returns filtered and paginated list. |
| **T61.2** | `GET /audit-logs` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T61.3** | `POST /export` | Happy Path: Job Queued | Auth Admin, `format: 'csv'` | **202 Accepted** | Returns `jobId` for the asynchronous export. |
| **T61.4** | `POST /export` | Fail: Invalid Format | Auth Admin, `format: 'json'` | **422 Unprocessable** | `validation_error` (Not in allowed enum). |

---
