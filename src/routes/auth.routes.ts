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
} from '../controllers/auth.controller';

const router = Router();

// --- Public Endpoints ---

// POST /auth/signup - Create new account. (Task 1)
router.post('/signup', signupValidation, signupController);

// POST /auth/login - Email/password login. (Task 1)
router.post('/login', loginValidation, loginController);

// POST /auth/oauth - OAuth sign-in / sign-up (Task 3)
router.post('/oauth', oauthValidation, oauthController);

// POST /auth/password-reset/request - Trigger password reset email (Task 3)
router.post('/password-reset/request', passwordResetRequestValidation, requestPasswordResetController);

// NOTE: Token refresh, Logout, and other endpoints will be implemented in subsequent tasks.

export default router;

