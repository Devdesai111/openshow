Following the structured plan, we proceed with **Task 54: Background Job: Thumbnail Generation**.

This task implements the logic for the first functional job type in the system, utilizing the framework established in the Jobs Service (Task 52) to perform a vital asynchronous operation: asset processing.

***

## **Task 54: Background Job: Thumbnail Generation**

**Goal:** Implement the worker handler logic for the `thumbnail.create` job type, simulating the fetching of an asset, performing the processing (thumbnail generation), and correctly reporting job success/failure back to the Jobs Service.

**Service:** `Jobs & Worker Queue Service` / `File / Assets Service` (logic)
**Phase:** B - Core Platform Primitives
**Dependencies:** Task 53 (Job Registry), Task 22 (Asset Model/Service), Task 52 (Job Endpoints - for success/fail reporting).

**Output Files:**
1.  `src/jobs/handlers/thumbnailHandler.ts` (New file: Worker business logic)
2.  `src/services/job.service.ts` (Updated: `reportJobSuccess`, `reportJobFailure`)
3.  `src/controllers/job.controller.ts` (Updated: new worker report controllers)
4.  `src/routes/job.routes.ts` (Updated: new worker report routes)
5.  `test/unit/thumbnail_job.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /jobs/:id/succeed** | `{ result: { newAssetId: string } }` | `{ status: 'succeeded' }` | Auth (Worker Token) |
| **POST /jobs/:id/fail** | `{ error: { message: string } }` | `{ status: 'queued'/'failed' }` | Auth (Worker Token) |

**Worker Handler Logic (Simulated):**
*   Input: `{ assetId: string, versionNumber: number }`
*   Simulated Success: Calls asset service to update asset $\rightarrow$ Calls `POST /jobs/:id/succeed`.
*   Simulated Failure: Calls `POST /jobs/:id/fail` for retry.

**Runtime & Env Constraints:**
*   **Decoupling:** The handler must use the `AssetService` (Task 22) mock/service layer to update asset metadata.
*   **Authorization:** The worker report endpoints are restricted to internal worker tokens (Admin RBAC simulation).
*   **State Machine:** Must ensure job status is atomically updated.

**Acceptance Criteria:**
*   `POST /jobs/:id/succeed` updates the job status to `'succeeded'` and returns **200 OK**.
*   `POST /jobs/:id/fail` correctly transitions the job status to `'queued'` (for retry) and calculates the `nextRunAt` timestamp.
*   The worker logic for `thumbnailHandler` successfully updates the source asset record with the ID of the new thumbnail asset.

**Tests to Generate:**
*   **Unit Test (Success Report):** Test the success reporting controller/service updates the job in the database.
*   **Unit Test (Failure Report):** Test the failure reporting controller/service calculates the next retry time using the exponential backoff from Task 40/53.

***

### **Task 54 Code Implementation**

#### **54.1. `src/services/asset.service.ts` (Updates - For Worker Callback)**

```typescript
// src/services/asset.service.ts (partial update)
// ... (All previous imports and methods) ...

// Mock method for worker to call upon completion
export class AssetService {
    // ... (All previous methods) ...
    
    /** Worker-called method to update the source asset after processing (e.g., thumbnail). */
    public async markAssetProcessed(sourceAssetId: string, derivedAssetId: string): Promise<void> {
        const sourceId = new Types.ObjectId(sourceAssetId);
        
        await AssetModel.updateOne(
            { _id: sourceId },
            { 
                $set: { 
                    processed: true, 
                    thumbnailAssetId: new Types.ObjectId(derivedAssetId) 
                } 
            }
        );
        console.log(`[Event] Asset ${sourceAssetId} marked processed with thumbnail ${derivedAssetId}.`);
    }
}
```

#### **54.2. `src/jobs/handlers/thumbnailHandler.ts` (New Handler File)**

```typescript
// src/jobs/handlers/thumbnailHandler.ts
import { AssetService } from '../../services/asset.service';
import { IJob } from '../../models/job.model';
import crypto from 'crypto';

const assetService = new AssetService();

// Mock Library for Image Processing
const mockImageProcessor = {
    generateThumbnail: (assetId: string, size: number) => {
        // Simulates complex image processing and uploading the new asset
        console.log(`Processing thumbnail for ${assetId}...`);
        
        // Simulates a random failure 10% of the time for retry testing
        if (Math.random() < 0.1) {
            throw new Error('TransientImageProcessorError');
        }
        
        // Mock ID of the newly uploaded, derived asset
        return `derived_asset_${crypto.randomBytes(6).toString('hex')}`;
    }
};

/**
 * Worker Logic Handler for the 'thumbnail.create' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handleThumbnailJob(job: IJob): Promise<{ newAssetId: string }> {
    const { assetId, versionNumber } = job.payload;
    
    if (!assetId || !versionNumber) {
        throw new Error('JobDataMissing: Missing assetId or versionNumber.');
    }
    
    // 1. Simulate Processing and Uploading Derived Asset
    const newAssetId = mockImageProcessor.generateThumbnail(assetId, 320);

    // 2. Report Back to Asset Service (Update the Source Asset)
    await assetService.markAssetProcessed(assetId, newAssetId);

    // 3. Return the result payload
    return { newAssetId };
}
```

#### **54.3. `src/services/job.service.ts` (Updates - Reporting)**

```typescript
// src/services/job.service.ts (partial update)
// ... (Imports from Task 52, JobModel, getExponentialBackoffDelay, etc.) ...
import { getExponentialBackoffDelay } from '../utils/retryPolicy'; // Task 40 utility


export class JobService {
    // ... (enqueueJob, leaseJob methods) ...

    /** Reports job success and updates the job status atomically. */
    public async reportJobSuccess(jobId: string, workerId: string, result: any): Promise<IJob> {
        // Find job with concurrency protection (leased by this worker)
        const updatedJob = await JobModel.findOneAndUpdate(
            { jobId, workerId, status: 'leased' },
            {
                $set: {
                    status: 'succeeded',
                    result: result,
                    leaseExpiresAt: new Date(), // Release lease
                }
            },
            { new: true }
        ).lean() as IJob;
        
        if (!updatedJob) { throw new Error('JobNotLeasedOrNotFound'); }
        
        // PRODUCTION: Emit 'job.succeeded' event
        console.log(`[Event] Job ${jobId} succeeded.`);
        
        return updatedJob;
    }

    /** Reports job failure, calculates next retry time, and updates status. */
    public async reportJobFailure(jobId: string, workerId: string, error: any): Promise<IJob> {
        const job = await JobModel.findOne({ jobId, workerId, status: 'leased' });
        if (!job) { throw new Error('JobNotLeasedOrNotFound'); }

        const nextAttempt = job.attempt + 1;
        
        if (nextAttempt > job.maxAttempts) {
            // Permanent failure: Move to DLQ
            job.status = 'dlq';
            // PRODUCTION: Trigger Admin Escalation
            console.error(`[Job DLQ] Job ${jobId} failed after ${nextAttempt} attempts.`);
        } else {
            // Retry: Calculate next run time
            const delay = getExponentialBackoffDelay(nextAttempt);
            job.status = 'queued';
            job.nextRunAt = new Date(Date.now() + delay);
            job.leaseExpiresAt = undefined; // Clear lease
            console.warn(`[Job Retry] Job ${jobId} failed. Next run: ${job.nextRunAt.toISOString()}`);
        }
        
        // Update error metadata
        job.lastError = { code: 'worker_fail', message: error.message };
        job.workerId = undefined; // Clear worker ID
        
        const updatedJob = await job.save();
        
        // PRODUCTION: Emit 'job.failed' event
        eventEmitter.emit('job.failed', { jobId, attempt: nextAttempt, status: updatedJob.status });

        return updatedJob;
    }
}
```

#### **54.4. `src/controllers/job.controller.ts` (Updates - Reporting)**

```typescript
// src/controllers/job.controller.ts (partial update)
// ... (Imports, jobService initialization, enqueue/lease controllers) ...

export const reportValidation = [
    param('jobId').isString().withMessage('Job ID is required.'),
    header('x-worker-id').isString().isLength({ min: 5 }).withMessage('X-Worker-Id header is required.'),
];

/** Reports job success. POST /jobs/:id/succeed */
export const reportSuccessController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.' }}); }
    
    try {
        const { jobId } = req.params;
        const workerId = req.header('x-worker-id')!;

        const updatedJob = await jobService.reportJobSuccess(jobId, workerId, req.body.result);

        return res.status(200).json({ status: 'succeeded', jobId: updatedJob.jobId });
    } catch (error: any) {
        if (error.message === 'JobNotLeasedOrNotFound') { return res.status(409).json({ error: { code: 'lease_conflict', message: 'Job not found or worker is not the current lease holder.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error reporting success.' } });
    }
};

/** Reports job failure. POST /jobs/:id/fail */
export const reportFailureController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.' }}); }
    
    try {
        const { jobId } = req.params;
        const workerId = req.header('x-worker-id')!;

        const updatedJob = await jobService.reportJobFailure(jobId, workerId, req.body.error);

        return res.status(200).json({ 
            status: updatedJob.status, 
            jobId: updatedJob.jobId, 
            nextRunAt: updatedJob.nextRunAt!.toISOString(),
            attempt: updatedJob.attempt,
        });
    } catch (error: any) {
        if (error.message === 'JobNotLeasedOrNotFound') { return res.status(409).json({ error: { code: 'lease_conflict', message: 'Job not found or worker is not the current lease holder.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error reporting failure.' } });
    }
};
```

#### **54.4. `src/routes/job.routes.ts` (Updates)**

```typescript
// src/routes/job.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 52) ...
import { reportSuccessController, reportFailureController, reportValidation } from '../controllers/job.controller';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 

// ... (POST /jobs and GET /jobs/lease from Task 52) ...


// --- Worker Report Endpoints (Task 54) ---

// POST /jobs/:jobId/succeed - Worker reports success
router.post(
    '/:jobId/succeed',
    authenticate,
    authorize(adminAccess),
    reportValidation,
    reportSuccessController
);

// POST /jobs/:jobId/fail - Worker reports failure
router.post(
    '/:jobId/fail',
    authenticate,
    authorize(adminAccess),
    reportValidation,
    reportFailureController
);

export default router;
```

#### **54.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T54.1** | `POST /succeed` | Happy Path | Job=`leased` by `worker_a` | **200 OK** | DB `status: 'succeeded'`. |
| **T54.2** | `POST /fail` | Happy Path: Retry | Job=`leased`, `attempt < maxAttempts` | **200 OK** | DB `status: 'queued'`, `nextRunAt` updated. |
| **T54.3** | `POST /fail` | Escalation Check | Job=`leased`, `attempt = maxAttempts - 1` | **200 OK** | DB `status: 'dlq'`, `nextRunAt` is current time. |
| **T54.4** | `POST /succeed` | Fail: Lease Conflict | Job=`leased` by `worker_b` (Wrong worker ID) | **409 Conflict** | `lease_conflict` |
| **T54.5** | `Unit Test` | Handler Logic | `handleThumbnailJob` execution | N/A | `assetService.markAssetProcessed` called. |

---
