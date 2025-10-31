// src/controllers/revenue.controller.ts
import { Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { RevenueService } from '../services/revenue.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const revenueService = new RevenueService();

// --- Validation Middleware ---

export const calculateRevenueValidation = [
  body('amount').isInt({ min: 1 }).toInt().withMessage('Amount must be a positive integer (cents).').bail(),
  body('currency').isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter ISO code.'),
  body('projectId').optional().isMongoId().withMessage('Project ID must be valid Mongo ID.'),
  body('revenueModel').optional().isObject().withMessage('Revenue model must be an object.'),
  body('revenueModel.splits').optional().isArray().withMessage('Splits must be an array.'),
  // NOTE: Complex split validation is primarily handled in the service/calculator utility
];

/** Calculates the revenue split preview. POST /revenue/calculate */
export const calculatePreviewController = async (req: Request, res: Response): Promise<void> => {
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

  // NOTE: No specific check here; rely on `authenticate` middleware and owner's ability to call this.

  try {
    // Service Call
    const breakdown = await revenueService.calculateRevenueSplit(req.body);

    // Success (200 OK)
    return ResponseBuilder.success(res, breakdown, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Error Handling
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }
    if (errorMessage.includes('RevenueSplitInvalid')) {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Revenue splits must sum to 100%.',
        422
      );
    }
    if (errorMessage === 'RevenueModelNotFound') {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Revenue model not found for the project.',
        422
      );
    }
    if (errorMessage === 'PercentageModelRequired') {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Percentage-based revenue model is required.',
        422
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during revenue calculation.',
      500
    );
  }
};

// --- Payout Scheduling Validation ---

export const schedulePayoutsValidation = [
  body('escrowId').isMongoId().withMessage('Escrow ID is required and must be valid Mongo ID.'),
  body('projectId').isMongoId().withMessage('Project ID is required and must be valid Mongo ID.'),
  body('milestoneId').optional().isMongoId().withMessage('Milestone ID must be valid Mongo ID.'),
  body('amount').isInt({ min: 1 }).toInt().withMessage('Amount must be a positive integer (cents).'),
  body('currency').isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter ISO code.'),
];

/** Schedules payouts from a released escrow. POST /revenue/schedule-payouts */
export const schedulePayoutsController = async (req: Request, res: Response): Promise<void> => {
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

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  // Authorization Check: Must be System/Admin (Internal Call)
  if (requesterRole !== 'admin') {
    return ResponseBuilder.error(
      res,
      ErrorCode.PERMISSION_DENIED,
      'Access denied. Endpoint is for system/admin use only.',
      403
    );
  }

  try {
    // Service Call (Idempotency check performed inside service)
    const savedBatch = await revenueService.schedulePayouts(requesterId, req.body);

    // Success (201 Created)
    return ResponseBuilder.success(
      res,
      {
        batchId: savedBatch.batchId,
        status: savedBatch.status,
        itemsCount: savedBatch.items.length,
        estimatedTotalPayout: savedBatch.totalNet,
        message: 'Payout batch scheduled and execution job queued.',
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Error Handling
    if (errorMessage === 'PayoutAlreadyScheduled') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'Payout for this escrow is already scheduled.',
        409
      );
    }
    if (errorMessage.includes('RevenueSplitInvalid')) {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Revenue model validation failed during scheduling.',
        422
      );
    }
    if (errorMessage === 'NoRecipientsForPayout') {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'No valid recipients found for payout (all splits are placeholders).',
        422
      );
    }
    if (errorMessage === 'ProjectNotFound' || errorMessage === 'RevenueModelNotFound') {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        errorMessage === 'ProjectNotFound' ? 'Project not found.' : 'Revenue model not found for the project.',
        422
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error scheduling payouts.',
      500
    );
  }
};

// --- Validation Middleware ---

export const payoutsReadValidation = [
  query('status')
    .optional()
    .isIn(['scheduled', 'processing', 'paid', 'failed', 'cancelled', 'pending_kyc'])
    .withMessage('Invalid status filter.'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const payoutItemIdValidation = [
  param('payoutItemId').isMongoId().withMessage('Invalid Payout Item ID format.'),
];

// --- Creator Payout Controllers ---

/** Lists a creator's payouts (earnings dashboard). GET /earnings */
export const listUserPayoutsController = async (req: Request, res: Response): Promise<void> => {
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

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const list = await revenueService.listUserPayouts(requesterId, requesterRole, req.query);

    return ResponseBuilder.success(res, list, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error listing payouts.',
      500
    );
  }
};

/** Retrieves detailed payout information. GET /payouts/:id */
export const getPayoutDetailsController = async (req: Request, res: Response): Promise<void> => {
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

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { payoutItemId } = req.params;
    if (!payoutItemId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Payout Item ID is required', 400);
    }

    const payout = await revenueService.getPayoutDetails(payoutItemId, requesterId, requesterRole);

    return ResponseBuilder.success(res, payout, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PayoutNotFound' || errorMessage === 'PermissionDenied') {
      return ResponseBuilder.notFound(res, 'Payout');
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving payout details.',
      500
    );
  }
};
