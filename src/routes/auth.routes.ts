import { Router } from 'express';
import {
  signupController,
  loginController,
  signupValidation,
  loginValidation,
} from '../controllers/auth.controller';

const router = Router();

// --- Public Endpoints ---

// POST /auth/signup - Create new account. (Task 1)
router.post('/signup', signupValidation, signupController);

// POST /auth/login - Email/password login. (Task 1)
router.post('/login', loginValidation, loginController);

// NOTE: OAuth, Refresh, Logout, and other endpoints will be implemented in subsequent tasks.

export default router;

