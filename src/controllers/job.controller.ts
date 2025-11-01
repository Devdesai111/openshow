// src/controllers/job.controller.ts
import { Request, Response } from 'express';
import { body, header, query, param, validationResult } from 'express-validator';
import { JobService } from '../services/job.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const jobService = new JobService();

// --- Validation Middleware ---
export const enqueueValidation = [
    body('type').isString().isLength({ min: 3 }).withMessage('Job type is required.'),
    body('payload').isObject().withMessage('Job payload is required.'),
    body('scheduleAt').optional().isISO8601().toDate().withMessage('ScheduleAt must be a valid ISO 8601 date.'),
    body('priority').optional().isInt({ min: 0, max: 100 }).toInt(),
    body('maxAttempts').optional().isInt({ min: 1, max: 10 }).toInt(),
];

export const leaseValidation = [
    header('x-worker-id').isString().isLength({ min: 5 }).withMessage('X-Worker-Id header is required.'),
    query('type').optional().isString().withMessage('Job type filter must be a string.'),
    query('limit').optional().isInt({ min: 1, max: 10 }).toInt().default(1),
];

export const reportValidation = [
    body('result').optional().isObject().withMessage('Result must be an object for success.'),
    body('error').optional().isObject().withMessage('Error must be an object for failure.'),
];

export const reportParamValidation = [
    param('jobId').isString().withMessage('Job ID is required.'),
    header('x-worker-id').isString().isLength({ min: 5 }).withMessage('X-Worker-Id header is required.'),
];


// --- Job Controllers (Admin/System Access) ---

/** Enqueues a new job. POST /jobs */
export const enqueueController = async (req: Request, res: Response): Promise<void> => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return ResponseBuilder.validationError(
            res,
            errors.array().map(err => ({
                field: err.type === 'field' ? (err as any).path : undefined,
                reason: err.msg,
                value: err.type === 'field' ? (err as any).value : undefined,
            }))
        );
    }
    
    try {
        // Use authenticated user ID as the job creator reference
        const createdBy = req.user?.sub; 

        // 2. Service Call
        const createdJob = await jobService.enqueueJob({ ...req.body, createdBy });

        // 3. Success (201 Created)
        return ResponseBuilder.success(res, {
            jobId: createdJob.jobId,
            status: createdJob.status,
            type: createdJob.type,
            nextRunAt: createdJob.nextRunAt.toISOString(),
        }, 201);
    } catch (error: unknown) {
        // 4. ERROR HANDLING: Catch new service-level validation errors
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        if (errorMessage.includes('JobTypeNotFound')) {
            return ResponseBuilder.error(
                res,
                ErrorCode.NOT_FOUND,
                'The specified job type is not registered.',
                404
            );
        }
        if (errorMessage.includes('PayloadValidationFailed')) {
            // Extract the validation message from the error
            const validationMessage = errorMessage.replace('PayloadValidationFailed: ', '');
            return ResponseBuilder.error(
                res,
                ErrorCode.VALIDATION_ERROR,
                validationMessage,
                422
            );
        }
        
        console.error('Error enqueuing job:', errorMessage);
        return ResponseBuilder.error(
            res,
            ErrorCode.INTERNAL_SERVER_ERROR,
            'Internal server error enqueuing job.',
            500
        );
    }
};

/** Atomically leases jobs for a worker. GET /jobs/lease */
export const leaseController = async (req: Request, res: Response): Promise<void> => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return ResponseBuilder.validationError(
            res,
            errors.array().map(err => ({
                field: err.type === 'field' ? (err as any).path : undefined,
                reason: err.msg,
                value: err.type === 'field' ? (err as any).value : undefined,
            }))
        );
    }

    try {
        const workerId = req.header('x-worker-id')!;
        const { type, limit } = req.query;

        // 2. Service Call (Atomic Lease)
        const leasedJobs = await jobService.leaseJob({
            workerId,
            jobType: type as string,
            limit: limit ? Number(limit) : undefined,
        });

        // 3. Success (200 OK)
        return ResponseBuilder.success(res, {
            leasedAt: new Date().toISOString(),
            jobs: leasedJobs.map(job => ({
                jobId: job.jobId,
                type: job.type,
                payload: job.payload,
                attempt: job.attempt,
                leaseExpiresAt: job.leaseExpiresAt!.toISOString(),
            })),
        }, 200);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error leasing jobs:', errorMessage);
        return ResponseBuilder.error(
            res,
            ErrorCode.INTERNAL_SERVER_ERROR,
            'Internal server error leasing jobs.',
            500
        );
    }
};

/** Reports job success. POST /jobs/:id/succeed */
export const reportSuccessController = async (req: Request, res: Response): Promise<void> => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return ResponseBuilder.validationError(
            res,
            errors.array().map(err => ({
                field: err.type === 'field' ? (err as any).path : undefined,
                reason: err.msg,
                value: err.type === 'field' ? (err as any).value : undefined,
            }))
        );
    }
    
    try {
        const { jobId } = req.params;
        const workerId = req.header('x-worker-id')!;

        if (!jobId) {
            return ResponseBuilder.error(
                res,
                ErrorCode.VALIDATION_ERROR,
                'Job ID is required.',
                422
            );
        }

        const updatedJob = await jobService.reportJobSuccess(jobId, workerId, req.body.result || {});

        return ResponseBuilder.success(res, {
            status: 'succeeded',
            jobId: updatedJob.jobId
        }, 200);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        if (errorMessage === 'JobNotLeasedOrNotFound') {
            return ResponseBuilder.error(
                res,
                ErrorCode.CONFLICT,
                'Job not found or worker is not the current lease holder.',
                409
            );
        }
        
        console.error('Error reporting job success:', errorMessage);
        return ResponseBuilder.error(
            res,
            ErrorCode.INTERNAL_SERVER_ERROR,
            'Internal server error reporting success.',
            500
        );
    }
};

/** Reports job failure. POST /jobs/:id/fail */
export const reportFailureController = async (req: Request, res: Response): Promise<void> => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return ResponseBuilder.validationError(
            res,
            errors.array().map(err => ({
                field: err.type === 'field' ? (err as any).path : undefined,
                reason: err.msg,
                value: err.type === 'field' ? (err as any).value : undefined,
            }))
        );
    }
    
    try {
        const { jobId } = req.params;
        const workerId = req.header('x-worker-id')!;

        if (!jobId) {
            return ResponseBuilder.error(
                res,
                ErrorCode.VALIDATION_ERROR,
                'Job ID is required.',
                422
            );
        }

        const updatedJob = await jobService.reportJobFailure(jobId, workerId, req.body.error || {});

        return ResponseBuilder.success(res, {
            status: updatedJob.status,
            jobId: updatedJob.jobId,
            nextRunAt: updatedJob.nextRunAt?.toISOString(),
            attempt: updatedJob.attempt,
        }, 200);
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        if (errorMessage === 'JobNotLeasedOrNotFound') {
            return ResponseBuilder.error(
                res,
                ErrorCode.CONFLICT,
                'Job not found or worker is not the current lease holder.',
                409
            );
        }
        
        console.error('Error reporting job failure:', errorMessage);
        return ResponseBuilder.error(
            res,
            ErrorCode.INTERNAL_SERVER_ERROR,
            'Internal server error reporting failure.',
            500
        );
    }
};

