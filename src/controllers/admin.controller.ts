// src/controllers/admin.controller.ts
import { Request, Response } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { PaymentService } from '../services/payment.service';
import { RevenueService } from '../services/revenue.service';
import { DiscoveryService } from '../services/discovery.service';
import { JobService } from '../services/job.service';
import { AuditService } from '../services/audit.service';
import { ModerationService } from '../services/moderation.service';
import { AdminService } from '../services/admin.service';
import { UserSettingsService } from '../services/userSettings.service';
import { UserModel } from '../models/user.model';
import { updateRankingWeights, IRankingWeights } from '../config/rankingWeights';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';
import { IUser } from '../models/user.model';

const paymentService = new PaymentService();
const revenueService = new RevenueService();
const discoveryService = new DiscoveryService();
const jobService = new JobService();
const auditService = new AuditService();
const moderationService = new ModerationService();
const adminService = new AdminService();
const userSettingsService = new UserSettingsService();

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

// --- Validation Middleware (Audit Log) ---

export const logAuditValidation = [
  body('resourceType').isString().withMessage('Resource type is required.'),
  body('action').isString().isLength({ min: 5 }).withMessage('Action is required (minimum 5 characters).'),
  body('resourceId').optional().isMongoId().withMessage('Resource ID must be a valid Mongo ID.'),
  body('actorId').optional().isMongoId().withMessage('Actor ID must be a valid Mongo ID.'),
  body('details').isObject().withMessage('Details object is required.'),
];

export const auditQueryValidation = [
  query('from').optional().isISO8601().withMessage('From date must be valid ISO 8601.'),
  query('to').optional().isISO8601().withMessage('To date must be valid ISO 8601.'),
  query('action').optional().isString().withMessage('Action filter must be a string.'),
  query('resourceType').optional().isString().withMessage('Resource type filter must be a string.'),
  query('resourceId').optional().isMongoId().withMessage('Resource ID must be a valid Mongo ID.'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const auditExportValidation = [
  body('filters').isObject().withMessage('Filters object is required.'),
  body('format').isIn(['csv', 'pdf', 'ndjson']).withMessage('Format must be csv, pdf, or ndjson.'),
];

export const reportContentValidation = [
  body('resourceType').isIn(['project', 'asset', 'user', 'comment', 'other']).withMessage('Invalid resource type.'),
  body('resourceId').isMongoId().withMessage('Resource ID must be a valid Mongo ID.'),
  body('reason').isString().isLength({ min: 10 }).withMessage('Reason is required (min 10 chars).'),
  body('evidenceAssetIds').optional().isArray().withMessage('Evidence must be an array of asset IDs.'),
  body('severity').optional().isIn(['low', 'medium', 'high', 'legal']).withMessage('Invalid severity level.'),
];

export const moderationQueueValidation = [
  query('status').optional().isIn(['open', 'in_review', 'actioned', 'closed']).withMessage('Invalid status filter.'),
  query('severity').optional().isIn(['low', 'medium', 'high', 'legal']).withMessage('Invalid severity filter.'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const takeActionValidation = [
  param('modId').isString().withMessage('Moderation ID is required.'),
  body('action').isIn(['takedown', 'suspend_user', 'warn', 'no_action', 'escalate']).withMessage('Invalid moderation action.'),
  body('notes').isString().isLength({ min: 5 }).withMessage('Notes are required for action (min 5 chars).'),
];

export const adminUserListValidation = [
  query('status').optional().isIn(['active', 'pending', 'suspended', 'deleted']).withMessage('Invalid status filter.'),
  query('role').optional().isIn(['creator', 'owner', 'admin']).withMessage('Invalid role filter.'),
  query('q').optional().isString().withMessage('Search query must be a string.'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const updateRoleValidation = [
  param('userId').isMongoId().withMessage('Invalid User ID format.'),
  body('newRole').isIn(['creator', 'owner', 'admin']).withMessage('Invalid role provided.'),
];

export const disputeQueueValidation = [
  query('status').optional().isIn(['open', 'under_review', 'resolved', 'escalated', 'closed']).withMessage('Invalid dispute status filter.'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const resolveDisputeValidation = [
  param('disputeId').isString().withMessage('Dispute ID is required.'),
  body('resolution').isIn(['release', 'refund', 'split', 'deny']).withMessage('Invalid resolution outcome.'),
  body('notes').isString().isLength({ min: 10 }).withMessage('Notes are required for resolution (min 10 chars).'),
  body('releaseAmount').optional().isInt({ min: 0 }).toInt().withMessage('Release amount must be non-negative integer.'),
  body('refundAmount').optional().isInt({ min: 0 }).toInt().withMessage('Refund amount must be non-negative integer.'),
];

export const financeReportValidation = [
  query('from').isISO8601().toDate().withMessage('From date must be valid ISO 8601.').bail(),
  query('to').isISO8601().toDate().withMessage('To date must be valid ISO 8601.').bail(),
  query('export').optional().isBoolean().withMessage('Export must be boolean.'),
];

export const updatePayoutStatusValidation = [
  param('userId').isMongoId().withMessage('Invalid User ID format.').bail(),
  body('isVerified').isBoolean().withMessage('isVerified flag is required.'),
  body('providerAccountId').isString().isLength({ min: 5 }).withMessage('Provider Account ID is required (min 5 chars).'),
  body('reason').isString().isLength({ min: 10 }).withMessage('Reason for action is required (min 10 chars).'),
];

// --- Admin Audit Controller ---

/** Writes an immutable audit log entry. POST /audit */
export const logAuditController = async (req: Request, res: Response): Promise<void> => {
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
    if (!req.user || !req.user.sub) {
      return ResponseBuilder.error(
        res,
        ErrorCode.UNAUTHORIZED,
        'Authentication required.',
        401
      );
    }

    // Use authenticated system/admin ID as the default actor
    const actorId = req.user.sub;
    const actorRole = req.user.role;

    // Service Call (Performs hashing and saves)
    const savedLog = await auditService.logAuditEntry({
      ...req.body,
      actorId,
      actorRole,
      ip: req.ip,
    });

    // Success (201 Created)
    return ResponseBuilder.success(
      res,
      {
        auditId: savedLog.auditId,
        resourceType: savedLog.resourceType,
        action: savedLog.action,
        hash: savedLog.hash,
        timestamp: savedLog.timestamp.toISOString(),
        previousHash: savedLog.previousHash,
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // High likelihood of a concurrency/DB error during save (E11000 - unique hash collision)
    if (errorMessage.includes('E11000') || errorMessage.includes('duplicate')) {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'Audit log hash collision detected. Retry may be required.',
        409
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error saving immutable log.',
      500
    );
  }
};

/** Queries the audit log ledger. GET /admin/audit-logs */
export const queryAuditLogsController = async (req: Request, res: Response): Promise<void> => {
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
    // Service handles query
    const list = await auditService.queryAuditLogs(req.query);

    return ResponseBuilder.success(res, list, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error querying audit logs.',
      500
    );
  }
};

/** Initiates an audit log export job. POST /admin/audit-logs/export */
export const exportAuditLogsController = async (req: Request, res: Response): Promise<void> => {
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
    if (!req.user || !req.user.sub) {
      return ResponseBuilder.error(
        res,
        ErrorCode.UNAUTHORIZED,
        'Authentication required.',
        401
      );
    }

    const requesterId = req.user.sub;
    const { filters, format } = req.body;

    // Service queues the export job
    const { jobId } = await auditService.exportAuditLogs(filters, format, requesterId);

    // 202 Accepted: job queued
    return ResponseBuilder.success(
      res,
      {
        jobId,
        status: 'queued',
        message: 'Audit log export job successfully queued. You will be notified upon completion.',
      },
      202
    );
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error queuing export job.',
      500
    );
  }
};

/** Allows users (or public) to report content. POST /moderation/report */
export const reportContentController = async (req: Request, res: Response): Promise<void> => {
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
    // Reporter ID is optional (public report), but grab if authenticated
    const reporterId = req.user?.sub || null;

    const record = await moderationService.reportContent(reporterId, req.body);

    return ResponseBuilder.success(
      res,
      {
        modId: record.modId,
        status: record.status,
        message: 'Report filed successfully. Thank you.',
      },
      201
    );
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error filing report.',
      500
    );
  }
};

/** Admin retrieves the moderation queue. GET /admin/moderation/queue */
export const getModerationQueueController = async (req: Request, res: Response): Promise<void> => {
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
    const queue = await moderationService.getModerationQueue(req.query);
    return ResponseBuilder.success(res, queue, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving moderation queue.',
      500
    );
  }
};

/** Admin takes action on a reported record. POST /admin/moderation/:modId/action */
export const takeActionController = async (req: Request, res: Response): Promise<void> => {
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
    if (!req.user || !req.user.sub) {
      return ResponseBuilder.error(res, ErrorCode.UNAUTHORIZED, 'Authentication required.', 401);
    }

    const { modId } = req.params;
    const { action, notes } = req.body as { action?: string; notes?: string };
    const adminId = req.user.sub!; // Already checked above

    if (!action || !notes || typeof action !== 'string' || typeof notes !== 'string') {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Action and notes are required.', 422);
    }

    // TypeScript narrowing - after the check, action and notes are guaranteed to be strings
    const typedAction = action as 'takedown' | 'suspend_user' | 'warn' | 'no_action' | 'escalate';
    const typedNotes = notes as string;

    const updatedRecord = await moderationService.takeAction(modId!, adminId, typedAction, typedNotes);

    return ResponseBuilder.success(
      res,
      {
        modId: updatedRecord.modId,
        status: updatedRecord.status,
        actionTaken: action,
        message: 'Action recorded successfully. Downstream system calls may be initiated.',
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'RecordNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Moderation record not found.', 404);
    }
    if (errorMessage === 'RecordAlreadyProcessed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'This report has already been actioned or closed.',
        409
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error taking action.',
      500
    );
  }
};

/** Lists all users. GET /admin/users */
export const listAdminUsersController = async (req: Request, res: Response): Promise<void> => {
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
    const list = await adminService.listAllUsers(req.query);
    return ResponseBuilder.success(res, list, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error listing users.',
      500
    );
  }
};

/** Updates a user's role. PUT /admin/users/:userId/role */
export const updateAdminUserRoleController = async (req: Request, res: Response): Promise<void> => {
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
    if (!req.user || !req.user.sub) {
      return ResponseBuilder.error(res, ErrorCode.UNAUTHORIZED, 'Authentication required.', 401);
    }

    const { userId } = req.params;
    const { newRole } = req.body as { newRole?: string };
    const adminId = req.user.sub!;

    if (!newRole || typeof newRole !== 'string') {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'New role is required.', 422);
    }

    // Get old role before update
    const oldRole = await UserModel.findById(userId).select('role').lean();
    const oldRoleValue = oldRole ? (oldRole as any).role : null;

    const updatedUser = await adminService.updateUserRole(userId!, newRole as IUser['role'], adminId);

    return ResponseBuilder.success(
      res,
      {
        userId: updatedUser._id!.toString(),
        oldRole: oldRoleValue,
        newRole: newRole,
        message: 'User role updated successfully.',
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Target user account not found.', 404);
    }
    if (errorMessage === 'SelfDemotionForbidden') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'Admin cannot demote themselves from the admin role.',
        403
      );
    }
    if (errorMessage === 'UpdateFailed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Failed to update user role.',
        500
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error updating user role.',
      500
    );
  }
};

/** Retrieves the dispute queue. GET /admin/disputes/queue */
export const getDisputeQueueController = async (req: Request, res: Response): Promise<void> => {
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
    const queue = await adminService.getDisputeQueue(req.query);
    return ResponseBuilder.success(res, queue, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving dispute queue.',
      500
    );
  }
};

/** Manually resolves a dispute. POST /admin/disputes/:disputeId/resolve */
export const resolveDisputeController = async (req: Request, res: Response): Promise<void> => {
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
    if (!req.user || !req.user.sub) {
      return ResponseBuilder.error(res, ErrorCode.UNAUTHORIZED, 'Authentication required.', 401);
    }

    const { disputeId } = req.params;
    const adminId = req.user.sub!;
    const { resolution, releaseAmount, refundAmount, notes } = req.body as {
      resolution?: string;
      releaseAmount?: number;
      refundAmount?: number;
      notes?: string;
    };

    if (!resolution || !notes || typeof resolution !== 'string' || typeof notes !== 'string') {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Resolution and notes are required.', 422);
    }

    const resolutionData = {
      resolution: resolution as 'release' | 'refund' | 'split' | 'deny',
      releaseAmount: releaseAmount ? parseInt(releaseAmount.toString()) : undefined,
      refundAmount: refundAmount ? parseInt(refundAmount.toString()) : undefined,
      notes,
    };

    const updatedDispute = await adminService.resolveDispute(disputeId!, adminId, resolutionData);

    return ResponseBuilder.success(
      res,
      {
        disputeId: updatedDispute.disputeId,
        status: updatedDispute.status,
        resolution: updatedDispute.resolution
          ? {
              outcome: updatedDispute.resolution.outcome,
              resolvedAmount: updatedDispute.resolution.resolvedAmount,
              refundAmount: updatedDispute.resolution.refundAmount,
              notes: updatedDispute.resolution.notes,
              resolvedAt: updatedDispute.resolution.resolvedAt.toISOString(),
            }
          : undefined,
        message: 'Dispute successfully resolved and financial actions initiated.',
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'DisputeNotFoundOrResolved') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Dispute not found or already resolved.', 404);
    }
    if (errorMessage === 'EscrowNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Escrow associated with dispute not found.', 404);
    }

    // Future: Catch specific financial errors (e.g., Funds not available)
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error resolving dispute.',
      500
    );
  }
};

/** Generates and returns a financial report. GET /admin/reports/finance */
export const getFinanceReportController = async (req: Request, res: Response): Promise<void> => {
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
      return ResponseBuilder.error(res, ErrorCode.UNAUTHORIZED, 'Authentication required.', 401);
    }

    const requesterId = req.user.sub;

    const { from, to, export: exportFlag } = req.query as any;

    const filters = {
      from: new Date(from as string),
      to: new Date(to as string),
      export: exportFlag === 'true' || exportFlag === true,
    };

    // Service handles aggregation and optional job queuing
    const report = await adminService.getFinanceReport(filters, requesterId);

    // If export was triggered, return 202 Accepted, else 200 OK
    if (filters.export) {
      return ResponseBuilder.success(res, report, 202);
    }

    return ResponseBuilder.success(res, report, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error generating report.',
      500
    );
  }
};

/** Admin updates a user's payout status/KYC. PUT /admin/users/:userId/payout-status */
export const updatePayoutStatusController = async (req: Request, res: Response): Promise<void> => {
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
    if (!req.user || !req.user.sub) {
      return ResponseBuilder.error(res, ErrorCode.UNAUTHORIZED, 'Authentication required.', 401);
    }

    const targetUserId = req.params.userId;
    const adminId = req.user.sub!;

    const { isVerified, providerAccountId, reason } = req.body as {
      isVerified?: boolean;
      providerAccountId?: string;
      reason?: string;
    };

    if (
      isVerified === undefined ||
      typeof isVerified !== 'boolean' ||
      !providerAccountId ||
      !reason ||
      typeof providerAccountId !== 'string' ||
      typeof reason !== 'string'
    ) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'isVerified, providerAccountId, and reason are required.', 422);
    }

    const updatedSettings = await userSettingsService.updatePayoutStatus(
      targetUserId!,
      adminId,
      {
        isVerified,
        providerAccountId: providerAccountId as string,
        reason: reason as string,
      }
    );

    return ResponseBuilder.success(
      res,
      {
        userId: targetUserId,
        isVerified: updatedSettings.payoutMethod?.isVerified,
        providerAccountId: updatedSettings.payoutMethod?.providerAccountId,
        message: `Payout status updated to verified=${updatedSettings.payoutMethod?.isVerified}.`,
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Target user account not found.', 404);
    }
    if (errorMessage === 'UpdateFailed') {
      return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'User settings update failed.', 500);
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error updating payout status.',
      500
    );
  }
};

