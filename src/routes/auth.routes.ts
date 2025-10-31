import { Router } from 'express';
import {
  signupController,
  loginController,
  signupValidation,
  loginValidation,
  oauthController,
  oauthValidation,
  requestPasswordResetController,
  passwordResetRequestValidation,
  refreshController,
  meController,
  logoutController,
  enable2FAController,
  verify2FAController,
  verify2FAValidation,
  disable2FAController,
  suspendUserController,
  suspendUserValidation,
  unsuspendUserController,
  userParamValidation,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Public Endpoints ---

// POST /auth/signup - Create new account. (Task 1)
router.post('/signup', signupValidation, signupController);

// POST /auth/login - Email/password login. (Task 1)
router.post('/login', loginValidation, loginController);

// POST /auth/oauth - OAuth sign-in / sign-up (Task 3)
router.post('/oauth', oauthValidation, oauthController);

// POST /auth/password-reset/request - Trigger password reset email (Task 3)
router.post(
  '/password-reset/request',
  passwordResetRequestValidation,
  requestPasswordResetController
);

// POST /auth/refresh - Exchange refresh token for new access token (Task 4)
router.post('/refresh', refreshController);

// --- Protected Endpoints ---

// GET /auth/me - Get current user profile & roles (Task 4)
router.get('/me', authenticate, meController);

// POST /auth/logout - Revoke refresh token / logout (Task 5)
router.post('/logout', authenticate, logoutController);

// POST /auth/2fa/enable - Begin enable 2FA (TOTP) (Task 5)
router.post('/2fa/enable', authenticate, enable2FAController);

// POST /auth/2fa/verify - Verify and finalize 2FA enrollment (Task 6)
router.post('/2fa/verify', authenticate, verify2FAValidation, verify2FAController);

// POST /auth/2fa/disable - Disable 2FA (Task 6)
router.post('/2fa/disable', authenticate, disable2FAController);

// --- Admin Endpoints (RBAC protected) ---

// POST /auth/users/:userId/suspend - Admin suspend user (Task 6)
router.post(
  '/users/:userId/suspend',
  authenticate,
  authorize([PERMISSIONS.USER_MANAGE_ALL]),
  suspendUserValidation,
  suspendUserController
);

// POST /auth/users/:userId/unsuspend - Admin unsuspend user (Task 6)
router.post(
  '/users/:userId/unsuspend',
  authenticate,
  authorize([PERMISSIONS.USER_MANAGE_ALL]),
  userParamValidation,
  unsuspendUserController
);

// NOTE: Password reset confirmation and other endpoints will be implemented in subsequent tasks.

export default router;
