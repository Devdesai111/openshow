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
  verifyChainController,
  auditQueryValidation,
  auditExportValidation,
  auditVerifyValidation,
  getModerationQueueController,
  takeActionController,
  moderationQueueValidation,
  takeActionValidation,
  listAdminUsersController,
  updateAdminUserRoleController,
  adminUserListValidation,
  updateRoleValidation,
  getDisputeQueueController,
  resolveDisputeController,
  disputeQueueValidation,
  resolveDisputeValidation,
  getFinanceReportController,
  financeReportValidation,
  updatePayoutStatusController,
  updatePayoutStatusValidation,
} from '../controllers/admin.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { mfaEnforcement } from '../middleware/mfa.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const financeAccess = [PERMISSIONS.FINANCE_MANAGE];
const userManageAccess = [PERMISSIONS.USER_MANAGE_ALL, PERMISSIONS.ADMIN_DASHBOARD];

// NOTE: All Admin routes are protected by the finance role check

// GET /admin/payments/ledger - List all transactions (Task 39)
// MFA Enforcement applied (Task 73)
router.get(
  '/payments/ledger',
  authenticate,
  authorize(financeAccess),
  mfaEnforcement, // Apply MFA middleware for Admin users
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

// --- Admin Audit Verification Endpoints (Task 72) ---

// GET /admin/audit-logs/verify - Verify hash chain integrity
router.get(
  '/audit-logs/verify',
  authenticate,
  authorize(financeAccess), // RBAC check
  auditVerifyValidation,
  verifyChainController
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

// --- Admin Dispute Management Endpoints (Task 65) ---

// GET /admin/disputes/queue - Get list of open/pending disputes
router.get(
  '/disputes/queue',
  authenticate,
  authorize(userManageAccess), // RBAC check: Admin access
  disputeQueueValidation,
  getDisputeQueueController
);

// POST /admin/disputes/:disputeId/resolve - Manually resolve a dispute
router.post(
  '/disputes/:disputeId/resolve',
  authenticate,
  authorize(userManageAccess), // RBAC check: Admin access
  resolveDisputeValidation,
  resolveDisputeController
);

// --- Admin Reporting Endpoints (Task 67) ---

// GET /admin/reports/finance - Generate aggregated financial report
router.get(
  '/reports/finance',
  authenticate,
  authorize(financeAccess), // RBAC check: Finance admin access
  financeReportValidation,
  getFinanceReportController
);

// --- Admin Payout/KYC Management (Task 68) ---

// PUT /admin/users/:userId/payout-status - Admin manual verification/linking
router.put(
  '/users/:userId/payout-status',
  authenticate,
  authorize(financeAccess), // RBAC check: Finance admin access
  updatePayoutStatusValidation,
  updatePayoutStatusController
);

// ... Future Admin endpoints (reconciliation, manual ops) go here ...

export default router;

