import { Router } from 'express';
import {
  searchCreatorsController,
  searchCreatorsValidation,
  searchProjectsController,
  searchProjectsValidation,
  indexUpdateController,
  indexUpdateValidation,
  suggestController,
  suggestValidation,
} from '../controllers/discovery.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Public Discovery Endpoints ---

// GET /market/creators - Creator Directory Listing/Search (Task 10)
router.get('/creators', searchCreatorsValidation, searchCreatorsController);

// GET /market/projects - Public Project Listing/Search (Task 16)
router.get('/projects', searchProjectsValidation, searchProjectsController);

// GET /market/suggestions - Autocomplete / typeahead (Task 43)
router.get('/suggestions', suggestValidation, suggestController);

// --- Internal Indexing Endpoints (Task 41) ---

// POST /market/index-update - Internal endpoint for atomic document updates
// NOTE: Mounted at /search/index-update in server.ts for correct path
router.post(
  '/index-update',
  authenticate,
  authorize([PERMISSIONS.ADMIN_DASHBOARD]), // RBAC check: System/Admin access only
  indexUpdateValidation,
  indexUpdateController
);

export default router;


