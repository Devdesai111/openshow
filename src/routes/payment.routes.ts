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
  listTransactionsController,
  getTransactionDetailsController,
  listTransactionsValidation,
  transactionIdParamValidation,
  unifiedWebhookController,
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

// --- Ledger Query Endpoints (Task 37) ---

// GET /payments/transactions - List financial transactions (Self/Admin only)
router.get('/transactions', authenticate, listTransactionsValidation, listTransactionsController);

// GET /payments/transactions/:transactionId - Get transaction details (Self/Admin only)
router.get(
  '/transactions/:transactionId',
  authenticate,
  transactionIdParamValidation,
  getTransactionDetailsController
);

// --- Unified Webhooks (Public) ---

// POST /webhooks/provider/:providerName - Unified receiver for all PSP/E-sign webhooks (Task 69)
// NOTE: This route needs special raw body parsing middleware in the main Express config.
router.post('/webhooks/provider/:providerName', unifiedWebhookController);

export default router;

