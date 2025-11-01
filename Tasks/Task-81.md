

## **Task 81: Search Re-indexing & Admin Controls**

**Goal:** Implement the Admin interface to manage the search index: initiating a manual re-index job (`POST /admin/search/reindex`) and providing a health/status check (`GET /admin/search/status`).

**Service:** `Marketplace / Discovery / Search API`
**Phase:** I - Search, Ranking, Advanced features & ML hooks
**Dependencies:** Task 52 (Jobs/Worker Queue), Task 41 (Discovery Service Indexing API), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/discovery.service.ts` (Updated: `triggerReindexJob`, `getSearchStatus`)
2.  `src/controllers/admin.controller.ts` (Updated: new search admin controllers)
3.  `src/routes/admin.routes.ts` (Updated: new protected routes)
4.  `test/integration/search_admin.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Query) | Response (202 Accepted/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /admin/search/reindex** | `{ target: 'creators'|'projects'|'all', mode: 'full'|'incremental' }` | `{ jobId: string, status: 'queued' }` | Auth (Admin/System Only) |
| **GET /admin/search/status** | N/A | `{ status: 'ok', indexLagSeconds: number }` | Auth (Admin/System Only) |

**Runtime & Env Constraints:**
*   **Asynchronicity:** Re-indexing is a long-running, batch process and **must** be executed via the Jobs Service (Task 52).
*   **Security:** Both endpoints are strictly restricted to Admin roles (`ADMIN_DASHBOARD`).
*   **Lag Check:** The status endpoint should simulate checking the lag between the primary database update and the latest indexed document time.

**Acceptance Criteria:**
*   `POST /reindex` successfully enqueues a job (`job.reindex.batch`) and returns **202 Accepted**.
*   The job payload accurately reflects the `target` and `mode`.
*   `GET /status` returns the mocked health status and index lag metric.

**Tests to Generate:**
*   **Integration Test (Reindex):** Test Admin success (202) and verification of the job payload (for worker consumption).
*   **Integration Test (Security):** Test unauthorized access to both endpoints (403).

***

### **Task 81 Code Implementation**

#### **81.1. `src/services/discovery.service.ts` (Updates)**

```typescript
// src/services/discovery.service.ts (partial update)
// ... (Imports, DiscoveryService class definition) ...
import { JobService } from './job.service'; // Task 52 Dependency
import { ProjectModel } from '../models/project.model'; 
import { CreatorProfileModel } from '../models/creatorProfile.model';

const jobService = new JobService();

interface IReindexRequest {
    target: 'creators' | 'projects' | 'all';
    mode: 'full' | 'incremental';
}

export class DiscoveryService {
    // ... (All previous methods) ...

    /** Initiates an asynchronous job to re-index documents. */
    public async triggerReindexJob(requesterId: string, data: IReindexRequest): Promise<{ jobId: string }> {
        const { target, mode } = data;
        
        let docIds: string[] = [];

        // 1. Fetch ALL IDs for the target type (Simplified for full reindex mode)
        if (target === 'creators' || target === 'all') {
            const creatorIds = await CreatorProfileModel.find().select('_id').lean();
            docIds = docIds.concat(creatorIds.map(doc => doc._id!.toString()));
        }
        if (target === 'projects' || target === 'all') {
            const projectIds = await ProjectModel.find().select('_id').lean();
            docIds = docIds.concat(projectIds.map(doc => doc._id!.toString()));
        }
        
        if (docIds.length === 0) { throw new Error('NoDocumentsToReindex'); }

        // 2. Enqueue Batch Job (Job type registered in Task 56/62)
        const job = await jobService.enqueueJob({
            type: 'reindex.batch',
            payload: { docType: target, docIds, mode },
            priority: 10, // Low priority for batch jobs
            createdBy: requesterId,
        });

        return { jobId: job.jobId };
    }
    
    /** Retrieves the current status and health of the search index. */
    public async getSearchStatus(): Promise<any> {
        // PRODUCTION: This would query the ES/OpenSearch cluster health endpoint
        
        // Mock Health Check
        const indexOk = Math.random() > 0.1; 
        const latestDbUpdate = new Date(Date.now() - 5000); // 5 seconds ago
        const latestIndexUpdate = new Date(Date.now() - 1000); // 1 second ago

        // Mock Lag Calculation
        const indexLagSeconds = indexOk 
            ? Math.floor((latestDbUpdate.getTime() - latestIndexUpdate.getTime()) / 1000)
            : -1;

        return {
            status: indexOk ? 'ok' : 'degraded',
            message: indexOk ? 'All clusters healthy.' : 'Indexing service degraded.',
            latestIndexedTimestamp: latestIndexUpdate.toISOString(),
            indexLagSeconds: indexLagSeconds,
        };
    }
}
```

#### **81.2. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { body, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const reindexValidation = [
    body('target').isIn(['creators', 'projects', 'all']).withMessage('Invalid re-index target.'),
    body('mode').isIn(['full', 'incremental']).withMessage('Invalid re-index mode.'),
];


// --- Admin Search Controllers ---

/** Initiates a manual re-index job. POST /admin/search/reindex */
export const triggerReindexJobController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const requesterId = req.user!.sub;
        
        // Service queues the export job
        const { jobId } = await discoveryService.triggerReindexJob(requesterId, req.body);

        // 202 Accepted: job queued
        return res.status(202).json({ 
            jobId, 
            status: 'queued', 
            message: 'Re-index job successfully queued for background processing.' 
        });
    } catch (error: any) {
        if (error.message === 'NoDocumentsToReindex') { return res.status(404).json({ error: { code: 'no_data', message: 'No documents found for the specified re-index target.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error queuing re-index job.' } });
    }
};

/** Gets search index health and status. GET /admin/search/status */
export const getSearchStatusController = async (req: Request, res: Response) => {
    try {
        const status = await discoveryService.getSearchStatus();
        return res.status(200).json(status);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving search status.' } });
    }
};
```

#### **81.3. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 66/67/72) ...
import { 
    triggerReindexJobController, getSearchStatusController, 
    reindexValidation
} from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// ... (Admin Audit/Financial Endpoints) ...


// --- Admin Search Management Endpoints (Task 81) ---

// POST /admin/search/reindex - Initiate a manual re-index job
router.post(
    '/search/reindex',
    authenticate,
    authorize(adminAccess), // RBAC check
    reindexValidation,
    triggerReindexJobController
);

// GET /admin/search/status - Get current health and lag
router.get(
    '/search/status',
    authenticate,
    authorize(adminAccess),
    getSearchStatusController
);


export default router;
```

#### **81.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T81.1** | `POST /reindex` | Happy Path: Full Reindex | Auth Admin, `target: 'all', mode: 'full'` | **202 Accepted** | Returns `jobId`. |
| **T81.2** | `POST /reindex` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T81.3** | `GET /search/status` | Happy Path: Status Read | Auth Admin | **200 OK** | Returns `status: 'ok'` and `indexLagSeconds`. |
| **T81.4** | `GET /search/status` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |

---