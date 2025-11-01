Following the structured plan and focusing on financial robustness, we proceed with **Task 40: Revenue Retry & Escalation Logic**.

This task implements the final layer of the `Revenue Calculation & Payouts Service`, establishing the mechanisms for handling failed payouts, retrying them using a deterministic strategy, and escalating them to an Admin upon permanent failure.

***

## **Task 40: Revenue Retry & Escalation Logic**

**Goal:** Implement the logic to detect failed payout items, apply an exponential backoff schedule for retries, and provide an endpoint (`POST /revenue/payouts/:id/retry`) for system workers or Admins to attempt re-execution.

**Service:** `Revenue Calculation & Payouts Service`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 32 (Payout Models/Service), Task 52 (Jobs/Worker Queue - for retry scheduling).

**Output Files:**
1.  `src/utils/retryPolicy.ts` (New file: Exponential Backoff utility)
2.  `src/services/revenue.service.ts` (Updated: `retryPayoutItem`, `handlePayoutFailure`)
3.  `src/controllers/revenue.controller.ts` (Updated: `retryPayoutController`)
4.  `src/routes/revenue.routes.ts` (Updated: new protected route)
5.  `test/unit/retry_logic.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /revenue/payouts/:id/retry** | `Params: { payoutItemId }` | `{ status: 'processing', attempts: number, nextRetryAt?: string }` | Auth (System/Admin) |

**Success Response (Retry Scheduled):**
```json
{
  "payoutItemId": "item_abc",
  "status": "processing",
  "attempts": 2,
  "message": "Payout re-queued for execution."
}
```

**Runtime & Env Constraints:**
*   **Determinism:** The retry interval calculation must be deterministic to ensure a consistent schedule. We will use a standard exponential backoff with jitter.
*   **State Machine:** Logic must handle the state transition: `failed` $\rightarrow$ `processing` (on retry) $\rightarrow$ `failed` or `paid`.
*   **Max Attempts:** Logic must enforce a `MAX_ATTEMPTS` limit before escalating the item (e.g., to Admin DLQ).

**Acceptance Criteria:**
*   A successful retry increments the `attempts` count on the `PayoutItem` and sets its status to `'processing'`.
*   If `attempts` reaches the `MAX_ATTEMPTS` limit (e.g., 5), the logic must flag the item for Admin review (e.g., set `status: 'failed'` and emit an escalation event).
*   The retry logic must calculate the next delay using the exponential backoff formula.
*   Access must be restricted to Admin/Finance roles (403 Forbidden).

**Tests to Generate:**
*   **Unit Test (Backoff):** Verify the `retryPolicy.ts` utility returns correct delays for attempts 1, 2, and 5.
*   **Integration Test (Retry Flow):** Test success path, and the final attempt that hits `MAX_ATTEMPTS` and escalates.

***

### **Task 40 Code Implementation**

#### **40.1. `src/utils/retryPolicy.ts` (New Utility File)**

```typescript
// src/utils/retryPolicy.ts

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 60000; // 1 minute base delay

/**
 * Calculates the next retry delay using exponential backoff with jitter.
 * Formula: BASE_DELAY * (2 ^ (attempt - 1)) + Jitter
 * @param attempt - The current attempt number (1-indexed).
 * @returns The delay in milliseconds.
 */
export function getExponentialBackoffDelay(attempt: number): number {
    if (attempt >= MAX_ATTEMPTS) {
        return -1; // Flag for permanent failure/escalation
    }
    
    // Calculate deterministic base exponential delay
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    
    // Add jitter (randomness up to 10% of the delay)
    const jitter = Math.floor(Math.random() * (delay * 0.1));

    return delay + jitter;
}

/**
 * Checks if a retry is allowed based on the current attempt count.
 */
export function isRetryAllowed(attempt: number): boolean {
    return attempt < MAX_ATTEMPTS;
}
```

#### **40.2. `src/services/revenue.service.ts` (Updates)**

```typescript
// src/services/revenue.service.ts (partial update)
// ... (Imports, PayoutBatchModel, RevenueService class definition) ...
import { getExponentialBackoffDelay, isRetryAllowed } from '../utils/retryPolicy';
import { PayoutBatchModel, IPayoutItem } from '../models/payout.model';

// Mock Job Queue (updated from Task 32)
class MockJobQueue {
    public enqueuePayoutJob(batchId: string, delayMs: number = 0): string {
        console.log(`[Job Enqueued] Payout execution for Batch ${batchId} scheduled in ${delayMs / 1000}s.`);
        return `job_payout_${crypto.randomBytes(4).toString('hex')}`;
    }
    public enqueueEscalationJob(payoutItemId: string, reason: string): void {
        console.log(`[Job Enqueued] ADMIN ESCALATION for Payout ${payoutItemId}. Reason: ${reason}`);
    }
}
const jobQueue = new MockJobQueue();


export class RevenueService {
    // ... (All previous methods) ...

    /**
     * Handles a permanent payout failure (e.g., invalid bank account, KYC failure) reported by PSP webhook.
     */
    public async handlePayoutFailure(payoutItemId: string, reason: string): Promise<void> {
        const itemObjectId = new Types.ObjectId(payoutItemId);
        
        // 1. Find the parent batch and item
        const batch = await PayoutBatchModel.findOne({ 'items._id': itemObjectId });
        if (!batch) { return; } // Safety check

        const itemIndex = batch.items.findIndex(i => i._id!.equals(itemObjectId));
        const item = batch.items[itemIndex];
        
        if (!item || item.status === 'paid' || item.status === 'cancelled') { return; } // State check

        // 2. Determine Next Action (Retry or Escalate)
        const nextAttempt = item.attempts + 1;
        
        if (isRetryAllowed(nextAttempt)) {
            // A. RETRY LOGIC (Self-correction for transient failure)
            const delay = getExponentialBackoffDelay(nextAttempt);
            
            // Update item status/attempts directly
            batch.items[itemIndex].status = 'scheduled';
            batch.items[itemIndex].attempts = nextAttempt;
            batch.items[itemIndex].failureReason = reason;

            // Enqueue job with calculated delay
            jobQueue.enqueuePayoutJob(batch.batchId, delay);
            console.log(`[Payout Retry] Item ${payoutItemId} failed (Attempt ${nextAttempt}). Re-queued with ${delay}ms delay.`);

        } else {
            // B. ESCALATION LOGIC (Permanent Failure)
            batch.items[itemIndex].status = 'failed';
            batch.items[itemIndex].failureReason = `Permanent failure after ${nextAttempt} attempts: ${reason}`;
            
            // Trigger Admin Escalation Job (Task 60)
            jobQueue.enqueueEscalationJob(payoutItemId, `MAX_ATTEMPTS reached. Reason: ${reason}`);
            console.warn(`[Payout Escalated] Item ${payoutItemId} escalated to admin DLQ.`);
        }
        
        // 3. Save the batch document and update overall batch status (if completed/partial)
        await batch.save();
        // PRODUCTION: Logic to update batch.status to 'partial' or 'completed' would go here
    }

    /** Admin/System-driven manual re-execution of a failed payout item. */
    public async retryPayoutItem(payoutItemId: string, requesterId: string): Promise<IPayoutItem> {
        const itemObjectId = new Types.ObjectId(payoutItemId);
        
        const batch = await PayoutBatchModel.findOne({ 'items._id': itemObjectId });
        if (!batch) { throw new Error('PayoutNotFound'); }
        
        const itemIndex = batch.items.findIndex(i => i._id!.equals(itemObjectId));
        const item = batch.items[itemIndex];

        if (!item) { throw new Error('PayoutNotFound'); }
        if (item.status === 'paid' || item.status === 'processing') { throw new Error('PayoutAlreadyActive'); }
        
        // 1. Reset/Increment State
        const nextAttempt = item.attempts + 1;
        batch.items[itemIndex].status = 'processing'; // Ready for immediate processing
        batch.items[itemIndex].attempts = nextAttempt;
        // Clear reason/failure for new attempt
        batch.items[itemIndex].failureReason = undefined; 
        
        await batch.save();
        
        // 2. Enqueue for IMMEDIATE execution (0 delay)
        jobQueue.enqueuePayoutJob(batch.batchId, 0); 
        
        // PRODUCTION: AuditLog 'payout.retry.initiated'
        console.log(`[Audit] Payout ${payoutItemId} manually retried by ${requesterId} (Attempt ${nextAttempt}).`);

        return batch.items[itemIndex];
    }
}
```

#### **40.3. `src/controllers/revenue.controller.ts` (Updates)**

```typescript
// src/controllers/revenue.controller.ts (partial update)
// ... (Imports, revenueService initialization, previous controllers) ...
import { body, param, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const retryPayoutValidation = [
    param('payoutItemId').isMongoId().withMessage('Payout Item ID is required and must be valid Mongo ID.'),
];


// --- Payout Management Controllers ---

/** Admin/System manually retries a failed payout. POST /revenue/payouts/:id/retry */
export const retryPayoutController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    // 1. Authorization Check (Admin/Finance Role)
    if (req.user!.role !== 'admin') { return res.status(403).json({ error: { code: 'not_admin', message: 'Access denied. Endpoint is for admin/system use only.' } }); }
    
    try {
        const { payoutItemId } = req.params;
        const requesterId = req.user!.sub;

        // 2. Service Call
        const updatedItem = await revenueService.retryPayoutItem(payoutItemId, requesterId);

        // 3. Success (200 OK)
        return res.status(200).json({
            payoutItemId: updatedItem._id!.toString(),
            status: updatedItem.status,
            attempts: updatedItem.attempts,
            message: 'Payout re-queued for immediate execution.'
        });

    } catch (error: any) {
        if (error.message === 'PayoutNotFound') { return res.status(404).json({ error: { code: 'payout_not_found', message: 'Payout item not found.' } }); }
        if (error.message === 'PayoutAlreadyActive') { return res.status(409).json({ error: { code: 'payout_active', message: 'Payout is already paid or processing.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during payout retry.' } });
    }
};
```

#### **40.4. `src/routes/revenue.routes.ts` (Updates)**

```typescript
// src/routes/revenue.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 31/32) ...
import { 
    retryPayoutController, retryPayoutValidation 
} from '../controllers/revenue.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const financeAccess = [PERMISSIONS.FINANCE_MANAGE];

// ... (POST /revenue/calculate and POST /schedule-payouts) ...

// POST /revenue/payouts/:payoutItemId/retry - Admin/System manually retries a failed payout (Task 40)
router.post(
    '/payouts/:payoutItemId/retry',
    authenticate,
    authorize(financeAccess), // RBAC check
    retryPayoutValidation,
    retryPayoutController
);

export default router;
```

#### **40.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T40.1** | `Unit Test` | Backoff Delay Check | Attempt 2 | N/A | Delay $\approx 2$ minutes (with jitter). |
| **T40.2** | `Service Test` | Failure Escalation | Item has `attempts=5` (Max) | N/A | Item status becomes `'failed'`; escalation job mock called. |
| **T40.3** | `POST /retry` | Happy Path: Manual Retry | Auth Admin, Payout=`failed` | **200 OK** | `status: processing`, `attempts` incremented. |
| **T40.4** | `POST /retry` | Fail: Already Paid | Auth Admin, Payout=`paid` | **409 Conflict** | `payout_active` |
| **T40.5** | `POST /retry` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |

---
