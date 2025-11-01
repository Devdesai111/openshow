Following the structured plan and focusing on external financial compliance, we proceed with **Task 67: Accounting Integration & Ledger Exports**.

This task implements the final reporting tools required to fulfill external accounting and bookkeeping needs, generating comprehensive reports from the system's financial ledgers.

***

## **Task 67: Accounting Integration & Ledger Exports**

**Goal:** Implement Admin-only endpoints to generate aggregated financial reports (`GET /admin/reports/finance`) from the `PaymentTransaction` and `PayoutBatch` data, and provide the infrastructure for exporting this data for accounting systems.

**Service:** `Admin & Audit / Reporting Service` / `Revenue Calculation & Payouts Service`
**Phase:** F - Revenue & Payouts execution, Accounting integration
**Dependencies:** Task 37 (PaymentTransaction Model), Task 38 (Payout Model), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/admin.service.ts` (Updated: `getFinanceReport`)
2.  `src/controllers/admin.controller.ts` (Updated: `getFinanceReportController`)
3.  `src/routes/admin.routes.ts` (Updated: new protected route)
4.  `test/integration/finance_report.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /admin/reports/finance** | `query: { from: string, to: string, export: boolean }` | `FinanceReportDTO` (Aggregated Totals) | Auth (Admin/Finance) |

**FinanceReportDTO (Excerpt):**
```json
{
  "period": "2025-10-01 to 2025-10-31",
  "totalVolumeCollected": { "amount": 1500000, "currency": "USD" },
  "totalPlatformFees": { "amount": 75000, "currency": "USD" },
  "totalNetPayouts": { "amount": 1300000, "currency": "USD" },
  "transactionCounts": { "escrow_lock": 50, "refund": 2 }
}
```

**Runtime & Env Constraints:**
*   **Security:** This endpoint accesses highly sensitive, aggregated financial data; it must be protected by the `FINANCE_MANAGE` permission.
*   **Performance:** Aggregation operations must be efficient, utilizing MongoDB's aggregation pipeline for summing, grouping, and filtering across large datasets.
*   **Export Trigger:** If `query.export=true`, the endpoint should enqueue an asynchronous job for data dump (leveraging Task 61/62 logic).

**Acceptance Criteria:**
*   The service successfully calculates and returns aggregated totals for the requested date range.
*   The key metrics (`totalVolumeCollected`, `totalPlatformFees`, `totalNetPayouts`) are correctly derived from the ledger models.
*   Access attempts by non-Admin users return **403 Forbidden**.

**Tests to Generate:**
*   **Integration Test (Aggregation):** Test Admin request with a specific date range, verify returned sums match mocked totals.
*   **Integration Test (Export Trigger):** Test request with `export=true` successfully queues a job.

***

### **Task 67 Code Implementation**

#### **67.1. `src/services/admin.service.ts` (Updates)**

```typescript
// src/services/admin.service.ts (partial update)
// ... (Imports from Task 66) ...
import { PaymentTransactionModel } from '../models/paymentTransaction.model';
import { PayoutBatchModel } from '../models/payout.model';
import { JobService } from './job.service'; // Task 52 Dependency

const jobService = new JobService();

interface IFinanceReportFilters {
    from: Date;
    to: Date;
    export: boolean;
}

export class AdminService {
    // ... (All previous methods) ...

    /** Generates an aggregated financial report for a given period. */
    public async getFinanceReport(filters: IFinanceReportFilters, requesterId: string): Promise<any> {
        const { from, to, export: triggerExport } = filters;
        
        // 1. Initial Data Aggregation (MongoDB Aggregation Pipeline)
        const txnPipeline = [
            { $match: { 
                createdAt: { $gte: from, $lte: to },
                status: 'succeeded' // Only count successful transactions/funds movements
            }},
            { $group: {
                _id: '$type',
                totalAmount: { $sum: '$amount' },
                count: { $sum: 1 }
            }}
        ];

        // MOCK/SIMULATION: Payouts are in embedded arrays, requiring separate aggregation
        const payoutsPipeline = [
             { $match: { createdAt: { $gte: from, $lte: to } } },
             { $unwind: '$items' },
             { $match: { 'items.status': 'paid' } },
             { $group: {
                 _id: null,
                 totalNetPayouts: { $sum: '$items.netAmount' },
                 totalFees: { $sum: '$items.fees' },
             }}
        ];

        const [txnAggregates, payoutAggregates] = await Promise.all([
            PaymentTransactionModel.aggregate(txnPipeline),
            PayoutBatchModel.aggregate(payoutsPipeline),
        ]);

        // 2. Report Compilation
        const escrowLock = txnAggregates.find((agg: any) => agg._id === 'escrow_lock');
        const payoutSum = payoutAggregates[0] || { totalNetPayouts: 0, totalFees: 0 };

        const report = {
            period: `${from.toISOString().split('T')[0]} to ${to.toISOString().split('T')[0]}`,
            totalVolumeCollected: { amount: escrowLock?.totalAmount || 0, currency: 'USD' },
            totalPlatformFees: { amount: payoutSum.totalFees, currency: 'USD' },
            totalNetPayouts: { amount: payoutSum.totalNetPayouts, currency: 'USD' },
            transactionCounts: txnAggregates.reduce((acc, curr) => ({ ...acc, [curr._id]: curr.count }), {}),
        };

        // 3. Trigger Export Job (If Requested)
        if (triggerExport) {
            const jobPayload = { from, to, requesterId, reportType: 'finance' };
            const job = await jobService.enqueueJob({
                type: 'export.finance', // New job type registered in Task 68
                payload: jobPayload,
                priority: 20, 
                createdBy: requesterId,
            });
            (report as any).exportJobId = job.jobId;
        }

        // 4. Audit Log
        await auditService.logAuditEntry({
            resourceType: 'report',
            action: 'report.finance.generated',
            actorId: requesterId,
            details: { filters: filters, metrics: report.transactionCounts },
        });

        return report;
    }
}
```

#### **67.2. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { query, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const financeReportValidation = [
    query('from').isISO8601().toDate().withMessage('From date must be valid ISO 8601.').bail(),
    query('to').isISO8601().toDate().withMessage('To date must be valid ISO 8601.').bail(),
    query('export').optional().isBoolean().withMessage('Export must be boolean.'),
];


// --- Admin Reporting Controllers ---

/** Generates and returns a financial report. GET /admin/reports/finance */
export const getFinanceReportController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const requesterId = req.user!.sub;
        
        // Service handles aggregation and optional job queuing
        const report = await adminService.getFinanceReport(req.query as unknown as IFinanceReportFilters, requesterId);

        // If export was triggered, return 202 Accepted, else 200 OK
        if ((req.query as any).export === 'true' && (report as any).exportJobId) {
             return res.status(202).json({ 
                 message: 'Report export job successfully queued.', 
                 jobId: (report as any).exportJobId 
             });
        }

        return res.status(200).json(report);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error generating report.' } });
    }
};
```

#### **67.3. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 66) ...
import { 
    getFinanceReportController, financeReportValidation
} from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const financeAccess = [PERMISSIONS.FINANCE_MANAGE]; 


// ... (All previous Admin Endpoints) ...


// --- Admin Reporting Endpoints (Task 67) ---

// GET /admin/reports/finance - Generate aggregated financial report
router.get(
    '/reports/finance',
    authenticate,
    authorize(financeAccess), // RBAC check
    financeReportValidation,
    getFinanceReportController
);


export default router;
```

#### **67.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T67.1** | `GET /reports/finance` | Happy Path: Aggregation | Auth Admin, Valid Date Range | **200 OK** | Returns `totalVolumeCollected`, `totalPlatformFees`. |
| **T67.2** | `GET /reports/finance` | Happy Path: Export Trigger | Auth Admin, `query: { export: true }` | **202 Accepted** | Returns `exportJobId` in the body. |
| **T67.3** | `GET /reports/finance` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T67.4** | `GET /reports/finance` | Fail: Invalid Date | Auth Admin, Invalid `from`/`to` date | **422 Unprocessable** | `validation_error` |
