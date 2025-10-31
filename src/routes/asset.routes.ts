import { Router } from 'express';
import {
  getSignedUploadUrlController,
  registerAssetController,
  addNewVersionController,
  getAssetController,
  signedUploadValidation,
  registerAssetValidation,
  versionSubmissionValidation,
  assetIdParamValidation,
} from '../controllers/asset.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// POST /assets/signed-upload-url - Request signed upload URL (Task 19)
router.post(
  '/signed-upload-url',
  authenticate, // Only authenticated users can start an upload session
  signedUploadValidation,
  getSignedUploadUrlController
);

// POST /assets/register - Register asset metadata after upload (Task 19)
router.post(
  '/register',
  authenticate,
  registerAssetValidation,
  registerAssetController
);

// --- Asset Read/Version Endpoints (Task 20) ---

// GET /assets/:assetId - Get asset metadata + signed download URL (Task 20)
router.get(
  '/:assetId',
  authenticate, // All access requires authentication
  assetIdParamValidation,
  getAssetController
);

// POST /assets/:assetId/version - Add new version entry (Task 20)
router.post(
  '/:assetId/version',
  authenticate,
  assetIdParamValidation,
  versionSubmissionValidation,
  addNewVersionController
);

// NOTE: Future endpoints (DELETE /assets/:id, etc.) will be added here.

export default router;

