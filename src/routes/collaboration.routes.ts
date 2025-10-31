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
  logActivityController,
  getActivityFeedController,
  logActivityValidation,
  getActivityValidation,
} from '../controllers/collaboration.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

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

// --- Activity Feed Endpoints (Task 18) ---

// POST /projects/:projectId/activity - Log new activity event (Internal/Admin only)
router.post(
  '/:projectId/activity',
  authenticate,
  authorize([PERMISSIONS.ADMIN_DASHBOARD]),
  logActivityValidation,
  logActivityController
);

// GET /projects/:projectId/activity - Retrieve activity feed (Member only)
router.get(
  '/:projectId/activity',
  authenticate,
  getActivityValidation,
  getActivityFeedController
);

export default router;
