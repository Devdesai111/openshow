import { Router } from 'express';
import {
  createProjectController,
  createProjectValidation,
  inviteUserController,
  inviteValidation,
  applyForRoleController,
  applyValidation,
  assignRoleController,
  assignValidation,
} from '../controllers/project.controller';
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

// --- Member Management Endpoints (Task 13) ---

// POST /projects/:projectId/invite - Invite user to role (Owner only)
router.post(
  '/:projectId/invite',
  authenticate,
  authorize([PERMISSIONS.PROJECT_CREATE]), // Owner/admin access
  inviteValidation,
  inviteUserController
);

// POST /projects/:projectId/apply - Apply for open role (Creator/User)
router.post(
  '/:projectId/apply',
  authenticate,
  // No authorize middleware - access check done in service based on project.collaborationType
  applyValidation,
  applyForRoleController
);

// POST /projects/:projectId/roles/:roleId/assign - Assign user to role (Owner only)
router.post(
  '/:projectId/roles/:roleId/assign',
  authenticate,
  authorize([PERMISSIONS.PROJECT_CREATE]), // Owner/admin access
  assignValidation,
  assignRoleController
);

// ... (Future Task 14, 15 endpoints go here) ...

export default router;
