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
  listAdminJobsController,
  getJobStatsController,
  jobQueueValidation,
  logAuditController,
  logAuditValidation,
  queryAuditLogsController,
  exportAuditLogsController,
  auditQueryValidation,
  auditExportValidation,
  getModerationQueueController,
  takeActionController,
  moderationQueueValidation,
  takeActionValidation,
  listAdminUsersController,
  updateAdminUserRoleController,
  adminUserListValidation,
  updateRoleValidation,
} from '../controllers/admin.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const financeAccess = [PERMISSIONS.FINANCE_MANAGE];
const userManageAccess = [PERMISSIONS.USER_MANAGE_ALL, PERMISSIONS.ADMIN_DASHBOARD];

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

// --- Admin Job Monitoring Endpoints (Task 59) ---

// GET /admin/jobs/queue - List all jobs for monitoring
router.get(
  '/jobs/queue',
  authenticate,
  authorize(financeAccess),
  jobQueueValidation,
  listAdminJobsController
);

// GET /admin/jobs/stats - High-level statistics
router.get(
  '/jobs/stats',
  authenticate,
  authorize(financeAccess),
  getJobStatsController
);

// --- Admin Audit Log Endpoints (Task 60) ---

// POST /admin/audit - Writes a new immutable log entry (Internal/System only)
router.post(
  '/audit',
  authenticate,
  authorize(financeAccess), // RBAC check: System/Admin access only
  logAuditValidation,
  logAuditController
);

// --- Admin Audit Log Query & Export Endpoints (Task 61) ---

// GET /admin/audit-logs - Query audit log ledger
router.get(
  '/audit-logs',
  authenticate,
  authorize(financeAccess), // RBAC check
  auditQueryValidation,
  queryAuditLogsController
);

// POST /admin/audit-logs/export - Initiate audit log export job
router.post(
  '/audit-logs/export',
  authenticate,
  authorize(financeAccess), // RBAC check
  auditExportValidation,
  exportAuditLogsController
);

// --- Admin Moderation Endpoints (Task 63) ---

// GET /admin/moderation/queue - Get list of open reports
router.get(
  '/moderation/queue',
  authenticate,
  authorize(financeAccess), // RBAC check: Admin/Moderator access
  moderationQueueValidation,
  getModerationQueueController
);

// POST /admin/moderation/:modId/action - Take action (takedown, suspend, warn)
router.post(
  '/moderation/:modId/action',
  authenticate,
  authorize(financeAccess), // RBAC check: Admin/Moderator access
  takeActionValidation,
  takeActionController
);

// --- Admin User Management Endpoints (Task 64) ---

// GET /admin/users - List all users (Full DTO)
router.get(
  '/users',
  authenticate,
  authorize(userManageAccess), // RBAC check: Admin access
  adminUserListValidation,
  listAdminUsersController
);

// PUT /admin/users/:userId/role - Update user's role
router.put(
  '/users/:userId/role',
  authenticate,
  authorize(userManageAccess), // RBAC check: Admin access
  updateRoleValidation,
  updateAdminUserRoleController
);

// ... Future Admin endpoints (reconciliation, manual ops) go here ...

export default router;

