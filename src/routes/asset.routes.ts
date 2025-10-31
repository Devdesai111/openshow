import { Router } from 'express';
import {
  getSignedUploadUrlController,
  registerAssetController,
  addNewVersionController,
  getAssetController,
  updateAssetMetadataController,
  deleteAssetController,
  signedUploadValidation,
  registerAssetValidation,
  versionSubmissionValidation,
  assetIdParamValidation,
  updateAssetMetadataValidation,
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

// --- Asset Management Endpoints (Task 22) ---

// PUT /assets/:assetId - Update asset metadata (Task 22)
router.put(
  '/:assetId',
  authenticate,
  assetIdParamValidation,
  updateAssetMetadataValidation,
  updateAssetMetadataController
);

// DELETE /assets/:assetId - Soft-delete asset (Task 22)
router.delete(
  '/:assetId',
  authenticate,
  assetIdParamValidation,
  deleteAssetController
);

export default router;

