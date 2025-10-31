// src/routes/userSettings.routes.ts
import { Router } from 'express';
import {
  getSettingsController,
  updateSettingsController,
  registerPushTokenController,
  deletePushTokenController,
  settingsSelfParamValidation,
  settingsUpdateValidation,
  pushTokenRegisterValidation,
  pushTokenDeleteValidation,
} from '../controllers/userSettings.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// --- User Settings Endpoints ---

// GET /settings/:userId - Retrieve specific user settings (Self-access enforced) (Task 44)
router.get('/:userId', authenticate, settingsSelfParamValidation, getSettingsController);

// PUT /settings/:userId - Update user settings (Self-access enforced) (Task 44)
router.put('/:userId', authenticate, settingsSelfParamValidation, settingsUpdateValidation, updateSettingsController);

// --- Push Token Management (Task 49) ---

// POST /settings/:userId/push-token - Register device token
router.post(
  '/:userId/push-token',
  authenticate,
  settingsSelfParamValidation,
  pushTokenRegisterValidation,
  registerPushTokenController
);

// DELETE /settings/:userId/push-token - Delete device token
router.delete(
  '/:userId/push-token',
  authenticate,
  settingsSelfParamValidation,
  pushTokenDeleteValidation,
  deletePushTokenController
);

export default router;

