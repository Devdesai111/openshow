// src/controllers/payment.controller.ts
import { Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { PaymentService } from '../services/payment.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const paymentService = new PaymentService();

// --- Validation Middleware ---

export const createPaymentIntentValidation = [
  body('projectId').isMongoId().withMessage('Project ID is required.'),
  body('milestoneId').isMongoId().withMessage('Milestone ID is required.'),
  body('amount')
    .isInt({ min: 100 })
    .toInt()
    .withMessage('Minimum payment amount is $1.00 (100 cents/paise).'),
  body('currency').isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter ISO code.'),
  body('returnUrl').optional().isURL().withMessage('Return URL must be a valid URL.'),
];

/** Creates a payment intent/checkout session. POST /payments/intents */
export const createPaymentIntentController = async (req: Request, res: Response): Promise<void> => {
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

  // Authorization Check (Payer must be authenticated)
  const payerId = req.user?.sub;
  const payerRole = req.user?.role;
  if (!payerId || !payerRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    // Service Call
    const result = await paymentService.createPaymentIntent(payerId, req.body);

    // Success (201 Created)
    return ResponseBuilder.success(res, result, 201);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Error Handling
    if (errorMessage.includes('PSP configuration') || errorMessage.includes('Unsupported PSP')) {
      return ResponseBuilder.error(
        res,
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Payment provider configuration error.',
        500
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during payment intent creation.',
      500
    );
  }
};

// --- Escrow Controllers ---

/** Locks funds into a new Escrow record. POST /payments/escrow/lock */
export const lockEscrowController = async (req: Request, res: Response): Promise<void> => {
  // NOTE: In a real app, this internal endpoint would be called by a trusted backend service (Task 35.2 webhook logic).
  // For Phase 1 testing, we expose it under Auth/Admin.

  try {
    // Service handles check that transaction already succeeded and creates escrow
    const savedEscrow = await paymentService.lockEscrow(req.body);

    // Success (201 Created)
    return ResponseBuilder.success(
      res,
      {
        escrowId: savedEscrow.escrowId,
        status: savedEscrow.status,
        message: 'Funds locked successfully and project milestone updated.',
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'EscrowAlreadyLocked') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'Escrow for this milestone is already active.',
        409
      );
    }
    if (errorMessage === 'TransactionNotSucceeded') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'The payment transaction must be marked as succeeded before locking escrow.',
        409
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error locking funds.',
      500
    );
  }
};

// --- Webhook Controller ---

/** Receives webhooks from PSPs. POST /webhooks/payments */
export const webhookController = async (req: Request, res: Response): Promise<void> => {
  // 1. Retrieve essential data for validation
  const pspSignature =
    (req.headers['stripe-signature'] as string) ||
    (req.headers['x-razorpay-signature'] as string) ||
    '';
  const provider = ((req.headers['x-psp-provider'] as string)?.toLowerCase() || 'stripe') as string; // Default to Stripe

  try {
    // 2. Service Call (handles signature, event parsing, and updates)
    await paymentService.handleWebhook(provider, req.body, pspSignature);

    // 3. Success (200 OK) - Required by PSP for acknowledgement
    res.status(200).send('OK');
    return;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // CRITICAL: Must not throw 500 on business logic error (e.g., TxnNotFound), only on system failure.
    console.warn('Webhook processing error:', errorMessage);

    if (errorMessage === 'InvalidWebhookSignature') {
      return ResponseBuilder.error(
        res,
        ErrorCode.UNAUTHORIZED,
        'Webhook signature validation failed.',
        401
      );
    }

    // Always return 200/400 for errors that aren't config/signature to prevent provider retries
    res.status(400).json({
      error: {
        code: 'webhook_fail',
        message: errorMessage,
      },
    });
    return;
  }
};

// --- Escrow Validation Middleware ---

export const escrowIdParamValidation = [
  param('escrowId').isString().withMessage('Escrow ID is required.'),
];

export const releaseEscrowValidation = [
  param('escrowId').isString().withMessage('Escrow ID is required.'),
  body('releaseAmount').optional().isInt({ min: 1 }).toInt().withMessage('Release amount must be a positive integer.'),
];

export const refundEscrowValidation = [
  param('escrowId').isString().withMessage('Escrow ID is required.'),
  body('amount').isInt({ min: 1 }).toInt().withMessage('Refund amount is required and must be a positive integer.'),
  body('reason').isString().isLength({ min: 10 }).withMessage('A reason for refund is required (minimum 10 characters).'),
];

// --- Escrow Release/Refund Controllers ---

/** Releases funds from escrow. POST /payments/escrow/:escrowId/release */
export const releaseEscrowController = async (req: Request, res: Response): Promise<void> => {
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
    const { escrowId } = req.params;
    if (!escrowId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Escrow ID is required', 400);
    }
    const result = await paymentService.releaseEscrow(escrowId, requesterId, requesterRole, req.body.releaseAmount);

    // Success (200 OK)
    return ResponseBuilder.success(
      res,
      {
        escrowId,
        status: 'release_initiated',
        jobId: result.jobId,
        message: 'Funds release confirmed and payout job scheduled.',
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied' || errorMessage === 'PermissionDeniedDisputed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'Only the project owner or admin can authorize release.',
        403
      );
    }
    if (errorMessage === 'EscrowAlreadyProcessed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'Escrow is already released or refunded.',
        409
      );
    }
    if (errorMessage === 'EscrowNotFound') {
      return ResponseBuilder.notFound(res, 'Escrow');
    }
    if (errorMessage === 'ReleaseAmountInvalid') {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Release amount exceeds the total escrow amount.',
        422
      );
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during fund release.',
      500
    );
  }
};

/** Refunds escrowed funds. POST /payments/escrow/:escrowId/refund */
export const refundEscrowController = async (req: Request, res: Response): Promise<void> => {
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
    const { escrowId } = req.params;
    if (!escrowId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Escrow ID is required', 400);
    }
    const { amount, reason } = req.body;

    const result = await paymentService.refundEscrow(escrowId, requesterId, requesterRole, amount, reason);

    // Success (200 OK)
    return ResponseBuilder.success(
      res,
      {
        escrowId,
        status: 'refund_initiated',
        providerRefundId: result.providerRefundId,
        message: 'Refund process initiated with PSP. Status will be updated via webhook.',
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'Only the project owner or admin can authorize refunds.',
        403
      );
    }
    if (errorMessage === 'EscrowAlreadyProcessed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'Escrow is already released or refunded.',
        409
      );
    }
    if (errorMessage === 'RefundAmountInvalid') {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'Refund amount exceeds the total escrow amount.',
        422
      );
    }
    if (errorMessage === 'EscrowNotFound') {
      return ResponseBuilder.notFound(res, 'Escrow');
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during refund process.',
      500
    );
  }
};

// --- Validation Middleware ---

export const listTransactionsValidation = [
  query('type').optional().isString().withMessage('Type filter must be a string.'),
  query('status').optional().isString().withMessage('Status filter must be a string.'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const transactionIdParamValidation = [
  param('transactionId').isString().withMessage('Transaction ID (intentId) is required.'),
];

// --- Ledger/Query Controllers ---

/** Lists financial transactions. GET /payments/transactions */
export const listTransactionsController = async (req: Request, res: Response): Promise<void> => {
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
    // Service handles filtering based on requester role/ID
    const list = await paymentService.listTransactions(requesterId, requesterRole, req.query);

    return ResponseBuilder.success(res, list, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error listing transactions.',
      500
    );
  }
};

/** Retrieves detailed transaction information. GET /payments/transactions/:id */
export const getTransactionDetailsController = async (req: Request, res: Response): Promise<void> => {
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
    const { transactionId } = req.params;
    if (!transactionId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Transaction ID is required', 400);
    }

    const transaction = await paymentService.getTransactionDetails(transactionId, requesterId, requesterRole);

    return ResponseBuilder.success(res, transaction, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'TransactionNotFound' || errorMessage === 'PermissionDenied') {
      return ResponseBuilder.notFound(res, 'Transaction');
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving transaction details.',
      500
    );
  }
};

