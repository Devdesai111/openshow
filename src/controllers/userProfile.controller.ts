import { Request, Response } from 'express';
import { param, body, validationResult } from 'express-validator';
import { UserProfileService } from '../services/userProfile.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';
import { IUser } from '../models/user.model';

const userProfileService = new UserProfileService();

// --- Validation Middleware ---
export const userIdParamValidation = [
  param('userId').isMongoId().withMessage('Invalid User ID format.'),
];

export const profileUpdateValidation = [
  ...userIdParamValidation,
  body('preferredName')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Preferred name max 50 chars.'),
  body('fullName')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Full name max 100 chars.'),
  body('bio').optional().isString().trim().isLength({ max: 2000 }).withMessage('Bio max 2000 chars.'),
  body('headline')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 140 })
    .withMessage('Headline max 140 chars.'),
  body('languages').optional().isArray().withMessage('Languages must be an array of strings.'),
  body('skills').optional().isArray().withMessage('Skills must be an array of strings.'),
  body('categories').optional().isArray().withMessage('Categories must be an array of strings.'),
  body('hourlyRate').optional().isNumeric().withMessage('Hourly rate must be a number (in cents).'),
  body('projectRate').optional().isNumeric().withMessage('Project rate must be a number (in cents).'),
  body('locations').optional().isArray().withMessage('Locations must be an array of strings.'),
  body('availability')
    .optional()
    .isIn(['open', 'busy', 'invite-only'])
    .withMessage('Availability must be one of: open, busy, invite-only.'),
];

/**
 * Handles fetching a user profile. GET /users/:userId
 */
export const getUserController = async (req: Request, res: Response): Promise<void> => {
  // 1. Input Validation
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? err.path : undefined,
        reason: err.msg,
      }))
    );
  }

  try {
    const targetUserId = req.params.userId as string;
    const requesterId = req.user?.sub; // Optional: will be present if user is authenticated
    const requesterRole = req.user?.role as IUser['role'] | undefined;

    // 2. Service Call (uses UserDTOMapper internally)
    const profile = await userProfileService.getUserProfile(targetUserId, requesterRole, requesterId);

    // 3. Success (200 OK)
    return ResponseBuilder.success(res, profile, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.notFound(res, 'User');
    }
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error fetching profile.',
      500
    );
  }
};

/**
 * Handles updating a user profile. PUT /users/:userId
 */
export const updateUserController = async (req: Request, res: Response): Promise<void> => {
  // 1. Input Validation
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? err.path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? err.value : undefined,
      }))
    );
  }

  const targetUserId = req.params.userId as string;
  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role as IUser['role'];

  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  // 2. Security Check (RBAC Logic)
  const isOwner = targetUserId === requesterId;
  const isAdmin = requesterRole === 'admin';

  if (!isOwner && !isAdmin) {
    return ResponseBuilder.forbidden(res, 'You can only update your own profile.');
  }

  try {
    // 3. Service Call (uses UserDTOMapper internally)
    const updatedProfile = await userProfileService.updateUserProfile(
      targetUserId,
      requesterId,
      requesterRole,
      req.body
    );

    // 4. Success (200 OK)
    return ResponseBuilder.success(res, updatedProfile, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.notFound(res, 'User');
    }
    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.forbidden(res, 'Permission denied');
    }
    // Fallback
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error updating profile.',
      500
    );
  }
};

