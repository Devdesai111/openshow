import { Request, Response } from 'express';
import { param, body, validationResult } from 'express-validator';
import { AgreementService } from '../services/agreement.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const agreementService = new AgreementService();

// --- Validation Middleware ---

export const generateAgreementValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
  body('title').isString().isLength({ min: 5 }).withMessage('Agreement title is required.'),
  body('signers').isArray({ min: 1 }).withMessage('At least one signer is required.'),
  body('signers.*.email').isEmail().withMessage('Signer email is required and must be valid.'),
  body('payloadJson.licenseType').isString().withMessage('License type must be defined in payload.'),
  // NOTE: Further validation on revenue splits and other payload fields can be added here
];

/** Generates an agreement draft. POST /projects/:projectId/agreements/generate */
export const generateAgreementController = async (req: Request, res: Response): Promise<void> => {
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

  try {
    const { projectId } = req.params as { projectId: string };
    const result = await agreementService.generateAgreementDraft(projectId, requesterId, req.body);

    return ResponseBuilder.success(
      res,
      {
        agreementId: result.agreementId,
        projectId: result.projectId.toString(),
        title: result.title,
        status: result.status,
        version: result.version,
        previewHtml: result.previewHtml,
        createdAt: result.createdAt!.toISOString(),
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'Only the project owner can generate legal documents.',
        403
      );
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Project not found.', 404);
    }
    if (errorMessage === 'SignersInvalid') {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'The list of signers is invalid or empty.',
        422
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error generating agreement draft.',
      500
    );
  }
};

