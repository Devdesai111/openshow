// src/routes/payment.routes.ts
import { Router } from 'express';
import {
  createPaymentIntentController,
  createPaymentIntentValidation,
  lockEscrowController,
  releaseEscrowController,
  refundEscrowController,
  releaseEscrowValidation,
  refundEscrowValidation,
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

// --- Escrow Management Endpoints (Task 36) ---

// POST /payments/escrow/:escrowId/release - Release escrow (Owner/Admin only)
router.post(
  '/escrow/:escrowId/release',
  authenticate,
  // NOTE: Owner/Admin permission is checked in the service (Task 36.1)
  releaseEscrowValidation,
  releaseEscrowController
);

// POST /payments/escrow/:escrowId/refund - Refund escrow (Owner/Admin only)
router.post(
  '/escrow/:escrowId/refund',
  authenticate,
  // NOTE: Owner/Admin permission is checked in the service (Task 36.1)
  refundEscrowValidation,
  refundEscrowController
);

export default router;

