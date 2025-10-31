// src/routes/admin.routes.ts
import { Router } from 'express';
import {
  listAdminLedgerController,
  listAdminPayoutBatchesController,
  adminLedgerValidation,
  adminBatchValidation,
} from '../controllers/admin.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const financeAccess = [PERMISSIONS.FINANCE_MANAGE];

// NOTE: All Admin routes are protected by the finance role check

// GET /admin/payments/ledger - List all transactions (Task 39)
router.get(
  '/payments/ledger',
  authenticate,
  authorize(financeAccess),
  adminLedgerValidation,
  listAdminLedgerController
);

// GET /admin/payouts/batches - List all payout batches (Task 39)
router.get(
  '/payouts/batches',
  authenticate,
  authorize(financeAccess),
  adminBatchValidation,
  listAdminPayoutBatchesController
);

// ... Future Admin endpoints (moderation, reconciliation, manual ops) go here ...

export default router;

