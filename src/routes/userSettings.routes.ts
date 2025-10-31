// src/routes/userSettings.routes.ts
import { Router } from 'express';
import {
  getSettingsController,
  updateSettingsController,
  settingsSelfParamValidation,
  settingsUpdateValidation,
} from '../controllers/userSettings.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// --- User Settings Endpoints ---

// GET /settings/:userId - Retrieve specific user settings (Self-access enforced) (Task 44)
router.get('/:userId', authenticate, settingsSelfParamValidation, getSettingsController);

// PUT /settings/:userId - Update user settings (Self-access enforced) (Task 44)
router.put('/:userId', authenticate, settingsSelfParamValidation, settingsUpdateValidation, updateSettingsController);

export default router;

