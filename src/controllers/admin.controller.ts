// src/controllers/admin.controller.ts
import { Request, Response } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { PaymentService } from '../services/payment.service';
import { RevenueService } from '../services/revenue.service';
import { DiscoveryService } from '../services/discovery.service';
import { JobService } from '../services/job.service';
import { updateRankingWeights, IRankingWeights } from '../config/rankingWeights';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const paymentService = new PaymentService();
const revenueService = new RevenueService();
const discoveryService = new DiscoveryService();
const jobService = new JobService();

// --- Validation Middleware ---

export const adminLedgerValidation = [
  query('from').optional().isISO8601().withMessage('From date must be valid ISO 8601.'),
  query('to').optional().isISO8601().withMessage('To date must be valid ISO 8601.'),
  query('status').optional().isString().withMessage('Status filter must be a string.'),
  query('provider').optional().isString().withMessage('Provider filter must be a string.'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const adminBatchValidation = [
  query('projectId').optional().isMongoId().withMessage('Project ID must be valid Mongo ID.'),
  query('status').optional().isString().withMessage('Status filter must be a string.'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

// --- Admin Financial Controllers ---

/** Lists all transactions in the ledger. GET /admin/payments/ledger */
export const listAdminLedgerController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : (err as any).param || undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  try {
    const list = await paymentService.listAllLedgerTransactions(req.query);

    return ResponseBuilder.success(res, list, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error listing ledger.',
      500
    );
  }
};

/** Lists all payout batches. GET /admin/payouts/batches */
export const listAdminPayoutBatchesController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : (err as any).param || undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  try {
    const list = await revenueService.listAllPayoutBatches(req.query);

    return ResponseBuilder.success(res, list, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error listing batches.',
      500
    );
  }
};

// --- Validation Middleware ---

export const updateRankingWeightsValidation = [
  body('experimentId').isString().withMessage('Experiment ID is required.'),
  body('weights').isObject().withMessage('Weights object is required.'),
  body('weights.alpha').isFloat({ min: 0 }).withMessage('Alpha weight must be non-negative.'),
  body('weights.beta').isFloat({ min: 0 }).withMessage('Beta weight must be non-negative.'),
  body('weights.gamma').isFloat({ min: 0 }).withMessage('Gamma weight must be non-negative.'),
  body('weights.delta').isFloat({ min: 0 }).withMessage('Delta weight must be non-negative.'),
  body('weights.epsilon').isFloat({ min: 0 }).withMessage('Epsilon weight must be non-negative.'),
];

// --- Admin Ranking Controller ---

/** Admin updates the active ranking weights. PUT /admin/ranking/weights */
export const updateRankingWeightsController = async (req: Request, res: Response): Promise<void> => {
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
    const { experimentId, weights } = req.body;

    // Service Call (updates the in-memory/DB config store)
    const updatedConfig = updateRankingWeights(weights as IRankingWeights, experimentId);

    // Success (200 OK)
    return ResponseBuilder.success(
      res,
      {
        status: 'updated',
        experimentId: updatedConfig.experimentId,
        updatedAt: updatedConfig.updatedAt.toISOString(),
        activeWeights: updatedConfig.weights,
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'WeightValidationFailed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Weights must be non-negative and sum to 1.0 (or close).',
        422
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error updating ranking weights.',
      500
    );
  }
};

// --- Re-ranker Hook Validation ---

export const reRankHookValidation = [
  body('query').isString().isLength({ min: 1 }).withMessage('Query string is required.'),
  body('results').isArray({ min: 1 }).withMessage('Results array is required (minimum 1 result).'),
  body('results.*.docId').isString().withMessage('Document ID is required for each result.'),
  body('results.*.score').isFloat({ min: 0, max: 1 }).withMessage('Score must be a float between 0 and 1.'),
  body('results.*.features').optional().isObject().withMessage('Features must be an object.'),
];

// --- Admin Re-ranker Hook Controller ---

/** Admin/System manually calls the Re-ranker hook. POST /admin/search/rerank-hook */
export const reRankHookController = async (req: Request, res: Response): Promise<void> => {
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
    // Service Call (Internal call to the re-ranker utility)
    const result = await discoveryService.callReRanker(req.body);

    // Success (200 OK)
    return ResponseBuilder.success(res, result, 200);
  } catch (error: unknown) {
    // Log the severe failure of the external system
    console.error('External Re-ranker Failure:', error);
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'External re-ranker service failed to process request.',
      500
    );
  }
};

// --- Validation Middleware (Job Monitoring) ---

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
export const getJobStatusController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : (err as any).param || undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  try {
    if (!req.user || !req.user.sub) {
      return ResponseBuilder.error(
        res,
        ErrorCode.UNAUTHORIZED,
        'Authentication required.',
        401
      );
    }

    const jobId = req.params.jobId;
    if (!jobId) {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Job ID is required.',
        422
      );
    }

    const requesterId = req.user.sub;
    const requesterRole = req.user.role;
    const job = await jobService.getJobStatus(jobId, requesterId, requesterRole);
    
    return ResponseBuilder.success(res, {
      ...job,
      createdBy: job.createdBy?.toString(),
      nextRunAt: job.nextRunAt?.toISOString(),
      createdAt: job.createdAt?.toISOString(),
      updatedAt: job.updatedAt?.toISOString(),
      leaseExpiresAt: job.leaseExpiresAt?.toISOString(),
    }, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    if (errorMessage === 'PermissionDenied' || errorMessage === 'JobNotFound') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'Job not found or access denied.',
        403
      );
    }
    
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving job status.',
      500
    );
  }
};

/** Lists jobs for Admin monitoring. GET /admin/jobs/queue */
export const listAdminJobsController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : (err as any).param || undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  try {
    const list = await jobService.listAdminJobs(req.query);
    
    return ResponseBuilder.success(res, list, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error listing jobs.',
      500
    );
  }
};

/** Retrieves high-level job statistics. GET /admin/jobs/stats */
export const getJobStatsController = async (_req: Request, res: Response): Promise<void> => {
  try {
    const stats = await jobService.getJobStats();
    
    return ResponseBuilder.success(res, stats, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving job statistics.',
      500
    );
  }
};

