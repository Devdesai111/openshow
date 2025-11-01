Following the structured plan and maintaining the financial focus, we proceed with **Task 32: Payouts Batching & Execution Schedule**.

This task builds the model and service logic for the final distribution of funds, which directly relies on the calculation from Task 31 and the milestones/escrow concept.

***

## **Task 32: Payouts Batching & Execution Schedule**

**Goal:** Implement the Payout and PayoutBatch data models and the internal service endpoint (`POST /revenue/schedule-payouts`) that consumes an escrow release event, calculates the final split (Task 31), and creates scheduled `PayoutItem` records.

**Service:** `Revenue Calculation & Payouts Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 31 (Revenue Calculation Engine), Task 12 (Project Model), Task 52 (Jobs/Worker Queue - for execution).

**Output Files:**
1.  `src/models/payout.model.ts` (New file: IPayoutBatch, IPayoutItem, Payout Models)
2.  `src/services/revenue.service.ts` (Updated: `schedulePayouts`)
3.  `src/controllers/revenue.controller.ts` (Updated: `schedulePayoutsController`)
4.  `src/routes/revenue.routes.ts` (Updated: new internal/admin route)
5.  `test/integration/payout_schedule.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (201 Created) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /revenue/schedule-payouts** | `{ escrowId, projectId, milestoneId, amount, currency }` | `{ batchId: string, status: 'scheduled', itemsCount: number }` | Auth (System/Admin) |

**PayoutBatchDTO (Excerpt):**
```json
{
  "batchId": "batch_456",
  "projectId": "proj_123",
  "status": "scheduled",
  "itemsCount": 2,
  "estimatedTotalPayout": 190000 
}
```

**Runtime & Env Constraints:**
*   **Idempotency:** The scheduling logic must be idempotent to prevent duplicate batches if the upstream escrow release event is replayed.
*   **System Access:** This endpoint is primarily for internal service-to-service communication (e.g., triggered by the Payments/Escrow Service upon release).
*   **Database:** Payouts must be persisted as immutable ledger entries.

**Acceptance Criteria:**
*   Successful scheduling returns **201 Created** and persists one `PayoutBatch` record linked to the `escrowId`.
*   The system uses `calculateRevenueSplit` internally to determine recipient amounts.
*   Attempting to schedule a payout for an `escrowId` that already has a scheduled batch returns **409 Conflict**.
*   The service must enqueue a job (Task 58) for execution of the batch (mocked event/log).

**Tests to Generate:**
*   **Integration Test (Schedule):** Test happy path, verifying the creation of the batch record and the final `netAmount`s match Task 31's output.
*   **Integration Test (Idempotency):** Test calling the endpoint twice with the same `escrowId` (409).

***

### **Task 32 Code Implementation**

#### **32.1. `src/models/payout.model.ts` (New Model)**

```typescript
// src/models/payout.model.ts
import { Schema, model, Types } from 'mongoose';

// --- Payout Item (The individual payment to a recipient) ---
export interface IPayoutItem {
  _id?: Types.ObjectId;
  userId: Types.ObjectId; // Recipient
  amount: number; // Gross amount before fees/tax (for audit/reconciliation)
  fees: number; // Platform fee deducted from this share
  taxWithheld: number; // Tax deducted from this share
  netAmount: number; // Final amount to be paid (amount - fees - tax)
  providerPayoutId?: string; // PSP reference ID (e.g., Stripe transfer ID)
  status: 'scheduled' | 'processing' | 'paid' | 'failed' | 'cancelled' | 'pending_kyc';
  failureReason?: string;
  attempts: number;
  processedAt?: Date;
}

// --- Payout Batch (A collection of items scheduled together for an escrow event) ---
export interface IPayoutBatch {
  _id?: Types.ObjectId;
  batchId: string;
  escrowId: Types.ObjectId; // Critical link to Escrow Event
  projectId?: Types.ObjectId;
  milestoneId?: Types.ObjectId;
  scheduledBy: Types.ObjectId; // System or Admin ID
  currency: string;
  items: IPayoutItem[]; // Embedded array of individual payouts
  totalNet: number; // Sum of all netAmounts in items
  status: 'scheduled' | 'processing' | 'completed' | 'failed' | 'partial';
  createdAt?: Date;
  updatedAt?: Date;
}

const PayoutItemSchema = new Schema<IPayoutItem>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  fees: { type: Number, default: 0 },
  taxWithheld: { type: Number, default: 0 },
  netAmount: { type: Number, required: true },
  providerPayoutId: { type: String },
  status: { type: String, enum: ['scheduled', 'processing', 'paid', 'failed', 'cancelled', 'pending_kyc'], default: 'scheduled' },
  failureReason: { type: String },
  attempts: { type: Number, default: 0 },
  processedAt: { type: Date },
}, { _id: true }); // Embedded item needs its own ID

const PayoutBatchSchema = new Schema<IPayoutBatch>({
  batchId: { type: String, required: true, unique: true, default: () => `batch_${crypto.randomBytes(6).toString('hex')}` },
  escrowId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true }, // Idempotency key for scheduling
  projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  milestoneId: { type: Schema.Types.ObjectId },
  scheduledBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  currency: { type: String, required: true },
  items: { type: [PayoutItemSchema], required: true },
  totalNet: { type: Number, required: true },
  status: { type: String, enum: ['scheduled', 'processing', 'completed', 'failed', 'partial'], default: 'scheduled', index: true },
}, { timestamps: true });

export const PayoutBatchModel = model<IPayoutBatch>('PayoutBatch', PayoutBatchSchema);
export const PayoutItemModel = model<IPayoutItem>('PayoutItem', PayoutItemSchema); // Exported for potential future use
```

#### **32.2. `src/services/revenue.service.ts` (Updates)**

```typescript
// src/services/revenue.service.ts (partial update)
// ... (Imports, RevenueService class definition) ...
import { PayoutBatchModel } from '../models/payout.model';
import { calculateRevenueSplit } from '../utils/revenueCalculator';
import { Types } from 'mongoose';

// Mock Job Queue (updated from Task 28)
class MockJobQueue {
    // ... (enqueueAnchorJob)
    public enqueuePayoutJob(batchId: string): string {
        console.log(`[Job Enqueued] Payout execution for Batch ${batchId}.`);
        return `job_payout_${crypto.randomBytes(4).toString('hex')}`;
    }
}
const jobQueue = new MockJobQueue();

interface ISchedulePayoutsRequestDTO {
    escrowId: string;
    projectId: string;
    milestoneId: string;
    amount: number; // Total escrow amount
    currency: string;
    // NOTE: requesterId is passed via controller
}

export class RevenueService {
    // ... (calculateRevenueSplit method from Task 31) ...

    /** Schedules payouts for a released escrow amount. */
    public async schedulePayouts(requesterId: string, data: ISchedulePayoutsRequestDTO): Promise<IPayoutBatch> {
        const { escrowId, projectId, milestoneId, amount, currency } = data;
        const escrowObjectId = new Types.ObjectId(escrowId);
        const projectObjectId = new Types.ObjectId(projectId);

        // 1. IDEMPOTENCY CHECK (CRITICAL)
        const existingBatch = await PayoutBatchModel.findOne({ escrowId: escrowObjectId });
        if (existingBatch) {
            throw new Error('PayoutAlreadyScheduled');
        }

        // 2. Calculate Final Breakdown (Leverage Task 31 logic)
        const breakdown = await this.calculateRevenueSplit({ projectId, amount, currency });
        
        // 3. Map Breakdown to Payout Items
        const payoutItems: IPayoutItem[] = breakdown.breakdown.map((share: any) => {
            // NOTE: We assume recipientId is a valid userId for payout (further KYC checks later)
            return {
                userId: new Types.ObjectId(share.recipientId), 
                amount: share.grossShare,
                fees: share.platformFeeShare,
                taxWithheld: share.taxWithheldShare || 0,
                netAmount: share.netAmount,
                status: 'scheduled',
                attempts: 0,
            } as IPayoutItem;
        });

        // 4. Create Payout Batch Record
        const newBatch = new PayoutBatchModel({
            escrowId: escrowObjectId,
            projectId: projectObjectId,
            milestoneId: milestoneId ? new Types.ObjectId(milestoneId) : undefined,
            scheduledBy: new Types.ObjectId(requesterId),
            currency,
            items: payoutItems,
            totalNet: breakdown.totalDistributed,
            status: 'scheduled',
        });
        const savedBatch = await newBatch.save();

        // 5. Enqueue Execution Job (Task 58)
        const jobId = jobQueue.enqueuePayoutJob(savedBatch.batchId);
        
        // PRODUCTION: Emit 'payout.batch.scheduled' event
        eventEmitter.emit('payout.batch.scheduled', { batchId: savedBatch.batchId, jobId });

        return savedBatch.toObject() as IPayoutBatch;
    }
}```

#### **32.3. `src/controllers/revenue.controller.ts` (Updates)**

```typescript
// src/controllers/revenue.controller.ts (partial update)
// ... (Imports, revenueService initialization, calculatePreviewController) ...

import { body, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const schedulePayoutsValidation = [
    body('escrowId').isMongoId().withMessage('Escrow ID is required and must be valid Mongo ID.'),
    body('projectId').isMongoId().withMessage('Project ID is required and must be valid Mongo ID.'),
    body('milestoneId').optional().isMongoId().withMessage('Milestone ID must be valid Mongo ID.'),
    body('amount').isInt({ min: 1 }).toInt().withMessage('Amount must be a positive integer (cents).'),
    body('currency').isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter ISO code.'),
];


/** Schedules payouts from a released escrow. POST /revenue/schedule-payouts */
export const schedulePayoutsController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    // 2. Authorization Check: Must be System/Admin (Internal Call)
    if (req.user!.role !== 'admin') { return res.status(403).json({ error: { code: 'not_system', message: 'Access denied. Endpoint is for system/admin use only.' } }); }

    try {
        const requesterId = req.user!.sub; // Admin/System ID
        
        // 3. Service Call (Idempotency check performed inside service)
        const savedBatch = await revenueService.schedulePayouts(requesterId, req.body);

        // 4. Success (201 Created)
        return res.status(201).json({
            batchId: savedBatch.batchId,
            status: savedBatch.status,
            itemsCount: savedBatch.items.length,
            estimatedTotalPayout: savedBatch.totalNet,
            message: 'Payout batch scheduled and execution job queued.',
        });

    } catch (error: any) {
        // 5. Error Handling
        if (error.message === 'PayoutAlreadyScheduled') { return res.status(409).json({ error: { code: 'already_scheduled', message: 'Payout for this escrow is already scheduled.' } }); }
        if (error.message.includes('RevenueSplitInvalid')) { return res.status(422).json({ error: { code: 'split_invalid', message: 'Revenue model validation failed during scheduling.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error scheduling payouts.' } });
    }
};
```

#### **32.4. `src/routes/revenue.routes.ts` (Updates)**

```typescript
// src/routes/revenue.routes.ts (partial update)
import { Router } from 'express';
import { calculatePreviewController, calculateRevenueValidation, schedulePayoutsController, schedulePayoutsValidation } from '../controllers/revenue.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// ... (POST /revenue/calculate from Task 31) ...

// POST /revenue/schedule-payouts - Schedule payouts from released escrow (Task 32)
router.post(
    '/schedule-payouts',
    authenticate,
    authorize([PERMISSIONS.ADMIN_DASHBOARD]), // Simulating Internal Service Token access
    schedulePayoutsValidation,
    schedulePayoutsController
);

export default router;
```

#### **32.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T32.1** | `POST /schedule` | Happy Path: Schedule Batch | Auth Admin, Valid Escrow/Project | **201 Created** | N/A |
| **T32.2** | `POST /schedule` | Fail: Idempotency Check | Auth Admin, Same `escrowId` twice | **409 Conflict** | `already_scheduled` |
| **T32.3** | `POST /schedule` | Fail: Not Admin | Auth Creator | **403 Forbidden** | `not_system` |
| **T32.4** | `POST /schedule` | Fail: Invalid Splits | Escrow with invalid revenue splits | **422 Unprocessable** | `split_invalid` |

---
