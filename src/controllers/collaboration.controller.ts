import { Request, Response } from 'express';
import { param, body, query, validationResult } from 'express-validator';
import { CollaborationService } from '../services/collaboration.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const collaborationService = new CollaborationService();

// --- Validation Middleware ---

export const messageBodyValidation = [
  body('body').isString().isLength({ min: 1, max: 5000 }).withMessage('Message body is required (1-5000 chars).'),
  body('attachments').optional().isArray().withMessage('Attachments must be an array of asset IDs.'),
  body('attachments.*').optional().isMongoId().withMessage('Attachment ID must be valid Mongo ID.'),
  body('replyToMessageId').optional().isString().withMessage('Reply to message ID must be a string.'),
  body('mentionedUserIds').optional().isArray().withMessage('Mentioned user IDs must be an array.'),
  body('mentionedUserIds.*').optional().isMongoId().withMessage('Mentioned user ID must be valid Mongo ID.'),
];

export const messageIdParamValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
  param('messageId').isString().withMessage('Invalid Message ID format.').bail(),
];

export const projectIdParamValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
];

export const getMessagesValidation = [
  ...projectIdParamValidation,
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Limit must be between 1 and 100.'),
  query('before').optional().isString().withMessage('Before must be a valid message ID cursor.'),
];

// --- Message Controllers ---

/** Sends a new message. POST /projects/:id/messages */
export const sendMessageController = async (req: Request, res: Response): Promise<void> => {
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
    const { projectId } = req.params;
    if (!projectId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID is required', 400);
    }

    const savedMessage = await collaborationService.sendMessage(projectId, requesterId, requesterRole, req.body);

    return ResponseBuilder.success(
      res,
      {
        messageId: savedMessage.messageId,
        senderId: savedMessage.senderId.toString(),
        body: savedMessage.body,
        createdAt: savedMessage.createdAt!.toISOString(),
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'You must be a project member to send messages.',
        403
      );
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error sending message.',
      500
    );
  }
};

/** Retrieves paginated messages. GET /projects/:id/messages */
export const getMessagesController = async (req: Request, res: Response): Promise<void> => {
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
    const { projectId } = req.params;
    if (!projectId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID is required', 400);
    }

    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const before = req.query.before as string | undefined;

    const result = await collaborationService.getMessages(projectId, requesterId, requesterRole, limit, before);

    return ResponseBuilder.success(res, result, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'You must be a project member to view messages.',
        403
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving messages.',
      500
    );
  }
};

/** Updates a message. PUT /projects/:id/messages/:mid */
export const updateMessageController = async (req: Request, res: Response): Promise<void> => {
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
    const { projectId, messageId } = req.params;
    if (!projectId || !messageId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID and Message ID are required', 400);
    }

    if (!req.body.body) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Message body is required', 400);
    }

    const updatedMessage = await collaborationService.updateMessage(
      projectId,
      messageId,
      requesterId,
      requesterRole,
      req.body.body
    );

    return ResponseBuilder.success(
      res,
      {
        messageId: updatedMessage.messageId,
        body: updatedMessage.body,
        editedAt: updatedMessage.editedAt!.toISOString(),
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'You can only edit your own messages.',
        403
      );
    }
    if (errorMessage === 'MessageNotFound') {
      return ResponseBuilder.notFound(res, 'Message');
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error updating message.',
      500
    );
  }
};

/** Soft-deletes a message. DELETE /projects/:id/messages/:mid */
export const deleteMessageController = async (req: Request, res: Response): Promise<void> => {
  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId, messageId } = req.params;
    if (!projectId || !messageId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID and Message ID are required', 400);
    }

    await collaborationService.deleteMessage(projectId, messageId, requesterId, requesterRole);

    return ResponseBuilder.success(res, {}, 204);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'You can only delete your own messages.',
        403
      );
    }
    if (errorMessage === 'MessageNotFound') {
      return ResponseBuilder.notFound(res, 'Message');
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error deleting message.',
      500
    );
  }
};
