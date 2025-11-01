Following the structured plan, we proceed with **Task 52: Jobs & Worker Queue Core API**.

This task is **CRITICAL INFRASTRUCTURE**, establishing the central service for all asynchronous and long-running backend work (thumbnailing, payouts, reindexing, etc.). It enables the successful execution of workflows initiated in prior tasks (e.g., Task 32 Payouts, Task 28 Anchoring).

***

## **Task 52: Jobs & Worker Queue Core API**

**Goal:** Implement the `Job` model and the foundational API endpoints for the job queue: enqueueing a job (`POST /jobs`), and the pull-based lease mechanism for workers (`GET /jobs/lease`) to claim available tasks atomically.

**Service:** `Jobs & Worker Queue Service`
**Phase:** B - Core Platform Primitives
**Dependencies:** Task 1 (User Model/ID types).

**Output Files:**
1.  `src/models/job.model.ts` (New file: IJob, JobSchema/Model)
2.  `src/services/job.service.ts` (New file: `enqueueJob`, `leaseJob`)
3.  `src/controllers/job.controller.ts` (New file: job controllers)
4.  `src/routes/job.routes.ts` (New file: router for `/jobs`)
5.  `test/integration/job_queue.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Query) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /jobs** | `{ type, payload, priority? }` | `{ jobId, status: 'queued' }` | Auth (Internal/Service Token) |
| **GET /jobs/lease** | `query: { type, limit? }`, Header: `X-Worker-Id` | `{ leasedAt, jobs: [{ jobId, payload, leaseExpiresAt }] }` | Auth (Worker Token) |

**Lease Job Response (Excerpt):**
```json
{
  "leasedAt": "2025-11-01T15:00:00Z",
  "jobs": [
    { "jobId": "job_123", "type": "thumbnail.create", "leaseExpiresAt": "2025-11-01T15:05:00Z" }
  ]
}
```

**Runtime & Env Constraints:**
*   **Atomic Lease (CRITICAL):** The `GET /jobs/lease` operation must be atomic using Mongoose transactions/find-and-update to prevent multiple workers from claiming the same job simultaneously.
*   **Scheduling:** Jobs become available when `status='queued'` and `nextRunAt <= now`.
*   **Security:** Both endpoints must be protected by internal service tokens (Admin RBAC simulation). `GET /jobs/lease` requires a specific worker identifier header.

**Acceptance Criteria:**
*   `POST /jobs` successfully queues the job and sets `status='queued'` and `attempt=0`.
*   `GET /jobs/lease` atomically updates the job from `'queued'` to `'leased'`, sets `workerId` and `leaseExpiresAt`, and increments `attempt`.
*   A second call to `GET /jobs/lease` should not return a job that is currently leased.

**Tests to Generate:**
*   **Integration Test (Atomic Lease):** Test two concurrent mock workers calling `GET /jobs/lease` and verify only one job is returned, and the job status is correctly updated.
*   **Integration Test (Enqueuing):** Test scheduled job creation (setting `nextRunAt` in the future).

***

### **Task 52 Code Implementation**

#### **52.1. `src/models/job.model.ts` (New Model)**

```typescript
// src/models/job.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IJob {
  _id?: Types.ObjectId;
  jobId: string;
  type: string;
  priority: number; // 0-100 (higher = sooner)
  status: 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'dlq';
  payload: any;
  attempt: number;
  maxAttempts: number;
  nextRunAt: Date; // When job is available for processing (used for scheduling/retry)
  leaseExpiresAt?: Date; // Time worker must finish or renew
  workerId?: string;
  lastError?: { code?: string; message?: string };
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const JobSchema = new Schema<IJob>({
  jobId: { type: String, required: true, unique: true, default: () => `job_${crypto.randomBytes(6).toString('hex')}` },
  type: { type: String, required: true, index: true },
  priority: { type: Number, default: 50, index: true },
  status: { type: String, enum: ['queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled', 'dlq'], default: 'queued', index: true },
  payload: { type: Schema.Types.Mixed, required: true },
  attempt: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  nextRunAt: { type: Date, default: Date.now, index: true },
  leaseExpiresAt: { type: Date, index: true },
  workerId: { type: String },
  lastError: { type: Schema.Types.Mixed },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// PERFORMANCE: Compound index for finding next job efficiently
JobSchema.index({ status: 1, nextRunAt: 1, priority: -1 });

export const JobModel = model<IJob>('Job', JobSchema);
```

#### **52.2. `src/services/job.service.ts` (New File)**

```typescript
// src/services/job.service.ts
import { JobModel, IJob } from '../models/job.model';
import { Types } from 'mongoose';
import { getExponentialBackoffDelay } from '../utils/retryPolicy'; // Task 40 utility


const DEFAULT_LEASE_TIME_S = 300; // 5 minutes

interface IEnqueueRequestDTO {
    type: string;
    payload: any;
    priority?: number;
    scheduleAt?: Date;
    maxAttempts?: number;
    createdBy?: string;
}

interface ILeaseRequestDTO {
    workerId: string;
    jobType?: string;
    limit?: number;
    maxLeaseSeconds?: number;
}


export class JobService {

    /** Enqueues a new job into the worker queue. */
    public async enqueueJob(data: IEnqueueRequestDTO): Promise<IJob> {
        const { type, payload, priority, scheduleAt, maxAttempts, createdBy } = data;
        
        // 1. Create Job Record
        const newJob = new JobModel({
            type,
            payload,
            priority: priority || 50,
            maxAttempts: maxAttempts || 5,
            nextRunAt: scheduleAt || new Date(),
            createdBy: createdBy ? new Types.ObjectId(createdBy) : undefined,
            status: 'queued',
        });
        
        const savedJob = await newJob.save();
        
        // PRODUCTION: Emit 'job.created' event
        console.log(`[Event] Job ${savedJob.jobId} enqueued for type ${type}.`);

        return savedJob.toObject() as IJob;
    }

    /** Atomically leases available jobs for a worker (Pull Model). */
    public async leaseJob(data: ILeaseRequestDTO): Promise<IJob[]> {
        const { workerId, jobType, limit = 1, maxLeaseSeconds = DEFAULT_LEASE_TIME_S } = data;
        
        const expirationTime = new Date(Date.now() + maxLeaseSeconds * 1000);
        
        const query: any = {
            // Find jobs that are ready to be run:
            // 1. status is 'queued'
            // 2. OR status is 'leased' and lease has expired (reclaim failed worker job)
            $or: [
                { status: 'queued' },
                { status: 'leased', leaseExpiresAt: { $lte: new Date() } }
            ],
            nextRunAt: { $lte: new Date() }, // Job is scheduled to run now or earlier
        };

        if (jobType) {
            query.type = jobType;
        }

        // 1. ATOMIC FIND AND UPDATE (CRITICAL CONCURRENCY CONTROL)
        const leasedJobs: IJob[] = [];
        
        // Use a loop of findOneAndUpdate to claim jobs one-by-one up to the limit
        for (let i = 0; i < limit; i++) {
            const updatedJob = await JobModel.findOneAndUpdate(
                query,
                {
                    $set: {
                        status: 'leased',
                        workerId: workerId,
                        leaseExpiresAt: expirationTime,
                    },
                    $inc: { attempt: 1 } // Increment attempt count on claim
                },
                { 
                    new: true,
                    sort: { priority: -1, nextRunAt: 1 } // Prioritize by highest priority, then earliest run time
                }
            ).lean();

            if (updatedJob) {
                leasedJobs.push(updatedJob);
            } else {
                break; // No more jobs match the query/limit
            }
        }
        
        // 2. Return Leased Jobs
        console.log(`Worker ${workerId} leased ${leasedJobs.length} jobs.`);
        
        return leasedJobs;
    }
}
```

#### **52.3. `src/controllers/job.controller.ts` (New File)**

```typescript
// src/controllers/job.controller.ts
import { Request, Response } from 'express';
import { body, header, query, validationResult } from 'express-validator';
import { JobService } from '../services/job.service';

const jobService = new JobService();

// --- Validation Middleware ---
export const enqueueValidation = [
    body('type').isString().isLength({ min: 3 }).withMessage('Job type is required.'),
    body('payload').isObject().withMessage('Job payload is required.'),
    body('scheduleAt').optional().isISO8601().toDate().withMessage('ScheduleAt must be a valid ISO 8601 date.'),
    body('priority').optional().isInt({ min: 0, max: 100 }).toInt(),
];

export const leaseValidation = [
    header('x-worker-id').isString().isLength({ min: 5 }).withMessage('X-Worker-Id header is required.'),
    query('type').optional().isString().withMessage('Job type filter must be a string.'),
    query('limit').optional().isInt({ min: 1, max: 10 }).toInt().default(1),
];


// --- Job Controllers (Admin/System Access) ---

/** Enqueues a new job. POST /jobs */
export const enqueueController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        // Use authenticated user ID as the job creator reference
        const createdBy = req.user!.sub; 

        // 2. Service Call
        const createdJob = await jobService.enqueueJob({ ...req.body, createdBy });

        // 3. Success (201 Created)
        return res.status(201).json({
            jobId: createdJob.jobId,
            status: createdJob.status,
            type: createdJob.type,
            nextRunAt: createdJob.nextRunAt!.toISOString(),
        });
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error enqueuing job.' } });
    }
};

/** Atomically leases jobs for a worker. GET /jobs/lease */
export const leaseController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }

    try {
        const workerId = req.header('x-worker-id')!;
        const { type, limit } = req.query;

        // 2. Service Call (Atomic Lease)
        const leasedJobs = await jobService.leaseJob({
            workerId,
            jobType: type as string,
            limit: limit as number,
        });

        // 3. Success (200 OK)
        return res.status(200).json({
            leasedAt: new Date().toISOString(),
            jobs: leasedJobs.map(job => ({
                jobId: job.jobId,
                type: job.type,
                payload: job.payload,
                attempt: job.attempt,
                leaseExpiresAt: job.leaseExpiresAt!.toISOString(),
            })),
        });
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error leasing jobs.' } });
    }
};
```

#### **52.4. `src/routes/job.routes.ts` (New File)**

```typescript
// src/routes/job.routes.ts
import { Router } from 'express';
import { enqueueController, leaseController, enqueueValidation, leaseValidation } from '../controllers/job.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// --- Job Enqueue Endpoints (Task 52) ---

// POST /jobs - Enqueue a job (System/Admin access)
router.post(
    '/',
    authenticate,
    authorize(adminAccess),
    enqueueValidation,
    enqueueController
);

// GET /jobs/lease - Atomically lease a job (Worker/System access)
router.get(
    '/lease',
    authenticate,
    authorize(adminAccess), // Worker access is modeled as Admin/System
    leaseValidation,
    leaseController
);

// NOTE: Future endpoints (succeed, fail, status, requeue) will be added here.

export default router;
```

#### **52.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T52.1** | `POST /jobs` | Happy Path: Enqueue | Auth Admin, Valid Payload | **201 Created** | `status: 'queued'`, `attempt: 0`. |
| **T52.2** | `POST /jobs` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T52.3** | `GET /jobs/lease` | Happy Path: Lease Job | Auth Admin, Valid `X-Worker-Id` | **200 OK** | Returns 1 job, `status` updated to `'leased'`, `attempt: 1`. |
| **T52.4** | `Integration` | Atomic Lease Check | Two concurrent `GET /lease` calls | **200 OK** | Only 1 worker can claim a single job; other worker gets 0 jobs. |
| **T52.5** | `GET /jobs/lease` | Fail: No Ready Job | No jobs in `'queued'` or expired `'leased'` state | **200 OK** | Returns empty `jobs` array. |

---

