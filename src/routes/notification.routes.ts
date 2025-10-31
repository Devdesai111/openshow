import { Router } from 'express';
import { sendNotificationController, sendNotificationValidation, initialTemplateCreationController } from '../controllers/notification.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

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

// POST /notifications/templates - Admin endpoint to create initial templates (Placeholder for later Task 46)
router.post('/templates', initialTemplateCreationController);

// ... (Future Task 50 endpoints for user-facing lists will be here) ...

export default router;
