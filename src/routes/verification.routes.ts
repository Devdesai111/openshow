import { Router } from 'express';
import {
  submitApplicationController,
  getAdminQueueController,
  approveApplicationController,
  rejectApplicationController,
  submitApplicationValidation,
  adminQueueValidation,
  reviewActionValidation,
} from '../controllers/verification.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Creator Endpoints ---

// POST /verification/apply - Submit verification application (Task 24)
router.post(
  '/apply',
  authenticate,
  // RBAC: Requires only authentication, further checks in service
  submitApplicationValidation,
  submitApplicationController
);

// --- Admin/Verifier Endpoints ---

// GET /verification/queue - List pending verification apps (Task 24)
router.get(
  '/queue',
  authenticate,
  authorize([PERMISSIONS.VERIFICATION_REVIEW]), // RBAC check
  adminQueueValidation,
  getAdminQueueController
);

// POST /verification/:applicationId/approve - Approve application (Task 24)
router.post(
  '/:applicationId/approve',
  authenticate,
  authorize([PERMISSIONS.VERIFICATION_REVIEW]),
  reviewActionValidation,
  approveApplicationController
);

// POST /verification/:applicationId/reject - Reject application with notes (Task 24)
router.post(
  '/:applicationId/reject',
  authenticate,
  authorize([PERMISSIONS.VERIFICATION_REVIEW]),
  reviewActionValidation,
  rejectApplicationController
);

export default router;

