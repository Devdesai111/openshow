Following the structured plan and focusing on financial controls, we proceed with **Task 39: Admin Financial Oversight & Txn Query**.

This task implements the administrative tools necessary for financial auditing, oversight, and reporting across all transactions and payout batches, requiring high-level RBAC authorization.

***

## **Task 39: Admin Financial Oversight & Txn Query**

**Goal:** Implement the Admin-specific endpoints for listing all transaction history (`GET /admin/payments/ledger`) and retrieving the full list of payout batches (`GET /admin/payouts/batches`), restricted by the `FINANCE_MANAGE` permission.

**Service:** `Payments & Escrow Service` & `Revenue Calculation & Payouts Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 37 (Transaction Model/Service), Task 38 (Payout Model/Service), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/payment.service.ts` (Updated: `listAllLedgerTransactions`)
2.  `src/services/revenue.service.ts` (Updated: `listAllPayoutBatches`)
3.  `src/controllers/admin.controller.ts` (New file: dedicated Admin controllers)
4.  `src/routes/admin.routes.ts` (New file: router for `/admin`)
5.  `test/integration/admin_finance.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /admin/payments/ledger** | `query: { from?, to?, status?, provider? }` | `TransactionListResponse` (All Transactions) | Auth (Admin/Finance) |
| **GET /admin/payouts/batches** | `query: { status?, projectId?, page? }` | `PayoutBatchListResponse` (All Batches) | Auth (Admin/Finance) |

**TransactionListResponse (Admin View):**
```json
{
  "meta": { "total": 125 },
  "data": [
    { "transactionId": "txn_001", "payerId": "user_1", "amount": 50000, "status": "succeeded" }
  ]
}
```

**Runtime & Env Constraints:**
*   **Security:** Both endpoints must be protected by the `authorize([PERMISSIONS.FINANCE_MANAGE])` middleware check.
*   **Performance:** Queries should use time-based indexes (`createdAt`, `from`, `to`) for efficient ledger scanning.
*   The transaction list should return **all** fields (except sensitive secrets) for full administrative review.

**Acceptance Criteria:**
*   A non-Admin user attempting access returns **403 Forbidden**.
*   The ledger endpoint successfully lists all transactions and allows filtering by date range (`from`/`to`).
*   The batches endpoint successfully lists all `PayoutBatch` records and allows filtering by `status`.

**Tests to Generate:**
*   **Integration Test (Ledger Query):** Test Admin successfully querying the full ledger and filtering by a date range.
*   **Integration Test (Batch Query):** Test Admin successfully listing all payout batches and filtering by status.
*   **Integration Test (Security):** Test unauthorized access on both endpoints (403).

***

### **Task 39 Code Implementation**

#### **39.1. `src/services/payment.service.ts` (Updates)**

```typescript
// src/services/payment.service.ts (partial update)
// ... (Imports, PaymentTransactionModel, PaymentService class definition) ...

export class PaymentService {
    // ... (All previous methods) ...

    /** Admin function to list ALL financial transactions in the ledger. */
    public async listAllLedgerTransactions(queryParams: any): Promise<any> {
        const { from, to, status, provider, page = 1, per_page = 20 } = queryParams;
        const limit = parseInt(per_page);
        const skip = (page - 1) * limit;

        const filters: any = {};
        
        // Date Range Filtering (CRITICAL for ledger audit)
        if (from || to) {
            filters.createdAt = {};
            if (from) filters.createdAt.$gte = new Date(from);
            if (to) filters.createdAt.$lte = new Date(to);
        }

        // Additional Filters
        if (status) filters.status = status;
        if (provider) filters.provider = provider;
        
        // Execution
        const [totalResults, transactions] = await Promise.all([
            PaymentTransactionModel.countDocuments(filters),
            PaymentTransactionModel.find(filters)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IPaymentTransaction[]>
        ]);

        // Map to full Admin DTO (all details except internal Mongo IDs/secrets)
        const data = transactions.map(txn => ({
            ...txn,
            transactionId: txn.intentId,
            payerId: txn.payerId.toString(),
            projectId: txn.projectId?.toString(),
            milestoneId: txn.milestoneId?.toString(),
            createdAt: txn.createdAt!.toISOString(),
            // No redaction as this is an Admin endpoint
        }));

        return {
            meta: { page, per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data,
        };
    }
}
```

#### **39.2. `src/services/revenue.service.ts` (Updates)**

```typescript
// src/services/revenue.service.ts (partial update)
// ... (Imports, PayoutBatchModel, RevenueService class definition) ...

export class RevenueService {
    // ... (calculateRevenueSplit, schedulePayouts, listUserPayouts, getPayoutDetails methods) ...

    /** Admin function to list ALL payout batches. */
    public async listAllPayoutBatches(queryParams: any): Promise<any> {
        const { status, projectId, page = 1, per_page = 20 } = queryParams;
        const limit = parseInt(per_page);
        const skip = (page - 1) * limit;
        
        const filters: any = {};
        if (status) filters.status = status;
        if (projectId) filters.projectId = new Types.ObjectId(projectId);

        // Execution
        const [totalResults, batches] = await Promise.all([
            PayoutBatchModel.countDocuments(filters),
            PayoutBatchModel.find(filters)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IPayoutBatch[]>
        ]);
        
        // Map to Admin DTO (includes full items array)
        const data = batches.map(batch => ({
            ...batch,
            scheduledBy: batch.scheduledBy.toString(),
            projectId: batch.projectId?.toString(),
            escrowId: batch.escrowId.toString(),
            // All items included in the batch for full oversight
            items: batch.items.map(item => ({ 
                ...item, 
                userId: item.userId.toString(), 
                payoutItemId: item._id?.toString() 
            })),
            createdAt: batch.createdAt!.toISOString(),
        }));

        return {
            meta: { page, per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data,
        };
    }
}
```

#### **39.3. `src/controllers/admin.controller.ts` (New File)**

```typescript
// src/controllers/admin.controller.ts
import { Request, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { PaymentService } from '../services/payment.service';
import { RevenueService } from '../services/revenue.service';

const paymentService = new PaymentService();
const revenueService = new RevenueService();

// --- Validation Middleware ---

export const adminLedgerValidation = [
    query('from').optional().isISO8601().toDate().withMessage('From date must be valid ISO 8601.'),
    query('to').optional().isISO8601().toDate().withMessage('To date must be valid ISO 8601.'),
    query('status').optional().isString().withMessage('Status filter must be a string.'),
    query('provider').optional().isString().withMessage('Provider filter must be a string.'),
    // ... (page/per_page validation reused)
];

export const adminBatchValidation = [
    query('projectId').optional().isMongoId().withMessage('Project ID must be valid Mongo ID.'),
    query('status').optional().isString().withMessage('Status filter must be a string.'),
];


// --- Admin Financial Controllers ---

/** Lists all transactions in the ledger. GET /admin/payments/ledger */
export const listAdminLedgerController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const list = await paymentService.listAllLedgerTransactions(req.query);
        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing ledger.' } });
    }
};

/** Lists all payout batches. GET /admin/payouts/batches */
export const listAdminPayoutBatchesController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const list = await revenueService.listAllPayoutBatches(req.query);
        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing batches.' } });
    }
};
```

#### **39.4. `src/routes/admin.routes.ts` (New File)**

```typescript
// src/routes/admin.routes.ts
import { Router } from 'express';
import { 
    listAdminLedgerController, listAdminPayoutBatchesController, 
    adminLedgerValidation, adminBatchValidation
} from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
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
```

#### **39.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T39.1** | `GET /payments/ledger` | Happy Path: Full List | Auth Admin (Finance Role) | **200 OK** | Returns full list of all `PaymentTransaction` records. |
| **T39.2** | `GET /payments/ledger` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T39.3** | `GET /payments/ledger` | Filter: Date Range | Auth Admin, `query: { from: '2025-01-01' }` | **200 OK** | List only contains transactions on or after the specified date. |
| **T39.4** | `GET /payouts/batches` | Happy Path: List All Batches | Auth Admin (Finance Role) | **200 OK** | Returns full list of all `PayoutBatch` records. |
| **T39.5** | `GET /payouts/batches` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |

---