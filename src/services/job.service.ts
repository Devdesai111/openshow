// src/services/job.service.ts
import { JobModel, IJob } from '../models/job.model';
import { Types } from 'mongoose';
import { validateJobPayload, getJobPolicy } from '../jobs/jobRegistry';
import { getExponentialBackoffDelay } from '../utils/retryPolicy';

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

        if (nextAttempt > currentJob.maxAttempts) {
            // Permanent failure: Move to DLQ
            updateFields.$set.status = 'dlq';
            // PRODUCTION: Trigger Admin Escalation
            console.error(`[Job DLQ] Job ${jobId} failed after ${nextAttempt} attempts.`);
        } else {
            // Retry: Calculate next run time
            const delay = getExponentialBackoffDelay(nextAttempt);
            if (delay === -1) {
                // Max attempts reached
                updateFields.$set.status = 'dlq';
                console.error(`[Job DLQ] Job ${jobId} failed after max attempts.`);
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
}

