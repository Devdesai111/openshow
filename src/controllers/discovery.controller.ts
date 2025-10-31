import { Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { DiscoveryService } from '../services/discovery.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const discoveryService = new DiscoveryService();

export const searchCreatorsValidation = [
  query('skill').optional().isString().withMessage('Skill must be a string.'),
  query('verified').optional().isBoolean().withMessage('Verified must be a boolean.'),
  query('availability')
    .optional()
    .isIn(['open', 'busy', 'invite-only'])
    .withMessage('Invalid availability status.'),
  query('sort').optional().isIn(['rating', 'newest', 'relevance']).withMessage('Invalid sort parameter.'),
  query('page').optional().isInt({ min: 1 }).toInt().withMessage('Page must be a positive integer.'),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Per_page must be between 1 and 100.'),
];

export const searchCreatorsController = async (req: Request, res: Response): Promise<void> => {
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
    const results = await discoveryService.searchCreators(req.query);
    return ResponseBuilder.success(res, results, 200);
  } catch (error) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'An unexpected error occurred during creator search.',
      500
    );
  }
};

export const searchProjectsValidation = [
  query('q').optional().isString().withMessage('Query must be a string.'),
  query('category').optional().isString().withMessage('Category must be a string.'),
  query('sort').optional().isIn(['newest', 'relevance', 'budget_desc']).withMessage('Invalid sort parameter.'),
  query('page').optional().isInt({ min: 1 }).toInt().withMessage('Page must be a positive integer.'),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Per_page must be between 1 and 100.'),
];

/** Handles the search and listing of public projects. GET /market/projects */
export const searchProjectsController = async (req: Request, res: Response): Promise<void> => {
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
    const results = await discoveryService.searchProjects(req.query);
    return ResponseBuilder.success(res, results, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'An unexpected error occurred during project search.',
      500
    );
  }
};

// --- Validation Middleware ---

export const indexUpdateValidation = [
  body('docType').isIn(['creator', 'project']).withMessage('Invalid document type.'),
  body('docId').isMongoId().withMessage('Document ID must be a valid Mongo ID.'),
  body('updatedAt').isISO8601().withMessage('Updated date is required and must be ISO 8601 format.'),
  body('payload').isObject().withMessage('Payload must be an object with fields to update.'),
];

// --- Internal Indexing Controller ---

/** Internal endpoint for indexing updates. POST /search/index-update */
export const indexUpdateController = async (req: Request, res: Response): Promise<void> => {
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
    // Service Call (handles out-of-order check)
    await discoveryService.indexDocument(req.body);

    // Success (200 OK)
    return ResponseBuilder.success(
      res,
      {
        docId: req.body.docId,
        status: 'indexed',
        updatedAt: req.body.updatedAt,
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Error Handling
    if (errorMessage === 'StaleUpdate') {
      // Return 200 to the message broker/service to acknowledge the event was processed (even if skipped)
      return ResponseBuilder.success(
        res,
        {
          status: 'ignored',
          message: 'Update ignored as it is older than the current indexed document.',
        },
        200
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during indexing process.',
      500
    );
  }
};


