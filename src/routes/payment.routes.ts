// src/routes/payment.routes.ts
import { Router } from 'express';
import {
  createPaymentIntentController,
  createPaymentIntentValidation,
  lockEscrowController,
} from '../controllers/payment.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Payments Endpoints ---

// POST /payments/intents - Create payment intent / checkout session (Task 34)
router.post('/intents', authenticate, createPaymentIntentValidation, createPaymentIntentController);

// --- Escrow Endpoints ---

// POST /payments/escrow/lock - Lock funds into escrow (Task 35)
router.post(
  '/escrow/lock',
  authenticate,
  authorize([PERMISSIONS.FINANCE_MANAGE]), // Restrict to trusted internal roles/system calls
  lockEscrowController
);

export default router;

