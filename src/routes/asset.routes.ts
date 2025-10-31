import { Router } from 'express';
import {
  getSignedUploadUrlController,
  registerAssetController,
  signedUploadValidation,
  registerAssetValidation,
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

// NOTE: Future endpoints (GET /assets/:id, POST /assets/:id/version) will be added here.

export default router;

