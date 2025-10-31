// src/routes/admin.routes.ts
import { Router } from 'express';
import {
  listAdminLedgerController,
  listAdminPayoutBatchesController,
  adminLedgerValidation,
  adminBatchValidation,
  updateRankingWeightsController,
  updateRankingWeightsValidation,
  reRankHookController,
  reRankHookValidation,
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

// --- Admin Configuration Endpoints (Task 42) ---

// PUT /admin/ranking/weights - Update A/B ranking weights
router.put(
  '/ranking/weights',
  authenticate,
  authorize(financeAccess), // RBAC check
  updateRankingWeightsValidation,
  updateRankingWeightsController
);

// --- Admin Search/ML Endpoints (Task 45) ---

// POST /admin/search/rerank-hook - Internal hook to trigger ML re-ranking
router.post(
  '/search/rerank-hook',
  authenticate,
  authorize(financeAccess), // RBAC check: System/Admin access only
  reRankHookValidation,
  reRankHookController
);

// ... Future Admin endpoints (moderation, reconciliation, manual ops) go here ...

export default router;

