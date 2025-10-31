import { Router } from 'express';
import {
  generateAgreementController,
  generateAgreementValidation,
  signAgreementController,
  signAgreementValidation,
  downloadPdfController,
  agreementIdParamValidation,
} from '../controllers/agreement.controller';
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

// --- E-Signature Endpoints (Task 26) ---

// POST /agreements/:agreementId/sign - Process a signature (Typed/Callback)
router.post(
  '/:agreementId/sign',
  authenticate,
  // NOTE: RBAC check is done in the service logic (only signer allowed)
  signAgreementValidation,
  signAgreementController
);

// --- Agreements Download Endpoint (Task 27) ---

// GET /agreements/:agreementId/pdf - Download the signed PDF
router.get(
  '/:agreementId/pdf',
  authenticate,
  agreementIdParamValidation,
  // NOTE: Access control is handled in the service (Signer/Member/Admin)
  downloadPdfController
);

export default router;

