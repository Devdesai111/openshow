// src/controllers/revenue.controller.ts
import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
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

