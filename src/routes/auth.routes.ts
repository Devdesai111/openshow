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
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';

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

// NOTE: 2FA verification and other endpoints will be implemented in subsequent tasks.

export default router;

