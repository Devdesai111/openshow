import { Router } from 'express';
import {
  searchCreatorsController,
  searchCreatorsValidation,
  searchProjectsController,
  searchProjectsValidation,
} from '../controllers/discovery.controller';

const router = Router();

// --- Public Discovery Endpoints ---

// GET /market/creators - Creator Directory Listing/Search (Task 10)
router.get('/creators', searchCreatorsValidation, searchCreatorsController);

// GET /market/projects - Public Project Listing/Search (Task 16)
router.get('/projects', searchProjectsValidation, searchProjectsController);

// NOTE: All endpoints are PUBLIC as required by the spec.

export default router;


