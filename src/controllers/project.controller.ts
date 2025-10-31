import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { ProjectService } from '../services/project.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const projectService = new ProjectService();

// --- Validation Middleware ---

export const createProjectValidation = [
  body('title').isString().isLength({ min: 5, max: 200 }).withMessage('Title required (5-200 chars).').bail(),
  body('description').optional().isString().isLength({ max: 2000 }).withMessage('Description max 2000 chars.'),
  body('category').isString().isLength({ min: 1, max: 100 }).withMessage('Category is required.'),
  body('visibility').optional().isIn(['public', 'private']).withMessage('Visibility must be public or private.'),
  body('collaborationType').optional().isIn(['open', 'invite']).withMessage('Collaboration type must be open or invite.'),
  body('roles').isArray({ min: 1 }).withMessage('At least one role must be defined.'),
  body('roles.*.title').isString().withMessage('Role title is required.'),
  body('roles.*.slots').isInt({ min: 1, max: 50 }).withMessage('Role slots must be between 1 and 50.'),
  body('roles.*.description').optional().isString().isLength({ max: 500 }).withMessage('Role description max 500 chars.'),
  body('roles.*.requiredSkills').optional().isArray().withMessage('Required skills must be an array.'),
  body('roles.*.requiredSkills.*').optional().isString().isLength({ max: 50 }).withMessage('Skill max 50 chars.'),
  body('revenueModel').isObject().withMessage('Revenue model is required.'),
  body('revenueModel.splits').isArray({ min: 1 }).withMessage('At least one revenue split is required.'),
  body('revenueModel.splits.*.placeholder').optional().isString().isLength({ max: 100 }).withMessage('Placeholder max 100 chars.'),
  body('revenueModel.splits.*.percentage').optional().isFloat({ min: 0, max: 100 }).withMessage('Percentage must be 0-100.'),
  body('revenueModel.splits.*.fixedAmount').optional().isFloat({ min: 0 }).withMessage('Fixed amount must be >= 0.'),
  body('milestones').optional().isArray().withMessage('Milestones must be an array.'),
  body('milestones.*.title').optional().isString().isLength({ min: 1, max: 200 }).withMessage('Milestone title required.'),
  body('milestones.*.description').optional().isString().isLength({ max: 1000 }).withMessage('Milestone description max 1000 chars.'),
  body('milestones.*.dueDate').optional().isISO8601().withMessage('Due date must be valid ISO 8601.'),
  body('milestones.*.amount').optional().isFloat({ min: 0 }).withMessage('Milestone amount must be >= 0.'),
  body('milestones.*.currency').optional().isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be 3 chars.'),
];

/** Handles project creation from the 6-step wizard payload. POST /projects */
export const createProjectController = async (req: Request, res: Response): Promise<void> => {
  // 1. Input Validation
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

  const ownerId = req.user?.sub; // Authenticated user ID
  if (!ownerId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    // 2. Service Call
    const createdProject = await projectService.createProject(ownerId, req.body);

    // 3. Success (201 Created)
    return ResponseBuilder.success(
      res,
      {
        projectId: createdProject._id?.toString(),
        ownerId: createdProject.ownerId.toString(),
        status: createdProject.status,
        createdAt: createdProject.createdAt?.toISOString(),
        message: 'Project created successfully in draft mode.',
      },
      201
    );
  } catch (error: unknown) {
    // 4. Error Handling: Catch Mongoose custom validation error from pre-save hook
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (error instanceof Error && error.name === 'ValidatorError' && errorMessage.includes('Revenue splits must sum to 100%')) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, errorMessage, 422);
    }

    if (errorMessage.includes('Revenue splits must sum to 100%')) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, errorMessage, 422);
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during project creation.',
      500
    );
  }
};
