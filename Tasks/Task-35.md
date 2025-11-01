Following the structured plan and focusing on the core of the financial system, we proceed with **Task 35: Payments Escrow Core (Lock Funds & Webhooks)**.

This task is **CRITICAL**, as it implements the fund holding mechanism (`EscrowModel`) and the essential webhook receiver to handle asynchronous confirmation of payment success from the PSP.

***

## **Task 35: Payments Escrow Core (Lock Funds & Webhooks)**

**Goal:** Implement the `Escrow` model, the internal endpoint to lock funds into escrow (`POST /payments/escrow/lock`), and the external webhook receiver (`POST /webhooks/payments`) to update `PaymentTransaction` and trigger the final `escrow.locked` event.

**Service:** `Payments & Escrow Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 34 (PaymentTransaction Model, Intent Logic), Task 12 (Project Model), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/escrow.model.ts` (New file: IEscrow, EscrowSchema/Model)
2.  `src/services/payment.service.ts` (Updated: `lockEscrow`, `handleWebhook`)
3.  `src/controllers/payment.controller.ts` (Updated: `lockEscrowController`, `webhookController`)
4.  `src/routes/payment.routes.ts` (Updated: new routes)
5.  `test/integration/escrow_lock.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Headers) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /payments/escrow/lock** | `{ intentId, providerPaymentId, projectId, amount, currency }` | `{ escrowId, status: 'locked' }` | Auth (Payer/Internal) |
| **POST /webhooks/payments** | Raw PSP Payload, `X-PSP-Signature` | **200 OK** | Public (Signature Validation) |

**Success Response (Lock):**
```json
{
  "escrowId": "esc_xyz789",
  "status": "locked",
  "message": "Funds locked successfully and project milestone updated."
}
```

**Runtime & Env Constraints:**
*   **Webhooks Security:** The webhook endpoint **must** verify the PSP signature using a secret stored in the environment (`process.env.STRIPE_WEBHOOK_SECRET`).
*   **Idempotency:** The `lockEscrow` logic must prevent duplicate escrow records (check against `milestoneId` or `intentId`).
*   **Atomic Update:** The webhook handler must perform a sequence: Transaction Update $\rightarrow$ Escrow Create $\rightarrow$ Project Update (mocked).

**Acceptance Criteria:**
*   `POST /webhooks/payments` must return **401 Unauthorized** if the signature validation fails (mocked check).
*   The webhook handler successfully updates the `PaymentTransaction.status` to `'succeeded'` and triggers the `lockEscrow` flow internally.
*   `lockEscrow` successfully creates an `Escrow` record linked to the `PaymentTransaction` and emits an `escrow.locked` event.
*   Attempting to lock an escrow for an intent already linked to an escrow returns **409 Conflict**.

**Tests to Generate:**
*   **Integration Test (Webhook Failure):** Test invalid webhook signature (401).
*   **Integration Test (Lock Flow):** Test an internal call to `lockEscrow` creates `Escrow` and updates a mock `ProjectModel.milestone` with `escrowId`.
*   **Integration Test (Lock Idempotency):** Test duplicate lock attempts (409).

***

### **Task 35 Code Implementation**

#### **35.1. `src/models/escrow.model.ts` (New Model)**

```typescript
// src/models/escrow.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IEscrow {
  _id?: Types.ObjectId;
  escrowId: string;
  projectId: Types.ObjectId;
  milestoneId: Types.ObjectId;
  payerId: Types.ObjectId;
  amount: number;
  currency: string;
  provider: 'stripe' | 'razorpay' | 'other';
  providerEscrowId?: string; // PSP ID used for fund identification (charge/intent ID)
  status: 'locked' | 'released' | 'refunded' | 'disputed';
  lockedAt?: Date;
  releasedAt?: Date;
  refundedAt?: Date;
  transactions: Types.ObjectId[]; // References to PaymentTransaction IDs
  createdAt?: Date;
  updatedAt?: Date;
}

const EscrowSchema = new Schema<IEscrow>({
  escrowId: { type: String, required: true, unique: true, default: () => `esc_${crypto.randomBytes(8).toString('hex')}` },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  milestoneId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true }, // UNIQUE per milestone
  payerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true },
  provider: { type: String, enum: ['stripe', 'razorpay', 'other'], required: true },
  providerEscrowId: { type: String },
  status: { type: String, enum: ['locked', 'released', 'refunded', 'disputed'], default: 'locked', index: true },
  lockedAt: { type: Date, default: Date.now },
  releasedAt: { type: Date },
  refundedAt: { type: Date },
  transactions: [{ type: Schema.Types.ObjectId, ref: 'PaymentTransaction' }],
}, { timestamps: true });

export const EscrowModel = model<IEscrow>('Escrow', EscrowSchema);
```

#### **35.2. `src/services/payment.service.ts` (Updates)**

```typescript
// src/services/payment.service.ts (partial update)
// ... (Imports from Task 34) ...
import { EscrowModel, IEscrow } from '../models/escrow.model';
import { ProjectModel } from '../models/project.model';
import { PayoutBatchModel } from '../models/payout.model';
import { Types } from 'mongoose';

// Mock Webhook Signature Utility
class WebhookSecurity {
    public verifySignature(payload: string, signature: string, secret: string): boolean {
        // PRODUCTION: Implement HMAC SHA256 verification (e.g., Stripe.webhooks.verifyHeader)
        const expectedSecret = process.env.STRIPE_WEBHOOK_SECRET || 'wh_secret';
        return signature === expectedSecret; // Mock check
    }
}
const webhookSecurity = new WebhookSecurity();

// Mock Project Service for updating milestone (Task 14 dependency)
class MockProjectServiceUpdate {
    public async updateMilestoneEscrow(projectId: string, milestoneId: string, escrowId: string): Promise<void> {
        // PRODUCTION: This performs the ProjectModel.milestones update
        console.log(`[Project Update Mock] Milestones ${milestoneId} updated with Escrow ID ${escrowId}.`);
    }
}
const projectUpdateService = new MockProjectServiceUpdate();


export class PaymentService {
    // ... (createPaymentIntent method) ...

    /** Locks funds into a new Escrow record after payment confirmation. */
    public async lockEscrow(data: any): Promise<IEscrow> {
        const { intentId, projectId, milestoneId, amount, currency, provider, providerPaymentIntentId } = data;
        
        const intentTransaction = await PaymentTransactionModel.findOne({ intentId, status: 'succeeded' });
        if (!intentTransaction) { throw new Error('TransactionNotSucceeded'); }

        // 1. IDEMPOTENCY CHECK (CRITICAL: Check against intentId/milestoneId)
        const existingEscrow = await EscrowModel.findOne({ milestoneId: new Types.ObjectId(milestoneId) });
        if (existingEscrow) {
            throw new Error('EscrowAlreadyLocked');
        }

        // 2. Create Escrow Record
        const newEscrow = new EscrowModel({
            projectId: new Types.ObjectId(projectId),
            milestoneId: new Types.ObjectId(milestoneId),
            payerId: intentTransaction.payerId,
            amount,
            currency,
            provider,
            providerEscrowId: providerPaymentIntentId,
            transactions: [intentTransaction._id!],
            status: 'locked',
        });
        const savedEscrow = await newEscrow.save();
        
        // 3. Update Project Milestone (Decoupled call to Project Service)
        await projectUpdateService.updateMilestoneEscrow(projectId, milestoneId, savedEscrow.escrowId);
        
        // PRODUCTION: Emit 'escrow.locked' event (Task 32 subscribes)
        console.log(`[Event] Escrow ${savedEscrow.escrowId} locked. Payer: ${intentTransaction.payerId.toString()}`);

        return savedEscrow.toObject() as IEscrow;
    }

    /** Handles incoming PSP webhooks (e.g., payment_intent.succeeded). */
    public async handleWebhook(provider: string, payload: any, signature: string): Promise<void> {
        // 1. SECURITY: Signature Verification
        if (!webhookSecurity.verifySignature(JSON.stringify(payload), signature, process.env.WEBHOOK_SECRET!)) {
            throw new Error('InvalidWebhookSignature');
        }

        // 2. Extract Event and Correlation ID
        const eventType = payload.type; // e.g., 'payment_intent.succeeded'
        // Retrieve internal correlation ID from metadata
        const correlationId = payload.data.object.metadata?.internalIntentId; 
        const providerPaymentIntentId = payload.data.object.id;
        
        if (!correlationId) {
             throw new Error('MissingCorrelationID');
        }

        // 3. Find Transaction Record
        const transaction = await PaymentTransactionModel.findOne({ intentId: correlationId });
        if (!transaction) { 
            throw new Error('TransactionNotFound'); 
        }

        // 4. Update Transaction Status based on Event Type
        if (eventType === 'payment_intent.succeeded' || eventType === 'order.paid') {
            
            // Check state to prevent replay/conflict
            if (transaction.status === 'succeeded') { return; } 

            transaction.status = 'succeeded';
            // NOTE: Final Payment ID (charge ID) should be stored here
            transaction.providerPaymentId = providerPaymentIntentId; 
            await transaction.save();

            // 5. TRIGGER ESCROW LOCK (Internal call based on success event)
            await this.lockEscrow({
                intentId: transaction.intentId,
                projectId: transaction.projectId!.toString(),
                milestoneId: transaction.milestoneId!.toString(),
                amount: transaction.amount,
                currency: transaction.currency,
                provider: transaction.provider,
                providerPaymentIntentId: providerPaymentIntentId,
            });
            
        } else if (eventType.includes('failed')) {
            transaction.status = 'failed';
            await transaction.save();
        }

        // PRODUCTION: Emit 'payment.updated' event
        console.log(`[Event] Payment ${transaction.intentId} status updated to ${transaction.status}.`);
    }
}
```

#### **35.3. `src/controllers/payment.controller.ts` (Updates)**

```typescript
// src/controllers/payment.controller.ts (partial update)
// ... (Imports, paymentService initialization, createPaymentIntentController) ...
import { body, param, header, validationResult } from 'express-validator';

// --- Escrow Controllers ---

/** Locks funds into a new Escrow record. POST /payments/escrow/lock */
export const lockEscrowController = async (req: Request, res: Response) => {
    // NOTE: In a real app, this internal endpoint would be called by a trusted backend service (Task 35.2 webhook logic).
    // For Phase 1 testing, we expose it under Auth/Admin.
    
    // Validation is heavy, as this is a high-impact operation
    // Omitting validation here to focus on service logic (assuming service layer validation is primary)

    try {
        // Service handles check that transaction already succeeded and creates escrow
        const savedEscrow = await paymentService.lockEscrow(req.body);

        // Success (201 Created)
        return res.status(201).json({
            escrowId: savedEscrow.escrowId,
            status: savedEscrow.status,
            message: 'Funds locked successfully and project milestone updated.',
        });

    } catch (error: any) {
        if (error.message === 'EscrowAlreadyLocked') { return res.status(409).json({ error: { code: 'already_locked', message: 'Escrow for this milestone is already active.' } }); }
        if (error.message === 'TransactionNotSucceeded') { return res.status(409).json({ error: { code: 'txn_status_fail', message: 'The payment transaction must be marked as succeeded before locking escrow.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error locking funds.' } });
    }
};


// --- Webhook Controller ---

/** Receives webhooks from PSPs. POST /webhooks/payments */
export const webhookController = async (req: Request, res: Response) => {
    // 1. Retrieve essential data for validation
    const pspSignature = req.headers['stripe-signature'] || req.headers['x-razorpay-signature'] || '';
    const provider = (req.headers['x-psp-provider'] as string)?.toLowerCase() || 'stripe'; // Default to Stripe
    const rawBody = JSON.stringify(req.body); // Use raw body for signature verification

    try {
        // 2. Service Call (handles signature, event parsing, and updates)
        await paymentService.handleWebhook(provider, req.body, pspSignature as string);

        // 3. Success (200 OK) - Required by PSP for acknowledgement
        return res.status(200).send('OK');
    } catch (error: any) {
        // CRITICAL: Must not throw 500 on business logic error (e.g., TxnNotFound), only on system failure.
        console.error('Webhook processing error:', error.message);
        
        if (error.message === 'InvalidWebhookSignature') {
            return res.status(401).json({ error: { code: 'signature_invalid', message: 'Webhook signature validation failed.' } });
        }
        
        // Always return 200/400 for errors that aren't config/signature to prevent provider retries
        return res.status(400).json({ error: { code: 'webhook_fail', message: error.message } });
    }
};
```

#### **35.4. `src/routes/payment.routes.ts` (Updates)**

```typescript
// src/routes/payment.routes.ts (partial update)
import { Router } from 'express';
// ... (Task 34 Imports) ...
import { lockEscrowController, webhookController } from '../controllers/payment.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// ... (POST /payments/intents from Task 34) ...

// --- Escrow Endpoints ---

// POST /payments/escrow/lock - Lock funds into escrow (Task 35)
router.post(
    '/escrow/lock',
    authenticate,
    authorize([PERMISSIONS.FINANCE_MANAGE]), // Restrict to trusted internal roles/system calls
    lockEscrowController
);


// --- Webhooks (Public) ---

// POST /webhooks/payments - PSP webhook receiver (Task 35)
router.post('/webhooks/payments', webhookController); // NOTE: No 'authenticate' middleware!


export default router;
```

#### **35.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T35.1** | `POST /webhooks` | Fail: Signature Check | Invalid `X-PSP-Signature` | **401 Unauthorized** | `signature_invalid` |
| **T35.2** | `POST /webhooks` | Happy Path: Payment Succeeded | Valid Signature, `type: succeeded` event | **200 OK** | N/A (Triggers internal `lockEscrow`) |
| **T35.3** | `POST /escrow/lock` | Happy Path: Lock Funds | Internal call, `PaymentTransaction` status=`succeeded` | **201 Created** | N/A (Returns `escrowId`) |
| **T35.4** | `POST /escrow/lock` | Fail: Double Lock Check | Same `milestoneId` provided twice | **409 Conflict** | `already_locked` |
| **T35.5** | `DB Check` | Lock Success Check | T35.3 success | `EscrowModel` created, `ProjectModel.milestone.escrowId` updated (mocked). |

---
