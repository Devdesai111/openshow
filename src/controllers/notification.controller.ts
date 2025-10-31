import { Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
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

// --- User Interaction Validation ---

export const listNotificationsValidation = [
  query('status').optional().isIn(['read', 'unread', 'all']).withMessage('Status filter must be read, unread, or all.'),
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('per_page').optional().isInt({ min: 1, max: 50 }).toInt(),
];

export const markReadValidation = [
  body('ids').optional().isArray().withMessage('IDs must be an array of notification item IDs.'),
  body('ids.*').optional().isString().withMessage('Each ID must be a string.'),
  body('markAll').optional().isBoolean().withMessage('MarkAll must be a boolean.'),
  body().custom(value => {
    if (!value.ids && !value.markAll) {
      throw new Error('Must provide either "ids" or set "markAll" to true.');
    }
    return true;
  }),
];

// --- User Interaction Controllers ---

/** Lists a user's notifications. GET /notifications */
export const listUserNotificationsController = async (req: Request, res: Response): Promise<void> => {
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
    const list = await notificationService.listUserNotifications(requesterId, req.query);
    return ResponseBuilder.success(res, list, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error listing notifications.',
      500
    );
  }
};

/** Marks notifications as read. POST /notifications/mark-read */
export const markReadController = async (req: Request, res: Response): Promise<void> => {
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
    const { ids, markAll } = req.body;
    await notificationService.markRead(requesterId, ids || [], markAll || false);

    // Success (200 OK)
    return ResponseBuilder.success(res, { status: 'ok', message: 'Notifications updated.' }, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error marking read.',
      500
    );
  }
};

/** Retrieves the unread count. GET /notifications/unread-count */
export const getUnreadCountController = async (req: Request, res: Response): Promise<void> => {
  const requesterId = req.user?.sub;
  if (!requesterId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const unreadCount = await notificationService.getUnreadCount(requesterId);

    return ResponseBuilder.success(res, { unreadCount }, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving unread count.',
      500
    );
  }
};

// --- Email Webhook Controller ---

/** Receives webhooks from the Email Provider. POST /webhooks/notifications/email */
export const emailWebhookController = async (req: Request, res: Response): Promise<void> => {
  // 1. Retrieve Signature and Payload (Raw body is often required by PSP)
  const signature =
    (req.headers['x-email-signature'] as string) ||
    (req.headers['x-sendgrid-signature'] as string) ||
    'no-signature';

  // NOTE: In a real Express setup, you must use a middleware like body-parser.raw to get the raw body string.
  // For now, the service will JSON.stringify the payload internally for signature verification

  try {
    // 2. Service Call (handles signature, parsing, and update logic)
    await notificationService.handleEmailWebhook(req.body, signature);

    // 3. Success (200 OK) - Required by provider
    res.status(200).send('OK');
    return;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // 4. Error Handling
    if (errorMessage === 'InvalidWebhookSignature') {
      // Must return 401 on failed security check
      res.status(401).json({
        error: {
          code: 'signature_invalid',
          message: 'Webhook signature validation failed.',
        },
      });
      return;
    }
    // Return 400 on parsing/processing error, but avoid 500 for non-fatal errors
    res.status(400).json({
      error: {
        code: 'webhook_fail',
        message: 'Error processing email event.',
      },
    });
    return;
  }
};

// --- Notification Dispatch Controller ---

export const dispatchValidation = [param('notificationId').isMongoId().withMessage('Invalid Notification ID format.')];

/** Manually triggers dispatch for a single notification (Admin/Test Use). POST /notifications/:id/dispatch */
export const dispatchNotificationController = async (req: Request, res: Response): Promise<void> => {
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
    const { notificationId } = req.params;
    if (!notificationId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Notification ID is required.', 400);
    }

    const updatedNotification = await notificationService.dispatchNotification(notificationId);

    return ResponseBuilder.success(
      res,
      {
        notificationId: updatedNotification._id!.toString(),
        status: updatedNotification.status,
        message: `Dispatch complete. Final status: ${updatedNotification.status}.`,
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage === 'NotificationNotFound') {
      return ResponseBuilder.error(res, ErrorCode.NOT_FOUND, 'Notification not found.', 404);
    }
    if (errorMessage === 'NotificationNotQueued') {
      return ResponseBuilder.error(res, ErrorCode.CONFLICT, 'Notification must be in "queued" status to dispatch.', 409);
    }
    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error during dispatch.', 500);
  }
};
