// src/controllers/admin.controller.ts
import { Request, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { PaymentService } from '../services/payment.service';
import { RevenueService } from '../services/revenue.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const paymentService = new PaymentService();
const revenueService = new RevenueService();

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

