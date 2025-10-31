import { Router } from 'express';
import { generateAgreementController, generateAgreementValidation } from '../controllers/agreement.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Agreements Endpoints ---

// POST /projects/:projectId/agreements/generate - Generate agreement draft (Task 21)
router.post(
  '/:projectId/agreements/generate',
  authenticate,
  // RBAC: Requires Project Edit permission (implicit mutation of project's legal state)
  authorize([PERMISSIONS.PROJECT_CREATE]),
  generateAgreementValidation,
  generateAgreementController
);

// NOTE: Future endpoints (signing, download, status updates) will be added here.

export default router;

