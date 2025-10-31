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
  addMilestoneController,
  addMilestoneValidation,
  updateMilestoneController,
  updateMilestoneValidation,
  deleteMilestoneController,
  completeMilestoneController,
  completeMilestoneValidation,
  milestoneParamValidation,
  listProjectsController,
  getProjectDetailsController,
  updateProjectController,
  projectParamValidation,
  updateProjectValidation,
  listProjectsValidation,
} from '../controllers/project.controller';
import { listProjectAssetsController, listProjectAssetsValidation } from '../controllers/asset.controller';
import { authenticate, optionalAuthenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Project Read/List Endpoints (Task 15) ---

// GET /projects - List projects (Public/Auth filtered)
router.get(
  '/',
  optionalAuthenticate, // Optional auth for context (member vs. anonymous)
  listProjectsValidation,
  listProjectsController
);

// GET /projects/:projectId - Get project details (Public/Member visibility-aware)
router.get(
  '/:projectId',
  projectParamValidation,
  optionalAuthenticate, // Optional auth for context (member vs. anonymous)
  getProjectDetailsController
);

// PUT /projects/:projectId - Update project (Owner only)
router.put(
  '/:projectId',
  authenticate,
  authorize([PERMISSIONS.PROJECT_CREATE]), // Owner/admin access
  updateProjectValidation,
  updateProjectController
);

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

// --- Milestone Management Endpoints (Task 14) ---

// POST /projects/:projectId/milestones - Add milestone (Owner only)
router.post(
  '/:projectId/milestones',
  authenticate,
  authorize([PERMISSIONS.PROJECT_CREATE]), // Owner/admin access
  addMilestoneValidation,
  addMilestoneController
);

// PUT /projects/:projectId/milestones/:milestoneId - Update milestone (Owner only)
router.put(
  '/:projectId/milestones/:milestoneId',
  authenticate,
  authorize([PERMISSIONS.PROJECT_CREATE]), // Owner/admin access
  updateMilestoneValidation,
  updateMilestoneController
);

// DELETE /projects/:projectId/milestones/:milestoneId - Delete milestone (Owner only)
router.delete(
  '/:projectId/milestones/:milestoneId',
  authenticate,
  authorize([PERMISSIONS.PROJECT_CREATE]), // Owner/admin access
  milestoneParamValidation,
  deleteMilestoneController
);

// POST /projects/:projectId/milestones/:milestoneId/complete - Mark milestone complete (Member/Owner)
router.post(
  '/:projectId/milestones/:milestoneId/complete',
  authenticate,
  // NOTE: No authorize middleware - membership validation handled in service layer
  completeMilestoneValidation,
  completeMilestoneController
);

// --- Project Scoped Asset Listing (Task 22) ---

// GET /projects/:projectId/assets - List project assets (Member only)
router.get(
  '/:projectId/assets',
  authenticate,
  listProjectAssetsValidation,
  listProjectAssetsController
);

export default router;
