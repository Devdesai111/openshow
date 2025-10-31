import { Router } from 'express';
import {
  indexUpdateController,
  indexUpdateValidation,
} from '../controllers/discovery.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Internal Indexing Endpoints (Task 41) ---

// POST /search/index-update - Internal endpoint for atomic document updates
router.post(
  '/index-update',
  authenticate,
  authorize([PERMISSIONS.ADMIN_DASHBOARD]), // RBAC check: System/Admin access only
  indexUpdateValidation,
  indexUpdateController
);

export default router;

