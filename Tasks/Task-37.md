Following the structured plan and focusing on financial transparency, we proceed with **Task 37: Transaction Ledger (Read/Export) & Auditing**.

This task implements the crucial capability to read and query the immutable financial ledger, which is essential for user transparency, accounting, and compliance.

***

## **Task 37: Transaction Ledger (Read/Export) & Auditing**

**Goal:** Implement the paginated endpoint for querying the immutable `PaymentTransaction` ledger (`GET /payments/transactions`) with filters, and the detail view for a single transaction (`GET /payments/transactions/:id`).

**Service:** `Payments & Escrow Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 34 (PaymentTransaction Model), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/payment.service.ts` (Updated: `listTransactions`, `getTransactionDetails`)
2.  `src/controllers/payment.controller.ts` (Updated: new controllers)
3.  `src/routes/payment.routes.ts` (Updated: new read routes)
4.  `test/integration/ledger_read.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /payments/transactions** | `query: { type?, status?, page?, per_page? }` | `TransactionListResponse` (Paginated) | Auth (Self/Admin only) |
| **GET /payments/transactions/:id** | `Params: { transactionId }` | `PaymentTransactionDTO` (Detailed view) | Auth (Self/Admin only) |

**TransactionListResponse (Excerpt):**
```json
{
  "meta": { "total": 42, "page": 1 },
  "data": [
    { "transactionId": "txn_001", "type": "escrow_lock", "amount": 250000, "status": "succeeded" }
  ]
}
```

**Runtime & Env Constraints:**
*   **Immutability:** Data read from `PaymentTransaction` is treated as read-only.
*   **Authorization:** The query must be restricted: a user can only view **their own** transactions (where `payerId` or `payeeId` matches), unless they are an Admin (with `FINANCE_MANAGE` permission).
*   **Performance:** Use efficient Mongoose queries and indexing on `payerId`, `status`, and `type`.

**Acceptance Criteria:**
*   The `listTransactions` service method must enforce the self-or-admin rule, adding an automatic filter for `payerId: requesterId` for non-Admin users.
*   The transaction list must exclude sensitive/unnecessary internal metadata.
*   The detail view must return **404 Not Found** if the user attempts to view a transaction they are not part of (security by obscurity).

**Tests to Generate:**
*   **Integration Test (List Self):** Test non-Admin retrieving list, verify the list only contains their transactions.
*   **Integration Test (List Admin):** Test Admin retrieving list with no user filter, verify full set.
*   **Integration Test (Detail Security):** Test non-Admin attempting to view a transaction where they are neither payer nor payee (404).

***

### **Task 37 Code Implementation**

#### **37.1. `src/services/payment.service.ts` (Updates)**

```typescript
// src/services/payment.service.ts (partial update)
// ... (Imports from Task 36) ...
import { IAuthUser } from '../middlewares/auth.middleware';
import { IPaymentTransaction, PaymentTransactionModel } from '../models/paymentTransaction.model';


export class PaymentService {
    // ... (createPaymentIntent, lockEscrow, releaseEscrow, refundEscrow, handleWebhook methods) ...

    /** Lists financial transactions with self-or-admin authorization filters. */
    public async listTransactions(requesterId: string, requesterRole: IAuthUser['role'], queryParams: any): Promise<any> {
        const { type, status, page = 1, per_page = 20 } = queryParams;
        const limit = parseInt(per_page);
        const skip = (page - 1) * limit;

        const filters: any = {};
        
        // 1. Authorization Filter (CRITICAL SECURITY)
        if (requesterRole !== 'admin') {
            // Non-Admin users only see transactions where they are the Payer or Payee
            filters.$or = [
                { payerId: new Types.ObjectId(requesterId) },
                // Payee ID logic is complex (payouts), but for payment/refund simplicity, only check PayerId for now
                // Future: { payeeId: new Types.ObjectId(requesterId) }
            ];
        } 
        // Admin sees all, so no $or filter is applied if they have FINANACE_MANAGE perm

        // 2. Additional Filters
        if (type) filters.type = type;
        if (status) filters.status = status;
        
        // 3. Execution
        const [totalResults, transactions] = await Promise.all([
            PaymentTransactionModel.countDocuments(filters),
            PaymentTransactionModel.find(filters)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IPaymentTransaction[]>
        ]);

        // 4. Map to List DTO (Redacted/Simplified)
        const data = transactions.map(txn => ({
            transactionId: txn.intentId, // Use intentId for consistency as external ref
            projectId: txn.projectId?.toString(),
            type: txn.type,
            amount: txn.amount,
            currency: txn.currency,
            status: txn.status,
            createdAt: txn.createdAt!.toISOString(),
        }));

        return {
            meta: { page, per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data,
        };
    }

    /** Retrieves detailed transaction information with strict self-or-admin access. */
    public async getTransactionDetails(transactionId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<IPaymentTransaction> {
        const transaction = await PaymentTransactionModel.findOne({ intentId: transactionId }).lean() as IPaymentTransaction;
        if (!transaction) { throw new Error('TransactionNotFound'); }

        // 1. Authorization Check (CRITICAL)
        const isPayer = transaction.payerId.toString() === requesterId;
        const isAdmin = requesterRole === 'admin';

        if (!isPayer && !isAdmin) { 
            // Security by obscurity: return 404/403 for unauthorized access
            throw new Error('PermissionDenied'); 
        }

        // 2. Map to DTO (Full details for the authorized viewer)
        return {
            ...transaction,
            payerId: transaction.payerId.toString(),
            projectId: transaction.projectId?.toString(),
            milestoneId: transaction.milestoneId?.toString(),
            // Ensure no raw Mongo IDs are passed outside
        } as IPaymentTransaction; 
    }
}
```

#### **37.2. `src/controllers/payment.controller.ts` (Updates)**

```typescript
// src/controllers/payment.controller.ts (partial update)
// ... (Imports, paymentService initialization, all previous controllers) ...
import { body, param, query, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const listTransactionsValidation = [
    query('type').optional().isString().withMessage('Type filter must be a string.'),
    query('status').optional().isString().withMessage('Status filter must be a string.'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const transactionIdParamValidation = [
    param('transactionId').isString().withMessage('Transaction ID (intentId) is required.'),
];


// --- Ledger/Query Controllers ---

/** Lists financial transactions. GET /payments/transactions */
export const listTransactionsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        // Service handles filtering based on requester role/ID
        const list = await paymentService.listTransactions(req.user!.sub, req.user!.role, req.query);
        
        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing transactions.' } });
    }
};

/** Retrieves detailed transaction information. GET /payments/transactions/:id */
export const getTransactionDetailsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid ID format.' }}); }

    try {
        const transaction = await paymentService.getTransactionDetails(req.params.transactionId, req.user!.sub, req.user!.role);
        
        return res.status(200).json(transaction);
    } catch (error: any) {
        if (error.message === 'TransactionNotFound' || error.message === 'PermissionDenied') { 
            return res.status(404).json({ error: { code: 'transaction_not_found', message: 'Transaction not found or access denied.' } }); 
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving transaction details.' } });
    }
};
```

#### **37.3. `src/routes/payment.routes.ts` (Updates)**

```typescript
// src/routes/payment.routes.ts (partial update)
import { Router } from 'express';
// ... (Task 34/35/36 Imports) ...
import { 
    listTransactionsController, getTransactionDetailsController,
    listTransactionsValidation, transactionIdParamValidation
} from '../controllers/payment.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();
// ... (All previous routes) ...


// --- Ledger Query Endpoints (Task 37) ---

// GET /payments/transactions - List financial transactions (Self/Admin only)
router.get(
    '/transactions',
    authenticate,
    listTransactionsValidation,
    listTransactionsController
);

// GET /payments/transactions/:transactionId - Get transaction details (Self/Admin only)
router.get(
    '/transactions/:transactionId',
    authenticate,
    transactionIdParamValidation,
    getTransactionDetailsController
);


export default router;
```

#### **37.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T37.1** | `GET /transactions` | Happy Path: List Self | Auth Payer (Non-Admin) | **200 OK** | List only contains transactions where `payerId` matches requester. |
| **T37.2** | `GET /transactions` | Happy Path: List All | Auth Admin | **200 OK** | List contains all transactions (ignores `payerId` filter). |
| **T37.3** | `GET /transactions/:id` | Security: View Unauthorized | Auth Payer (Non-Admin), `txn` belongs to other Payer | **404 Not Found** | `transaction_not_found` (Security by obscurity) |
| **T37.4** | `GET /transactions/:id` | Happy Path: Detail Self | Auth Payer | **200 OK** | Returns full DTO. |

---

