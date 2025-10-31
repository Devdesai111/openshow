// src/routes/revenue.routes.ts
import { Router } from 'express';
import {
  calculatePreviewController,
  calculateRevenueValidation,
  schedulePayoutsController,
  schedulePayoutsValidation,
  listUserPayoutsController,
  getPayoutDetailsController,
  payoutsReadValidation,
  payoutItemIdValidation,
} from '../controllers/revenue.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// POST /revenue/calculate - Calculate split preview (Task 31)
router.post(
  '/calculate',
  authenticate,
  // RBAC: Requires Project Create permission for access to financial preview/project data
  authorize([PERMISSIONS.PROJECT_CREATE]),
  calculateRevenueValidation,
  calculatePreviewController
);

// POST /revenue/schedule-payouts - Schedule payouts from released escrow (Task 32)
router.post(
  '/schedule-payouts',
  authenticate,
  authorize([PERMISSIONS.ADMIN_DASHBOARD]), // Simulating Internal Service Token access
  schedulePayoutsValidation,
  schedulePayoutsController
);

// --- Creator Earnings Dashboard Endpoints (Task 38) ---

// GET /revenue/earnings - List user's payouts (earnings dashboard)
router.get('/earnings', authenticate, payoutsReadValidation, listUserPayoutsController);

// GET /revenue/payouts/:payoutItemId - Get specific payout details
router.get(
  '/payouts/:payoutItemId',
  authenticate,
  payoutItemIdValidation,
  getPayoutDetailsController
);

export default router;

