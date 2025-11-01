// src/routes/moderation.routes.ts
import { Router } from 'express';
import { reportContentController, reportContentValidation } from '../controllers/admin.controller';

const router = Router();

// --- Public Moderation Endpoint (Task 63) ---

// POST /moderation/report - Allows users/public to report content
// NOTE: This endpoint should be rate-limited heavily for production.
router.post(
  '/moderation/report',
  // No authenticate required for anonymous reporting, but we check if req.user exists
  reportContentValidation,
  reportContentController
);

export default router;

