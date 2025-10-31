import { Request, Response } from 'express';
import { body, param, validationResult } from 'express-validator';
import { NotificationService } from '../services/notification.service';
import { NotificationTemplateModel } from '../models/notificationTemplate.model';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const notificationService = new NotificationService();

// --- Internal/Admin-Only Route Validation ---

export const sendNotificationValidation = [
  body('templateId').isString().withMessage('Template ID is required.'),
  body('recipients').isArray({ min: 1 }).withMessage('At least one recipient is required.'),
  body('recipients.*.userId').isMongoId().withMessage('Recipient User ID must be valid Mongo ID.'),
  body('recipients.*.email').optional().isEmail().withMessage('Recipient email must be valid.'),
  body('variables').isObject().withMessage('Variables must be an object.'),
  body('scheduledAt').optional().isISO8601().toDate().withMessage('ScheduledAt must be a valid ISO 8601 date.'),
  body('channels').optional().isArray().withMessage('Channels must be an array.'),
  body('projectId').optional().isMongoId().withMessage('Project ID must be valid Mongo ID.'),
];

// NOTE: Admin/Internal routes for simplified template creation for initial testing
export const initialTemplateCreationController = async (req: Request, res: Response): Promise<void> => {
  // SECURITY: This is a placeholder for Admin/Seeding. Real production requires a secure template editor.
  try {
    const result = await NotificationTemplateModel.create(req.body);
    return ResponseBuilder.success(res, { templateId: result.templateId }, 201);
  } catch (error) {
    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Failed to create template', 500);
  }
};

/** Handles incoming requests from other services to send a notification. POST /notifications/send */
export const sendNotificationController = async (req: Request, res: Response): Promise<void> => {
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

  try {
    // 2. Service Call: Renders and Queues
    const savedNotification = await notificationService.sendTemplateNotification(req.body);

    // 3. Success (202 Accepted - task handed off to background queue)
    return ResponseBuilder.success(
      res,
      {
        notificationId: savedNotification.notificationId,
        status: savedNotification.status,
        message: 'Notification accepted and queued for rendering and dispatch.',
      },
      202
    );
  } catch (error: unknown) {
    // 4. Error Handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.startsWith('VariableMissing')) {
      const missingVar = errorMessage.split(': ')[1];
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        `Missing required template variable: ${missingVar}`,
        422
      );
    }
    if (errorMessage === 'TemplateNotFound') {
      return ResponseBuilder.error(
        res,
        ErrorCode.NOT_FOUND,
        'The specified template ID was not found or is inactive.',
        404
      );
    }
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error queuing notification.',
      500
    );
  }
};

// --- Validation Middleware ---

export const templateBaseValidation = [
  body('templateId').isString().isLength({ min: 3 }).withMessage('Template ID is required (min 3 characters).'),
  body('name').isString().isLength({ min: 1 }).withMessage('Template name is required.'),
  body('description').optional().isString().withMessage('Description must be a string.'),
  body('channels').isArray({ min: 1 }).withMessage('At least one channel is required.'),
  body('channels.*').isIn(['in_app', 'email', 'push', 'webhook']).withMessage('Invalid channel type.'),
  body('contentTemplate').isObject().withMessage('Content template is required.'),
  body('requiredVariables').isArray().withMessage('Required variables must be an array.'),
  body('defaultLocale').optional().isString().withMessage('Default locale must be a string.'),
];

export const templateIdParamValidation = [
  param('templateId').isString().withMessage('Template ID is required.'),
];

export const previewTemplateValidation = [
  body('templateId').isString().withMessage('Template ID is required.'),
  body('variables').isObject().withMessage('Variables must be an object.'),
];

// --- Admin Template Controllers ---

/** Creates a new template. POST /notifications/templates */
export const createTemplateController = async (req: Request, res: Response): Promise<void> => {
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
    const savedTemplate = await notificationService.createTemplate(req.body);

    return ResponseBuilder.success(
      res,
      {
        templateId: savedTemplate.templateId,
        version: savedTemplate.version,
        createdAt: savedTemplate.createdAt?.toISOString() || new Date().toISOString(),
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'TemplateIDConflict') {
      return ResponseBuilder.error(res, ErrorCode.CONFLICT, 'Template ID already exists.', 409);
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error creating template.',
      500
    );
  }
};

/** Previews a rendered template. POST /notifications/templates/preview */
export const previewTemplateController = async (req: Request, res: Response): Promise<void> => {
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
    const { templateId, variables } = req.body;
    const renderedContent = await notificationService.previewTemplate(templateId, variables);

    return ResponseBuilder.success(res, renderedContent, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'TemplateNotFound') {
      return ResponseBuilder.error(
        res,
        ErrorCode.NOT_FOUND,
        'Template not found or is inactive.',
        404
      );
    }
    if (errorMessage.startsWith('VariableMissing')) {
      return ResponseBuilder.error(
        res,
        ErrorCode.VALIDATION_ERROR,
        `Template rendering failed: ${errorMessage}`,
        422
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error rendering preview.',
      500
    );
  }
};

/** Deletes/Deactivates a template. DELETE /notifications/templates/:templateId */
export const deleteTemplateController = async (req: Request, res: Response): Promise<void> => {
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

  try {
    const { templateId } = req.params;
    if (!templateId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Template ID is required.', 400);
    }

    await notificationService.deleteTemplate(templateId);

    return ResponseBuilder.noContent(res);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'TemplateNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Template not found.', 404);
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error deleting template.',
      500
    );
  }
};
