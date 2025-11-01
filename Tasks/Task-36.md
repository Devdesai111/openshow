Following the structured plan and focusing on the completion of the core escrow lifecycle, we proceed with **Task 36: Escrow Funds Release & Refund (Owner/Admin)**.

This task is a critical piece of the financial system, implementing the final actions on escrowed funds: releasing them to trigger payouts (Task 32) or returning them to the payer.

***

## **Task 36: Escrow Funds Release & Refund (Owner/Admin)**

**Goal:** Implement the fund release endpoint (`POST /payments/escrow/release`) triggered by project approval (Task 30) and the fund refund endpoint (`POST /payments/escrow/refund`), both of which call the decoupled PSP adapter (Task 33) and update the `Escrow` state.

**Service:** `Payments & Escrow Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 35 (Escrow Model), Task 33 (Adapter Abstraction), Task 32 (Revenue Service - for payout scheduling).

**Output Files:**
1.  `src/services/payment.service.ts` (Updated: `releaseEscrow`, `refundEscrow`)
2.  `src/controllers/payment.controller.ts` (Updated: new controllers)
3.  `src/routes/payment.routes.ts` (Updated: new protected routes)
4.  `test/integration/escrow_release.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /payments/escrow/release** | `{ escrowId, releaseAmount? }` | `{ status: 'release_initiated', jobId: string }` | Auth (Owner/Admin) |
| **POST /payments/escrow/refund** | `{ escrowId, amount?, reason }` | `{ status: 'refund_initiated', providerRefundId }` | Auth (Admin/Owner) |

**Success Response (Release):**
```json
{
  "escrowId": "esc_xyz",
  "status": "release_initiated",
  "jobId": "job_payout_abc",
  "message": "Escrow release confirmed and payout job scheduled."
}
```

**Runtime & Env Constraints:**
*   **Decoupling:** Both methods must call the decoupled `IPaymentAdapter` for the actual PSP operation.
*   **Asynchronous Processing:** `releaseEscrow` must trigger the `RevenueService.schedulePayouts` (Task 32) after confirmation/mocked success.
*   **Security:** Both endpoints require strict authorization: Admin/Finance role for flexibility, or Project Owner for the specific release.

**Acceptance Criteria:**
*   `releaseEscrow` transitions the `Escrow.status` to `'released'` and emits an `escrow.released` event to the Payouts Service.
*   Both methods return **409 Conflict** if the `Escrow` is already in the target state (`released`/`refunded`) or not in a `locked` state.
*   `refundEscrow` creates a new `PaymentTransaction` record of `type: 'refund'` and calls the PSP adapter.
*   `releaseEscrow` must check that the requester is the project owner (or Admin).

**Tests to Generate:**
*   **Integration Test (Release):** Test owner success (200), non-owner failure (403), and already released failure (409).
*   **Integration Test (Refund):** Test Admin success (200) and locked state requirement (409).
*   **Integration Test (Job Trigger):** Verify `releaseEscrow` service method calls the mock `RevenueService.schedulePayouts`.

***

### **Task 36 Code Implementation**

#### **36.1. `src/services/payment.service.ts` (Updates)**

```typescript
// src/services/payment.service.ts (partial update)
// ... (Imports from Task 35) ...
import { IPaymentAdapter, ReleaseInputDTO, RefundInputDTO } from '../paymentAdapters/payment.interface';
import { PaymentAdapterFactory, PSPProvider } from '../paymentAdapters/adapter.factory';
import { EscrowModel, IEscrow } from '../models/escrow.model';
import { ProjectModel } from '../models/project.model';
import { IAuthUser } from '../middlewares/auth.middleware';

// Mock Revenue Service for scheduling payouts (Task 32 dependency)
class MockRevenueService {
    public async schedulePayouts(data: any): Promise<{ batchId: string }> {
        // PRODUCTION: Call RevenueService.schedulePayouts (Task 32)
        return { batchId: `batch_${crypto.randomBytes(4).toString('hex')}` };
    }
}
const revenueService = new MockRevenueService();


export class PaymentService {
    // ... (createPaymentIntent, lockEscrow, handleWebhook methods) ...

    /** Retrieves escrow record and performs owner/admin authorization check. */
    private async checkEscrowAccess(escrowId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<{ escrow: IEscrow, project: IProject }> {
        const escrow = await EscrowModel.findOne({ escrowId }).lean() as IEscrow;
        if (!escrow) { throw new Error('EscrowNotFound'); }

        const project = await ProjectModel.findById(escrow.projectId).lean() as IProject;
        if (!project) { throw new Error('ProjectNotFound'); }

        const isOwner = project.ownerId.toString() === requesterId;
        const isAdmin = requesterRole === 'admin';

        if (!isOwner && !isAdmin) { throw new Error('PermissionDenied'); }
        
        return { escrow, project };
    }

    /** Releases funds from escrow for payout. */
    public async releaseEscrow(escrowId: string, requesterId: string, requesterRole: IAuthUser['role'], releaseAmount?: number): Promise<{ escrow: IEscrow, jobId: string }> {
        const { escrow, project } = await this.checkEscrowAccess(escrowId, requesterId, requesterRole);

        // 1. STATE CHECK (Must be locked or disputed)
        if (escrow.status !== 'locked' && escrow.status !== 'disputed') {
            throw new Error('EscrowAlreadyProcessed');
        }
        if (escrow.status === 'disputed' && !requesterRole) {
             // Only Admin should be able to release a disputed escrow
             throw new Error('PermissionDeniedDisputed');
        }
        
        const amountToRelease = releaseAmount || escrow.amount;
        if (amountToRelease > escrow.amount) { throw new Error('ReleaseAmountInvalid'); }

        const adapter = PaymentAdapterFactory.getAdapter(escrow.provider as PSPProvider);

        // 2. CALL PSP ADAPTER (Trigger Capture/Transfer/Payout)
        const pspInput: ReleaseInputDTO = {
            providerPaymentId: escrow.providerEscrowId!,
            amount: amountToRelease,
            currency: escrow.currency,
            recipientId: escrow.projectId.toString(), // Mock recipient, actual logic is complex
        };
        const pspOutput = await adapter.releaseEscrow(pspInput);

        // 3. Update Escrow Status
        const updatedEscrow = await EscrowModel.findOneAndUpdate(
            { escrowId },
            { $set: { status: 'released', releasedAt: new Date() } },
            { new: true }
        ) as IEscrow;
        
        // 4. Trigger Payout Scheduling (Task 32)
        const { batchId } = await revenueService.schedulePayouts({
            escrowId,
            projectId: updatedEscrow.projectId.toString(),
            milestoneId: updatedEscrow.milestoneId.toString(),
            amount: updatedEscrow.amount,
            currency: updatedEscrow.currency,
            // NOTE: Requester is the Payer for scheduling context
        });

        // PRODUCTION: Emit 'escrow.released' event
        eventEmitter.emit('escrow.released', { escrowId, batchId, amount: updatedEscrow.amount });

        return { escrow: updatedEscrow, jobId: batchId };
    }

    /** Refunds escrowed funds to the payer. */
    public async refundEscrow(escrowId: string, requesterId: string, requesterRole: IAuthUser['role'], refundAmount: number, reason: string): Promise<any> {
        const { escrow } = await this.checkEscrowAccess(escrowId, requesterId, requesterRole); // Check owner/admin access

        // 1. STATE CHECK (Must be locked or disputed)
        if (escrow.status !== 'locked' && escrow.status !== 'disputed') {
            throw new Error('EscrowAlreadyProcessed');
        }
        if (refundAmount > escrow.amount) { throw new Error('RefundAmountInvalid'); }
        
        const adapter = PaymentAdapterFactory.getAdapter(escrow.provider as PSPProvider);
        
        // 2. CREATE REFUND TRANSACTION RECORD
        const newTxn = new PaymentTransactionModel({
            intentId: `ref_txn_${crypto.randomBytes(8).toString('hex')}`,
            projectId: escrow.projectId,
            payerId: escrow.payerId,
            provider: escrow.provider,
            type: 'refund',
            amount: refundAmount,
            currency: escrow.currency,
            status: 'pending',
            metadata: { escrowId, reason },
        });
        const savedTxn = await newTxn.save();

        // 3. CALL PSP ADAPTER
        const pspInput: RefundInputDTO = {
            providerPaymentId: escrow.providerEscrowId!, // Use original PSP charge/intent ID
            amount: refundAmount,
            reason: reason,
        };
        const pspOutput = await adapter.refundPayment(pspInput); // This is usually async

        // 4. Update Escrow (Optimistically mark as refunded or partial)
        const updatedEscrow = await EscrowModel.findOneAndUpdate(
            { escrowId },
            { 
                $set: { status: 'refunded', refundedAt: new Date() }, // Simple full refund status for Phase 1
                $push: { transactions: savedTxn._id! }
            },
            { new: true }
        ) as IEscrow;

        // PRODUCTION: Emit 'escrow.refunded' event
        eventEmitter.emit('escrow.refunded', { escrowId, amount: refundAmount });
        
        return { escrow: updatedEscrow, providerRefundId: pspOutput.providerRefundId };
    }
}
```

#### **36.2. `src/controllers/payment.controller.ts` (Updates)**

```typescript
// src/controllers/payment.controller.ts (partial update)
// ... (Imports, paymentService initialization, lockEscrowController) ...
import { body, param, validationResult } from 'express-validator';

// --- Escrow Validation Middleware ---
export const escrowIdParamValidation = [
    param('escrowId').isString().withMessage('Escrow ID is required.'),
];

export const releaseEscrowValidation = [
    ...escrowIdParamValidation,
    body('releaseAmount').optional().isInt({ min: 1 }).toInt().withMessage('Release amount must be a positive integer.'),
];

export const refundEscrowValidation = [
    ...escrowIdParamValidation,
    body('amount').isInt({ min: 1 }).toInt().withMessage('Refund amount is required and must be a positive integer.'),
    body('reason').isString().isLength({ min: 10 }).withMessage('A reason for refund is required.'),
];


// --- Escrow Controllers ---

/** Releases funds from escrow. POST /payments/escrow/release */
export const releaseEscrowController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }

    try {
        const { escrowId } = req.params;
        const result = await paymentService.releaseEscrow(escrowId, req.user!.sub, req.user!.role, req.body.releaseAmount);

        // Success (200 OK)
        return res.status(200).json({
            escrowId,
            status: 'release_initiated',
            jobId: result.jobId,
            message: 'Funds release confirmed and payout job scheduled.',
        });

    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner or admin can authorize release.' } }); }
        if (error.message === 'EscrowAlreadyProcessed') { return res.status(409).json({ error: { code: 'already_released', message: 'Escrow is already released or refunded.' } }); }
        if (error.message === 'EscrowNotFound') { return res.status(404).json({ error: { code: 'escrow_not_found', message: 'Escrow record not found.' } }); }
        if (error.message === 'ReleaseAmountInvalid') { return res.status(422).json({ error: { code: 'amount_invalid', message: 'Release amount exceeds the total escrow amount.' } }); }

        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during fund release.' } });
    }
};

/** Refunds escrowed funds. POST /payments/escrow/refund */
export const refundEscrowController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }

    try {
        const { escrowId } = req.params;
        const { amount, reason } = req.body;
        
        const result = await paymentService.refundEscrow(escrowId, req.user!.sub, req.user!.role, amount, reason);

        // Success (200 OK)
        return res.status(200).json({
            escrowId,
            status: 'refund_initiated',
            providerRefundId: result.providerRefundId,
            message: 'Refund process initiated with PSP. Status will be updated via webhook.',
        });

    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner or admin can authorize refunds.' } }); }
        if (error.message === 'EscrowAlreadyProcessed') { return res.status(409).json({ error: { code: 'already_released', message: 'Escrow is already released or refunded.' } }); }
        if (error.message === 'RefundAmountInvalid') { return res.status(422).json({ error: { code: 'amount_invalid', message: 'Refund amount exceeds the total escrow amount.' } }); }

        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during refund process.' } });
    }
};
```

#### **36.3. `src/routes/payment.routes.ts` (Updates)**

```typescript
// src/routes/payment.routes.ts (partial update)
import { Router } from 'express';
// ... (Task 34/35 Imports) ...
import { 
    releaseEscrowController, refundEscrowController, 
    releaseEscrowValidation, refundEscrowValidation, escrowIdParamValidation
} from '../controllers/payment.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const ownerAccess = [PERMISSIONS.PROJECT_CREATE]; // Owner is implicitly validated by ProjectService
const adminAccess = [PERMISSIONS.FINANCE_MANAGE]; // Finance Admin permission


// ... (POST /payments/intents and POST /payments/escrow/lock from Task 34/35) ...


// --- Escrow Management Endpoints (Task 36) ---

// POST /payments/escrow/release - Release escrow (Owner/Admin only)
router.post(
    '/escrow/:escrowId/release',
    authenticate,
    // NOTE: Owner/Admin permission is checked in the service (Task 36.1)
    releaseEscrowValidation,
    releaseEscrowController
);

// POST /payments/escrow/refund - Refund escrow (Owner/Admin only)
router.post(
    '/escrow/:escrowId/refund',
    authenticate,
    // NOTE: Owner/Admin permission is checked in the service (Task 36.1)
    refundEscrowValidation,
    refundEscrowController
);


export default router;
```

#### **36.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T36.1** | `POST /release` | Happy Path: Fund Release | Auth Owner, Escrow=`locked` | **200 OK** | N/A (`release_initiated` and Payout job mock called) |
| **T36.2** | `POST /release` | Fail: Already Released | Auth Owner, Escrow=`released` | **409 Conflict** | `already_released` |
| **T36.3** | `POST /release` | Fail: Not Owner | Auth Member | **403 Forbidden** | `not_owner` |
| **T36.4** | `POST /refund` | Happy Path: Refund | Auth Admin, Escrow=`locked` | **200 OK** | N/A (`refund_initiated` and PSP mock called) |
| **T36.5** | `POST /refund` | Fail: Invalid Amount | Auth Owner, `amount` > Escrow Total | **422 Unprocessable** | `amount_invalid` |

---

