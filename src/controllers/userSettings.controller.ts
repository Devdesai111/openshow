// src/controllers/userSettings.controller.ts
import { Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { UserSettingsService } from '../services/userSettings.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';
import { serializeDocument } from '../utils/serialize';

const userSettingsService = new UserSettingsService();

// --- Validation Middleware ---

export const settingsSelfParamValidation = [
  param('userId').isMongoId().withMessage('Invalid User ID format.'),
];

export const settingsUpdateValidation = [
  // Notification Prefs validation
  body('notificationPrefs').optional().isObject().withMessage('Notification preferences must be an object.'),
  body('notificationPrefs.in_app').optional().isBoolean().withMessage('in_app must be a boolean.'),
  body('notificationPrefs.email').optional().isBoolean().withMessage('email must be a boolean.'),
  body('notificationPrefs.push').optional().isBoolean().withMessage('push must be a boolean.'),

  // Payout Method validation
  body('payoutMethod').optional().isObject().withMessage('Payout method must be an object.'),
  body('payoutMethod.type')
    .optional()
    .isIn(['stripe_connect', 'razorpay_account', 'bank_transfer'])
    .withMessage('Invalid payout method type.'),
  body('payoutMethod.details').optional().isObject().withMessage('Payout method details must be an object.'),
  body('payoutMethod.isVerified').optional().isBoolean().withMessage('isVerified must be a boolean.'),
  body('payoutMethod.providerAccountId').optional().isString().withMessage('providerAccountId must be a string.'),
];

export const pushTokenRegisterValidation = [
  body('token').isString().withMessage('Push token is required.'),
  body('deviceId').isString().withMessage('Device ID is required.'),
  body('provider').isIn(['fcm', 'apns', 'web']).withMessage('Invalid provider type.'),
];

export const pushTokenDeleteValidation = [
  body('token').isString().withMessage('Push token is required.'),
];

/** Retrieves user settings. GET /settings/:userId */
export const getSettingsController = async (req: Request, res: Response): Promise<void> => {
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
  if (!requesterId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { userId } = req.params;

    if (!userId) {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'User ID is required.',
        400
      );
    }

    // Authorization check (self-access enforced)
    if (userId !== requesterId && req.user?.role !== 'admin') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'You can only view your own settings.',
        403
      );
    }

    // Service Call (upsert if needed)
    const settings = await userSettingsService.getUserSettings(userId);

    // Security: Remove PayoutMethod details before sending to client
    const settingsDTO = serializeDocument(settings);
    if (settingsDTO.payoutMethod && (settingsDTO.payoutMethod as any).details) {
      delete (settingsDTO.payoutMethod as any).details;
    }

    return ResponseBuilder.success(res, settingsDTO, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving settings.',
      500
    );
  }
};

/** Updates user settings. PUT /settings/:userId */
export const updateSettingsController = async (req: Request, res: Response): Promise<void> => {
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
  if (!requesterId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { userId } = req.params;

    if (!userId) {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'User ID is required.',
        400
      );
    }

    // Service handles authorization check (self-access enforced)
    const updatedSettings = await userSettingsService.updateUserSettings(userId, requesterId, req.body);

    // Security: Remove PayoutMethod details before sending back
    const settingsDTO = serializeDocument(updatedSettings);
    if (settingsDTO.payoutMethod && (settingsDTO.payoutMethod as any).details) {
      delete (settingsDTO.payoutMethod as any).details;
    }

    return ResponseBuilder.success(res, settingsDTO, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'You can only update your own settings.',
        403
      );
    }
    if (errorMessage === 'UpdateFailed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Failed to update settings.',
        500
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error updating settings.',
      500
    );
  }
};

// --- Push Token Controllers (Self-Service) ---

/** Registers a new push token. POST /settings/:userId/push-token */
export const registerPushTokenController = async (req: Request, res: Response): Promise<void> => {
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
  if (!requesterId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  const { userId } = req.params;
  if (!userId) {
    return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'User ID is required.', 400);
  }

  // Self-service only check
  if (userId !== requesterId && req.user?.role !== 'admin') {
    return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'You can only manage your own push tokens.', 403);
  }

  try {
    await userSettingsService.registerPushToken(requesterId, req.body);

    // 200 OK on success/upsert
    return ResponseBuilder.success(res, { status: 'ok', message: 'Push token registered successfully.' }, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'User not found.', 404);
    }
    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error registering push token.', 500);
  }
};

/** Deletes a push token. DELETE /settings/:userId/push-token */
export const deletePushTokenController = async (req: Request, res: Response): Promise<void> => {
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
  if (!requesterId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  const { userId } = req.params;
  if (!userId) {
    return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'User ID is required.', 400);
  }

  // Self-service only check
  if (userId !== requesterId && req.user?.role !== 'admin') {
    return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'You can only manage your own push tokens.', 403);
  }

  try {
    const { token } = req.body;
    if (!token) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Push token is required in body.', 400);
    }

    await userSettingsService.deletePushToken(requesterId, token);

    // 204 No Content on successful deletion
    return ResponseBuilder.noContent(res);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage === 'TokenNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Token not found for this user/device.', 404);
    }
    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error deleting push token.', 500);
  }
};

