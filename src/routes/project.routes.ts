import { Router } from 'express';
import { createProjectController, createProjectValidation } from '../controllers/project.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Protected Project Creation ---

// POST /projects - Create project (6-step wizard payload) (Task 12)
router.post(
  '/',
  authenticate,
  authorize([PERMISSIONS.PROJECT_CREATE]), // RBAC check
  createProjectValidation,
  createProjectController
);

// ... (Future Task 13, 14, 15 endpoints go here) ...

export default router;
