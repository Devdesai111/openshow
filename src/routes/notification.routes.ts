import { Router } from 'express';
import {
  sendNotificationController,
  sendNotificationValidation,
  createTemplateController,
  previewTemplateController,
  deleteTemplateController,
  templateBaseValidation,
  templateIdParamValidation,
  previewTemplateValidation,
} from '../controllers/notification.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; // Admin/System access for template management

// --- Internal/Service-to-Service Endpoints ---

// POST /notifications/send - Send a notification via template (Task 11)
// NOTE: This must be protected by a service token/secret in production,
// using Admin permission for Phase 1 simulation.
router.post(
  '/send',
  authenticate, // Internal service authentication
  authorize([PERMISSIONS.ADMIN_DASHBOARD]), // Simulating internal service role
  sendNotificationValidation,
  sendNotificationController
);

// --- Admin Template Management Endpoints (Task 46) ---

// POST /notifications/templates - Create new template
router.post('/templates', authenticate, authorize(adminAccess), templateBaseValidation, createTemplateController);

// POST /notifications/templates/preview - Preview template
router.post(
  '/templates/preview',
  authenticate,
  authorize(adminAccess),
  previewTemplateValidation,
  previewTemplateController
);

// DELETE /notifications/templates/:templateId - Delete/Deactivate template
router.delete(
  '/templates/:templateId',
  authenticate,
  authorize(adminAccess),
  templateIdParamValidation,
  deleteTemplateController
);

// ... (Future Task 50 endpoints for user-facing lists will be here) ...

export default router;
