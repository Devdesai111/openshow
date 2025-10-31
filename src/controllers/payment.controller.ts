// src/controllers/payment.controller.ts
import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
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

