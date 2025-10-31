import { Router } from 'express';
import {
  sendMessageController,
  getMessagesController,
  updateMessageController,
  deleteMessageController,
  messageBodyValidation,
  messageIdParamValidation,
  projectIdParamValidation,
  getMessagesValidation,
} from '../controllers/collaboration.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// POST /projects/:projectId/messages - Send message (Task 17)
router.post(
  '/:projectId/messages',
  authenticate,
  projectIdParamValidation,
  messageBodyValidation,
  sendMessageController
);

// GET /projects/:projectId/messages - Fetch messages (Task 17)
router.get(
  '/:projectId/messages',
  authenticate,
  getMessagesValidation,
  getMessagesController
);

// PUT /projects/:projectId/messages/:messageId - Edit message (Task 17)
router.put(
  '/:projectId/messages/:messageId',
  authenticate,
  messageIdParamValidation,
  messageBodyValidation,
  updateMessageController
);

// DELETE /projects/:projectId/messages/:messageId - Delete message (Task 17)
router.delete(
  '/:projectId/messages/:messageId',
  authenticate,
  messageIdParamValidation,
  deleteMessageController
);

// NOTE: Future Activity/Reaction/Other endpoints will be added here.

export default router;
