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

