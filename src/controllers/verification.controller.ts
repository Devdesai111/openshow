import { Request, Response } from 'express';
import { param, body, query, validationResult } from 'express-validator';
import { VerificationService } from '../services/verification.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const verificationService = new VerificationService();

// --- Validation Middleware ---

export const submitApplicationValidation = [
  body('statement').optional().isString().isLength({ max: 2000 }).withMessage('Statement max 2000 chars.'),
  body('evidence')
    .isArray({ min: 1 })
    .withMessage('At least one piece of evidence is required.')
    .bail(),
  body('evidence.*.type')
    .isIn(['portfolio', 'id_document', 'social', 'work_sample', 'other'])
    .withMessage('Invalid evidence type.'),
  body('evidence.*.assetId').optional().isMongoId().withMessage('Asset ID must be a valid Mongo ID.'),
  body('evidence.*.url').optional().isURL().withMessage('URL must be a valid URL.'),
  body('evidence.*.notes').optional().isString().isLength({ max: 1000 }).withMessage('Notes max 1000 chars.'),
  body('evidence.*').custom(value => {
    if (!value.assetId && !value.url) {
      throw new Error('Evidence must contain assetId or url.');
    }
    return true;
  }),
];

export const reviewActionValidation = [
  param('applicationId').isString().withMessage('Application ID is required.'),
  body('adminNotes').isString().isLength({ min: 10 }).withMessage('Admin notes are required for review action (min 10 chars).'),
  body('action')
    .optional()
    .isIn(['rejected', 'needs_more_info'])
    .withMessage('Action must be rejected or needs_more_info.'),
];

export const adminQueueValidation = [
  query('status')
    .optional()
    .isIn(['pending', 'needs_more_info'])
    .withMessage('Invalid status query.'),
  query('page').optional().isInt({ min: 1 }).toInt().withMessage('Page must be a positive integer.'),
  query('per_page').optional().isInt({ min: 1, max: 50 }).toInt().withMessage('Per_page must be between 1 and 50.'),
];

// --- Verification Controllers ---

/** Creator submits a verification application. POST /verification/apply */
export const submitApplicationController = async (req: Request, res: Response): Promise<void> => {
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

  const userId = req.user?.sub;
  if (!userId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const savedApp = await verificationService.submitApplication(userId, req.body);

    return ResponseBuilder.success(
      res,
      {
        applicationId: savedApp.applicationId,
        status: savedApp.status,
        submittedAt: savedApp.createdAt!.toISOString(),
        message: 'Verification application submitted successfully.',
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'ApplicationPending') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'You already have a pending application. Please await review.',
        409
      );
    }
    if (errorMessage === 'NoEvidence' || errorMessage === 'EvidenceInvalid') {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        'The application must contain at least one valid piece of evidence (with assetId or url).',
        422
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error submitting application.',
      500
    );
  }
};

/** Admin retrieves the review queue. GET /verification/queue */
export const getAdminQueueController = async (req: Request, res: Response): Promise<void> => {
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
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const status = (req.query.status as string) || 'pending';
    const page = parseInt((req.query.page as string) || '1');
    const per_page = parseInt((req.query.per_page as string) || '20');

    const queue = await verificationService.getAdminQueue(status, page, per_page);

    return ResponseBuilder.success(res, queue, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving queue.',
      500
    );
  }
};

/** Admin approves a verification application. POST /verification/:applicationId/approve */
export const approveApplicationController = async (req: Request, res: Response): Promise<void> => {
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

  const adminId = req.user?.sub;
  if (!adminId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { applicationId } = req.params as { applicationId: string };
    const updatedApp = await verificationService.approveApplication(applicationId, adminId, req.body.adminNotes);

    return ResponseBuilder.success(
      res,
      {
        applicationId: updatedApp.applicationId,
        status: 'approved',
        reviewedBy: updatedApp.reviewedBy!.toString(),
        verifiedAt: updatedApp.reviewedAt!.toISOString(),
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'ApplicationNotFoundOrProcessed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'Application not found or already approved/rejected.',
        409
      );
    }
    if (errorMessage === 'TransactionFailed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Transaction failed while updating application and profile. Admin alert issued.',
        500
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during approval.',
      500
    );
  }
};

/** Admin rejects a verification application. POST /verification/:applicationId/reject */
export const rejectApplicationController = async (req: Request, res: Response): Promise<void> => {
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

  const adminId = req.user?.sub;
  if (!adminId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { applicationId } = req.params as { applicationId: string };
    // Assume default action is 'rejected' unless specified
    const action: 'rejected' | 'needs_more_info' = (req.body.action as 'rejected' | 'needs_more_info') || 'rejected';

    const updatedApp = await verificationService.rejectApplication(applicationId, adminId, req.body.adminNotes, action);

    return ResponseBuilder.success(
      res,
      {
        applicationId: updatedApp.applicationId,
        status: updatedApp.status,
        reviewedBy: updatedApp.reviewedBy!.toString(),
        reviewedAt: updatedApp.reviewedAt!.toISOString(),
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'ApplicationNotFoundOrProcessed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'Application not found or already approved/rejected.',
        409
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during rejection.',
      500
    );
  }
};

