// src/services/job.service.ts
import { JobModel, IJob } from '../models/job.model';
import { Types } from 'mongoose';
import { validateJobPayload, getJobPolicy } from '../jobs/jobRegistry';
import { getExponentialBackoffDelay } from '../utils/retryPolicy';
import { IAuthUser } from '../middleware/auth.middleware';

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

    /** Enqueues a new job with schema validation and policy application. */
    public async enqueueJob(data: IEnqueueRequestDTO): Promise<IJob> {
        const { type, payload, priority, scheduleAt, maxAttempts, createdBy } = data;
        
        // 1. VALIDATION: Check Job Type and Payload Schema (CRITICAL)
        try {
            validateJobPayload(type, payload);
        } catch (e: any) {
            if (e.message.includes('JobTypeNotFound')) {
                throw new Error('JobTypeNotFound');
            }
            throw new Error(`PayloadValidationFailed: ${e.message}`);
        }
        
        // 2. APPLY POLICY: Retrieve Max Attempts
        const policy = getJobPolicy(type);
        const finalMaxAttempts = maxAttempts || policy.maxAttempts;

        // 3. Create Job Record
        const newJob = new JobModel({
            type,
            payload,
            priority: priority || 50,
            maxAttempts: finalMaxAttempts, // Use policy value
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

    /** Reports job failure, calculates next retry time, and updates status atomically. */
    public async reportJobFailure(jobId: string, workerId: string, error: any): Promise<IJob> {
        // Use aggregation pipeline update to atomically increment attempt and calculate next state
        // This ensures all updates happen in a single atomic operation
        const errorMessage = error?.message || 'Unknown error';
        
        // Fetch the job first to get maxAttempts (needed for calculation)
        // We still need this for the retry logic, but we'll do an atomic update after
        const currentJob = await JobModel.findOne({ jobId, workerId, status: 'leased' }).lean() as IJob;
        if (!currentJob) { throw new Error('JobNotLeasedOrNotFound'); }

        const nextAttempt = currentJob.attempt + 1;
        
        // Determine next status and fields based on attempt count
        let updateFields: any = {
            $inc: { attempt: 1 }, // Atomically increment attempt
            $set: {
                lastError: { code: 'worker_fail', message: errorMessage },
            },
            $unset: {
                workerId: '', // Clear worker ID (remove field)
                leaseExpiresAt: '', // Clear lease (remove field)
            },
        };

        if (nextAttempt >= currentJob.maxAttempts) {
            // Permanent failure: Move to DLQ (check against job-specific maxAttempts)
            updateFields.$set.status = 'dlq';
            // PRODUCTION: Trigger Admin Escalation
            console.error(`[Job DLQ] Job ${jobId} failed after ${nextAttempt} attempts (max: ${currentJob.maxAttempts}).`);
        } else {
            // Retry: Calculate next run time (only if under job-specific maxAttempts)
            const delay = getExponentialBackoffDelay(nextAttempt);
            // Note: getExponentialBackoffDelay may return -1 if attempt >= global MAX_ATTEMPTS (5),
            // but we've already checked against job-specific maxAttempts above, so this should be safe
            if (delay === -1) {
                // Fallback: Max attempts reached (should not happen due to check above)
                updateFields.$set.status = 'dlq';
                console.error(`[Job DLQ] Job ${jobId} failed after max attempts (fallback check).`);
            } else {
                updateFields.$set.status = 'queued';
                updateFields.$set.nextRunAt = new Date(Date.now() + delay);
                console.warn(`[Job Retry] Job ${jobId} failed. Next run: ${updateFields.$set.nextRunAt.toISOString()}`);
            }
        }

        // Apply all updates atomically in a single operation
        const updatedJob = await JobModel.findOneAndUpdate(
            { jobId, workerId, status: 'leased' }, // Atomic check: must still be leased by this worker
            updateFields,
            { new: true }
        ).lean() as IJob;

        if (!updatedJob) {
            // Job was not found or not leased by this worker (another worker may have claimed it)
            throw new Error('JobNotLeasedOrNotFound');
        }

        // PRODUCTION: Emit 'job.failed' event
        console.log(`[Event] Job ${jobId} failed (attempt ${nextAttempt}).`);

        return updatedJob;
    }

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
        const limit = parseInt(per_page as string) || 20;
        const skip = (parseInt(page as string) - 1) * limit;

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
            meta: { page: parseInt(page as string), per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data: jobs.map(job => ({ 
                ...job, 
                createdBy: job.createdBy?.toString(), 
                nextRunAt: job.nextRunAt?.toISOString(),
                createdAt: job.createdAt?.toISOString(),
                updatedAt: job.updatedAt?.toISOString(),
                leaseExpiresAt: job.leaseExpiresAt?.toISOString(),
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

        const oldestAgeMs = oldestJob && oldestJob.createdAt ? new Date().getTime() - oldestJob.createdAt.getTime() : 0;

        // Map status counts to a convenient object
        const statusMap: Record<string, number> = {};
        statusCounts.forEach((item: { _id: string; count: number }) => {
            statusMap[item._id] = item.count;
        });

        // Get total count
        const totalJobs = await JobModel.countDocuments();

        return {
            totalJobs,
            statusCounts: statusMap,
            oldestQueuedJobAgeMs: oldestAgeMs,
        };
    }
}

