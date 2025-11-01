Following the structured plan and focusing on operational visibility, we proceed with **Task 59: Jobs Monitoring & Admin API**.

This task implements the administrative read-only endpoints required for developers and administrators to monitor the health, status, and performance of the critical background processing system.

***

## **Task 59: Jobs Monitoring & Admin API**

**Goal:** Implement Admin-only endpoints to retrieve the status of a specific job (`GET /jobs/:id`), list the job queue (`GET /admin/jobs/queue`) with filters, and provide high-level statistics/metrics (`GET /admin/jobs/stats`).

**Service:** `Jobs & Worker Queue Service`
**Phase:** F - Revenue & Payouts execution, Accounting integration
**Dependencies:** Task 54 (Job Reporting Logic), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/job.service.ts` (Updated: `getJobStatus`, `listAdminJobs`, `getJobStats`)
2.  `src/controllers/admin.controller.ts` (Updated: new job monitoring controllers)
3.  `src/routes/admin.routes.ts` (Updated: new protected routes)
4.  `test/integration/job_monitor.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /jobs/:id** | `Params: { jobId }` | `JobDetailDTO` (incl. attempts) | Auth (Owner/Admin) |
| **GET /admin/jobs/queue** | `query: { status?, type?, page? }` | `JobListResponse` (Paginated) | Auth (Admin) |
| **GET /admin/jobs/stats** | N/A | `JobStatsDTO` (Summary counts) | Auth (Admin) |

**JobStatsDTO (Excerpt):**
```json
{
  "totalJobs": 1250,
  "statusCounts": { "queued": 15, "dlq": 3, "succeeded": 1200 },
  "oldestQueuedJobAgeMs": 3600000 
}
```

**Runtime & Env Constraints:**
*   **Security:** All endpoints must be strictly restricted to Admin roles (`ADMIN_DASHBOARD`). Access to specific job details by non-Admin is limited to the job creator/owner.
*   **Performance:** `GET /admin/jobs/stats` should use fast database aggregation/counts for real-time dashboard data.
*   **Data Source:** All data is sourced from the `JobModel` and `JobAttempt` (which we will simulate/add here).

**Acceptance Criteria:**
*   `GET /jobs/:id` returns the job status and the number of attempts.
*   The `listAdminJobs` query successfully filters by `status` and `type` and returns accurate pagination metadata.
*   The `getJobStats` method returns the correct aggregated counts for all job statuses.
*   All endpoints enforce Admin access (403 Forbidden).

**Tests to Generate:**
*   **Integration Test (Stats):** Test Admin retrieval of stats (200) and verify counts are correct (mocked data).
*   **Integration Test (Queue):** Test Admin retrieval of the queue with pagination.
*   **Integration Test (Security):** Test non-Admin retrieving a job detail they didn't create (403).

***

### **Task 59 Code Implementation**

#### **59.1. `src/services/job.service.ts` (Updates)**

```typescript
// src/services/job.service.ts (partial update)
// ... (Imports from Task 54) ...

export class JobService {
    // ... (enqueueJob, leaseJob, reportJobSuccess/Failure methods) ...

    /** Retrieves the status and full details of a single job. */
    public async getJobStatus(jobId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<IJob> {
        const job = await JobModel.findOne({ jobId }).lean() as IJob;
        if (!job) { throw new Error('JobNotFound'); }
        
        // Authorization: Creator or Admin can view details
        const isCreator = job.createdBy?.toString() === requesterId;
        const isAdmin = requesterRole === 'admin';

        if (!isCreator && !isAdmin) {
            throw new Error('PermissionDenied');
        }

        return job;
    }

    /** Admin function to list jobs with filters. */
    public async listAdminJobs(queryParams: any): Promise<any> {
        const { status, type, page = 1, per_page = 20 } = queryParams;
        const limit = parseInt(per_page);
        const skip = (page - 1) * limit;

        const filters: any = {};
        if (status) filters.status = status;
        if (type) filters.type = type;
        
        // Execution
        const [totalResults, jobs] = await Promise.all([
            JobModel.countDocuments(filters),
            JobModel.find(filters)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IJob[]>
        ]);

        return {
            meta: { page, per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data: jobs.map(job => ({ 
                ...job, 
                createdBy: job.createdBy?.toString(), 
                nextRunAt: job.nextRunAt?.toISOString() 
            })),
        };
    }

    /** Admin function to retrieve high-level job statistics. */
    public async getJobStats(): Promise<any> {
        // 1. Total Counts by Status (Aggregation)
        const statusCounts = await JobModel.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);

        // 2. Oldest Queued Job Age
        const oldestJob = await JobModel.findOne({ status: 'queued' })
            .sort({ createdAt: 1 })
            .select('createdAt')
            .lean();

        const oldestAgeMs = oldestJob ? new Date().getTime() - oldestJob.createdAt!.getTime() : 0;

        // Map status counts to a convenient object
        const statusMap = statusCounts.reduce((acc, curr) => {
            acc[curr._id] = curr.count;
            return acc;
        }, {});

        return {
            totalJobs: JobModel.estimatedDocumentCount(),
            statusCounts: statusMap,
            oldestQueuedJobAgeMs: oldestAgeMs,
        };
    }
}
```

#### **59.2. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { query, param, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const jobQueueValidation = [
    query('status').optional().isString().withMessage('Status filter must be a string.'),
    query('type').optional().isString().withMessage('Type filter must be a string.'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const jobIdParamValidation = [
    param('jobId').isString().withMessage('Job ID is required.'),
];


// --- Admin Job Controllers ---

/** Retrieves the status of a single job. GET /jobs/:id */
export const getJobStatusController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid ID format.' }}); }
    
    try {
        const job = await jobService.getJobStatus(req.params.jobId, req.user!.sub, req.user!.role);
        return res.status(200).json(job);
    } catch (error: any) {
        if (error.message === 'PermissionDenied' || error.message === 'JobNotFound') { 
            return res.status(403).json({ error: { code: 'access_denied', message: 'Job not found or access denied.' } }); 
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving job status.' } });
    }
};

/** Lists jobs for Admin monitoring. GET /admin/jobs/queue */
export const listAdminJobsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const list = await jobService.listAdminJobs(req.query);
        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing jobs.' } });
    }
};

/** Retrieves high-level job statistics. GET /admin/jobs/stats */
export const getJobStatsController = async (req: Request, res: Response) => {
    try {
        const stats = await jobService.getJobStats();
        return res.status(200).json(stats);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving job statistics.' } });
    }
};
```

#### **59.3. `src/routes/job.routes.ts` (Updates)**

```typescript
// src/routes/job.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 54) ...
import { getJobStatusController } from '../controllers/admin.controller'; // Re-use Admin controller for protected read

const router = Router();
// ... (Other imports/setup) ...

// GET /jobs/:jobId - Get job status and details (Task 59)
router.get(
    '/:jobId',
    authenticate,
    jobIdParamValidation,
    // RBAC: Logic in controller allows job creator OR admin access
    getJobStatusController
);

// ... (Other Task 52/54 routes) ...
```

#### **59.4. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 39/42) ...
import { 
    listAdminJobsController, getJobStatsController, 
    jobQueueValidation
} from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// ... (Admin Financial Endpoints from Task 39) ...


// --- Admin Job Monitoring Endpoints (Task 59) ---

// GET /admin/jobs/queue - List all jobs for monitoring
router.get(
    '/jobs/queue',
    authenticate,
    authorize(adminAccess),
    jobQueueValidation,
    listAdminJobsController
);

// GET /admin/jobs/stats - High-level statistics
router.get(
    '/jobs/stats',
    authenticate,
    authorize(adminAccess),
    getJobStatsController
);


export default router;
```

#### **59.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T59.1** | `GET /jobs/queue` | Happy Path: Admin Query | Auth Admin | **200 OK** | Returns a paginated list of all jobs. |
| **T59.2** | `GET /jobs/stats` | Happy Path: Stats | Auth Admin | **200 OK** | Returns `totalJobs`, `statusCounts` breakdown. |
| **T59.3** | `GET /jobs/queue` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T59.4** | `GET /jobs/:id` | Security: Non-Creator Read | Auth User A, Job created by User B | **403 Forbidden** | `access_denied` |

---
