// src/services/job.service.ts
import { JobModel, IJob } from '../models/job.model';
import { Types } from 'mongoose';
import { validateJobPayload, getJobPolicy } from '../jobs/jobRegistry';

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
}

