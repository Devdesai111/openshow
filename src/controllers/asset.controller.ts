import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AssetService } from '../services/asset.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const assetService = new AssetService();

// --- Validation Middleware ---

export const signedUploadValidation = [
  body('filename').isString().isLength({ min: 1, max: 1024 }).withMessage('Filename is required (max 1024 chars).'),
  body('mimeType').isMimeType().withMessage('Mime type is required and must be valid.'),
  body('projectId').optional().isMongoId().withMessage('Project ID must be a valid Mongo ID.'),
  body('expectedSha256').optional().isString().withMessage('SHA256 hash can be optionally provided.'),
];

export const registerAssetValidation = [
  body('assetUploadId').isString().withMessage('Asset Upload ID is required.'),
  body('storageKey').isString().withMessage('Storage key is required for registration.'),
  body('size').isInt({ min: 1 }).toInt().withMessage('File size is required and must be > 0.'),
  body('sha256').optional().isString().withMessage('SHA256 hash must be a string.'),
];

/** Handles request for a pre-signed PUT URL. POST /assets/signed-upload-url */
export const getSignedUploadUrlController = async (req: Request, res: Response): Promise<void> => {
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

  const uploaderId = req.user?.sub;
  if (!uploaderId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const result = await assetService.getSignedUploadUrl(uploaderId, req.body);
    return ResponseBuilder.success(res, result, 201);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error generating signed URL.',
      500
    );
  }
};

/** Handles registration of asset metadata after cloud upload. POST /assets/register */
export const registerAssetController = async (req: Request, res: Response): Promise<void> => {
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

  const uploaderId = req.user?.sub;
  if (!uploaderId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const result = await assetService.registerAsset(uploaderId, req.body);
    return ResponseBuilder.success(res, result, 201);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // 4. Error Handling
    if (errorMessage === 'SessionNotFoundOrUsed' || errorMessage === 'SessionExpired') {
      return ResponseBuilder.error(
        res,
        ErrorCode.NOT_FOUND,
        'Upload session not found, expired, or already used.',
        404
      );
    }
    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'Authenticated user does not own the upload session.',
        403
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during asset registration.',
      500
    );
  }
};

