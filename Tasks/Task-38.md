Following the structured plan and focusing on the creator's financial experience, we proceed with **Task 38: Creator Earnings & Payouts Dashboard**.

This task implements the read-only endpoints for creators to track their income and monitor the status of their upcoming and past payouts.

***

## **Task 38: Creator Earnings & Payouts Dashboard**

**Goal:** Implement the creator-specific financial endpoints to list pending, earned, and processed payouts (`GET /earnings`) and retrieve details for a single payout (`GET /payouts/:id`).

**Service:** `Revenue Calculation & Payouts Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 32 (Payout Models), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/revenue.service.ts` (Updated: `listUserPayouts`, `getPayoutDetails`)
2.  `src/controllers/revenue.controller.ts` (Updated: new controllers)
3.  `src/routes/revenue.routes.ts` (Updated: new protected routes)
4.  `test/integration/payouts_read.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /earnings** | `query: { status?, page?, per_page? }` | `PayoutListResponse` (Paginated list of PayoutItems) | Auth (Self/Admin only) |
| **GET /payouts/:id** | `Params: { payoutItemId }` | `PayoutDetailDTO` (Single Payout Item) | Auth (Self/Admin only) |

**PayoutDetailDTO (Excerpt):**
```json
{
  "payoutItemId": "item_123",
  "projectId": "proj_abc",
  "netAmount": 95000,
  "status": "paid",
  "fees": 5000,
  "processedAt": "2025-11-01T15:00:00Z"
}
```

**Runtime & Env Constraints:**
*   **Authorization:** List and detail views must be strictly restricted to the recipient (`userId` in `IPayoutItem`) or Admin.
*   **Data Source:** Payout data is sourced from the `PayoutBatchModel`'s embedded `items` array.
*   **Performance:** Listing requires efficient lookup within the embedded arrays across potentially many batches. Mongoose aggregation/unwind may be necessary for filtering.

**Acceptance Criteria:**
*   `GET /earnings` must successfully query the `PayoutBatchModel` and unwind/filter the `items` to show only payouts belonging to the requester.
*   A non-recipient user attempting to access a payout detail returns **404 Not Found** (security by obscurity).
*   The list must correctly filter by `status` (e.g., `status: 'paid'` or `status: 'scheduled'`).

**Tests to Generate:**
*   **Integration Test (List):** Test creator listing their payouts, filtered by status.
*   **Integration Test (Detail Security):** Test non-recipient access failure (404).

***

### **Task 38 Code Implementation**

#### **38.1. `src/services/revenue.service.ts` (Updates)**

```typescript
// src/services/revenue.service.ts (partial update)
// ... (Imports, RevenueService class definition) ...
import { PayoutBatchModel, IPayoutItem } from '../models/payout.model';
import { IAuthUser } from '../middlewares/auth.middleware';

// Reusable interface for Payout List DTO
interface IPayoutListItemDTO {
    payoutItemId: string;
    projectId: string;
    netAmount: number;
    status: string;
    createdAt: string;
    fees: number;
}


export class RevenueService {
    // ... (calculateRevenueSplit, schedulePayouts methods) ...

    /** Lists a user's payouts with pagination and status filters. */
    public async listUserPayouts(requesterId: string, requesterRole: IAuthUser['role'], queryParams: any): Promise<any> {
        const { status, page = 1, per_page = 20 } = queryParams;
        const limit = parseInt(per_page);
        const skip = (page - 1) * limit;
        const recipientObjectId = new Types.ObjectId(requesterId);
        
        const pipeline: any[] = [];
        
        // 1. Match Payout Batches relevant to the recipient
        pipeline.push({ 
            $match: { 
                'items.userId': recipientObjectId,
                ...(status ? { 'items.status': status } : {}), // Filter items by status if provided
            } 
        });

        // 2. Unwind the items array (de-normalize the embedded documents)
        pipeline.push({ $unwind: '$items' });

        // 3. Re-match to filter out items not belonging to the recipient (necessary after unwind/status filter)
        pipeline.push({ 
            $match: { 
                'items.userId': recipientObjectId,
                ...(status ? { 'items.status': status } : {}),
            } 
        });

        // 4. Group (Count Total and Prepare for Final Projection)
        const countPipeline = [...pipeline]; // Copy pipeline up to $match
        countPipeline.push({ $count: 'total' });
        
        // 5. Sort, Skip, and Limit
        pipeline.push({ $sort: { 'items.createdAt': -1 } });
        pipeline.push({ $skip: skip });
        pipeline.push({ $limit: limit });

        // 6. Final Projection to DTO
        pipeline.push({
            $project: {
                _id: 0,
                payoutItemId: '$items._id',
                projectId: '$projectId',
                netAmount: '$items.netAmount',
                fees: '$items.fees',
                status: '$items.status',
                createdAt: '$items.createdAt',
            }
        });
        
        const [totalResults, payouts] = await Promise.all([
            PayoutBatchModel.aggregate(countPipeline),
            PayoutBatchModel.aggregate(pipeline) as Promise<IPayoutListItemDTO[]>
        ]);

        const total = totalResults.length > 0 ? totalResults[0].total : 0;
        
        return {
            meta: { page, per_page: limit, total, total_pages: Math.ceil(total / limit) },
            data: payouts,
        };
    }

    /** Retrieves detailed information for a single payout item. */
    public async getPayoutDetails(payoutItemId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<IPayoutItem> {
        const itemObjectId = new Types.ObjectId(payoutItemId);

        // 1. Find the item within its batch
        const batch = await PayoutBatchModel.findOne({ 'items._id': itemObjectId }).lean();
        if (!batch) { throw new Error('PayoutNotFound'); }

        const item = batch.items.find(i => i._id!.equals(itemObjectId));
        if (!item) { throw new Error('PayoutNotFound'); }

        // 2. Authorization Check (Self or Admin)
        const isRecipient = item.userId.toString() === requesterId;
        const isAdmin = requesterRole === 'admin';

        if (!isRecipient && !isAdmin) {
            throw new Error('PermissionDenied'); // Security by obscurity (404/403)
        }

        // 3. Map to DTO
        const detailDTO = {
            ...item,
            payoutItemId: item._id!.toString(),
            userId: item.userId.toString(),
            // Add denormalized batch/project info:
            projectId: batch.projectId.toString(),
            escrowId: batch.escrowId.toString(),
            // ...
        } as IPayoutItem;
        
        return detailDTO;
    }
}
```

#### **38.2. `src/controllers/revenue.controller.ts` (Updates)**

```typescript
// src/controllers/revenue.controller.ts (partial update)
// ... (Imports, revenueService initialization, previous controllers) ...
import { body, param, query, validationResult } from 'express-validator';

// --- Validation Middleware ---
export const payoutsReadValidation = [
    query('status').optional().isIn(['scheduled', 'processing', 'paid', 'failed']).withMessage('Invalid status filter.'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

export const payoutItemIdValidation = [
    param('payoutItemId').isMongoId().withMessage('Invalid Payout Item ID format.'),
];


// --- Creator Payout Controllers ---

/** Lists a creator's payouts (earnings dashboard). GET /earnings */
export const listUserPayoutsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const list = await revenueService.listUserPayouts(req.user!.sub, req.user!.role, req.query);
        
        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing payouts.' } });
    }
};

/** Retrieves detailed payout information. GET /payouts/:id */
export const getPayoutDetailsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid ID format.' }}); }

    try {
        const payout = await revenueService.getPayoutDetails(req.params.payoutItemId, req.user!.sub, req.user!.role);
        
        return res.status(200).json(payout);
    } catch (error: any) {
        if (error.message === 'PayoutNotFound' || error.message === 'PermissionDenied') { 
            return res.status(404).json({ error: { code: 'payout_not_found', message: 'Payout record not found or access denied.' } }); 
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving payout details.' } });
    }
};
```

#### **38.3. `src/routes/revenue.routes.ts` (Updates)**

```typescript
// src/routes/revenue.routes.ts (partial update)
import { Router } from 'express';
// ... (All previous imports) ...
import { 
    listUserPayoutsController, getPayoutDetailsController, 
    payoutsReadValidation, payoutItemIdValidation
} from '../controllers/revenue.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();
// ... (All previous routes) ...


// --- Creator Earnings Dashboard Endpoints (Task 38) ---

// GET /earnings - List user's payouts (earnings dashboard)
router.get(
    '/earnings',
    authenticate,
    payoutsReadValidation,
    listUserPayoutsController
);

// GET /payouts/:payoutItemId - Get specific payout details
router.get(
    '/payouts/:payoutItemId',
    authenticate,
    payoutItemIdValidation,
    getPayoutDetailsController
);


export default router;
```

#### **38.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T38.1** | `GET /earnings` | Happy Path: List Self | Auth Creator | **200 OK** | List contains only items where `userId` matches requester. |
| **T38.2** | `GET /earnings` | List Filtering | Auth Creator, `query: { status: 'paid' }` | **200 OK** | List only contains items where `status: 'paid'`. |
| **T38.3** | `GET /payouts/:id` | Happy Path: Detail Self | Auth Creator | **200 OK** | Returns full payout item details. |
| **T38.4** | `GET /payouts/:id` | Security: View Unauthorized | Auth Creator (Non-Recipient) | **404 Not Found** | `payout_not_found` (Security by obscurity). |

---
