import { Request, Response } from 'express';
import { query, validationResult } from 'express-validator';
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


