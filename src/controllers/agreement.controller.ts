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

// --- Signing Validation ---

export const signAgreementValidation = [
  param('agreementId').isString().withMessage('Agreement ID is required.'),
  body('method')
    .isIn(['typed', 'complete_esign', 'initiate_esign'])
    .withMessage('Invalid signing method.'),
  body('signatureName')
    .if(body('method').equals('typed'))
    .isString()
    .isLength({ min: 1 })
    .withMessage('Signature name is required for typed signing.'),
];

/** Handles the agreement signing process. POST /agreements/:agreementId/sign */
export const signAgreementController = async (req: Request, res: Response): Promise<void> => {
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
  const requesterEmail = req.user?.email;
  if (!requesterId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { agreementId } = req.params as { agreementId: string };
    const { method, signatureName } = req.body;

    if (method === 'initiate_esign') {
      // Future Task: Call DocuSign/AdobeSign API, return provider URL/token
      return ResponseBuilder.success(
        res,
        {
          status: 'initiated',
          message: 'E-sign initiation successful. Check email for link.',
        },
        200
      );
    }

    // Use email if available, otherwise use ID
    const signerIdentifier = requesterEmail || requesterId;

    // Assume 'typed' or 'complete_esign' method for current implementation
    const updatedAgreement = await agreementService.completeSigning(
      agreementId,
      signerIdentifier,
      method as 'typed' | 'complete_esign',
      signatureName
    );

    // Success Response (200 OK)
    if (updatedAgreement.status === 'signed') {
      return ResponseBuilder.success(
        res,
        {
          agreementId: updatedAgreement.agreementId,
          status: 'signed',
          message: 'Agreement fully signed. Final PDF generation initiated.',
        },
        200
      );
    }

    return ResponseBuilder.success(
      res,
      {
        agreementId: updatedAgreement.agreementId,
        status: 'partially_signed',
        message: 'Signature recorded. Awaiting other signers.',
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'AgreementNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Agreement not found.', 404);
    }
    if (errorMessage === 'SignerNotFound') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'You are not listed as a valid signer for this document.',
        403
      );
    }
    if (errorMessage === 'AlreadySigned') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'This document has already been signed by you.',
        409
      );
    }
    if (errorMessage === 'AgreementNotInSignableState') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'Agreement cannot be signed in its current state.',
        409
      );
    }
    if (errorMessage === 'SignatureInvalid') {
      return ResponseBuilder.error(
        res,
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Failed to update signature. Please try again.',
        500
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during signing process.',
      500
    );
  }
};

