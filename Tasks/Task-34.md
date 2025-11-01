Following the structured plan and integrating the newly created adapter, we proceed with **Task 34: Payments Intents & Checkout Flow**.

This task establishes the models and endpoints for the first step of the funding process: creating a payment intent with the chosen Payment Service Provider (PSP) via the adapter factory.

***

## **Task 34: Payments Intents & Checkout Flow**

**Goal:** Implement the `PaymentTransaction` model and the payment intent endpoint (`POST /payments/intents`) that dynamically selects a PSP adapter (Task 33) to create a client-side payment intent or checkout session URL.

**Service:** `Payments & Escrow Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 33 (Adapter Abstraction), Task 1 (User Model), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/paymentTransaction.model.ts` (New file: IPaymentTransaction, PaymentTransactionSchema/Model)
2.  `src/services/payment.service.ts` (New file: `createPaymentIntent`)
3.  `src/controllers/payment.controller.ts` (New file: `createPaymentIntentController`)
4.  `src/routes/payment.routes.ts` (New file: router for `/payments`)
5.  `test/integration/intent_flow.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (201 Created) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /payments/intents** | `{ projectId, milestoneId, amount, currency, returnUrl }` | `{ intentId, provider, clientSecret?, checkoutUrl?, status }` | Auth (Payer) |

**IntentCreationRequest (Excerpt):**
```json
{
  "projectId": "proj_abc",
  "milestoneId": "m_xyz",
  "amount": 250000,
  "currency": "USD"
}
```

**Runtime & Env Constraints:**
*   **Idempotency:** The controller/service must prevent the creation of duplicate intents for the same request payload (if possible, though the true idempotent key check is more complex and deferred).
*   **Provider Selection:** Must use `PaymentAdapterFactory.getAdapter()` based on the configured `DEFAULT_PSP`.
*   A new `PaymentTransaction` record must be created with `status: 'created'` and linked to the PSP intent ID.

**Acceptance Criteria:**
*   Successful intent creation returns **201 Created** and the PSP-specific data (`clientSecret` OR `checkoutUrl`).
*   The transaction record must contain the internal `intentId` and the external `providerPaymentIntentId`.
*   Validation must enforce the minimum payment amount and valid currency code.

**Tests to Generate:**
*   **Integration Test (Stripe Flow):** Test intent creation when `DEFAULT_PSP=stripe`, verify `clientSecret` is returned.
*   **Integration Test (Razorpay Flow):** Test intent creation when `DEFAULT_PSP=razorpay`, verify `checkoutUrl` is returned.
*   **Integration Test (Validation):** Test failure on missing required fields or amount $\leq 0$.

***

### **Task 34 Code Implementation**

#### **34.1. `src/models/paymentTransaction.model.ts` (New Model)**

```typescript
// src/models/paymentTransaction.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IPaymentTransaction {
  _id?: Types.ObjectId;
  intentId: string; // Internal identifier for payment flow
  projectId?: Types.ObjectId;
  milestoneId?: Types.ObjectId;
  payerId: Types.ObjectId; // User who paid
  provider: 'stripe' | 'razorpay' | 'other';
  providerPaymentIntentId?: string; // PSP PaymentIntent/Order/Checkout ID
  providerPaymentId?: string; // PSP final charge/payment ID (set on success webhook)
  type: 'payment' | 'refund' | 'payout' | 'fee' | 'chargeback' | 'escrow_lock';
  amount: number; // In smallest currency unit
  currency: string;
  status: 'created' | 'pending' | 'succeeded' | 'failed' | 'refunded' | 'disputed';
  metadata?: any;
  createdAt?: Date;
  updatedAt?: Date;
}

const PaymentTransactionSchema = new Schema<IPaymentTransaction>({
  intentId: { type: String, required: true, unique: true, default: () => `payint_${crypto.randomBytes(8).toString('hex')}` },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
  milestoneId: { type: Schema.Types.ObjectId },
  payerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: ['stripe', 'razorpay', 'other'], required: true },
  providerPaymentIntentId: { type: String, index: true },
  providerPaymentId: { type: String, index: true },
  type: { type: String, enum: ['payment', 'refund', 'payout', 'fee', 'chargeback', 'escrow_lock'], required: true },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true },
  status: { type: String, enum: ['created', 'pending', 'succeeded', 'failed', 'refunded', 'disputed'], default: 'created', index: true },
  metadata: { type: Schema.Types.Mixed },
}, { timestamps: true });

export const PaymentTransactionModel = model<IPaymentTransaction>('PaymentTransaction', PaymentTransactionSchema);
```

#### **34.2. `src/services/payment.service.ts` (New File)**

```typescript
// src/services/payment.service.ts
import { PaymentTransactionModel, IPaymentTransaction } from '../models/paymentTransaction.model';
import { PaymentAdapterFactory, PSPProvider } from '../paymentAdapters/adapter.factory';
import { IntentInputDTO } from '../paymentAdapters/payment.interface';
import { Types } from 'mongoose';
import crypto from 'crypto';

interface ICreateIntentRequest {
    projectId: string;
    milestoneId: string;
    amount: number;
    currency: string;
    returnUrl?: string;
    // NOTE: PayerId comes from Auth
}

interface ICreateIntentResponse {
    intentId: string;
    provider: string;
    providerPaymentIntentId: string;
    clientSecret?: string;
    checkoutUrl?: string;
    status: string;
}

export class PaymentService {
    
    // NOTE: We assume the presence of a global IdempotencyStore utility for Task 34 
    // (Actual model is in Task 8 for Payments/Escrow, but deferred)
    
    /** Creates a payment intent via the selected PSP adapter. */
    public async createPaymentIntent(payerId: string, data: ICreateIntentRequest): Promise<ICreateIntentResponse> {
        const { projectId, milestoneId, amount, currency, returnUrl } = data;
        
        // 1. Select Adapter
        const adapter = PaymentAdapterFactory.getAdapter(); // Uses DEFAULT_PSP env
        const internalIntentId = `payint_${crypto.randomBytes(8).toString('hex')}`;
        
        // 2. Prepare PSP Input DTO
        const pspInput: IntentInputDTO = {
            amount,
            currency,
            description: `Escrow for Project ${projectId} Milestone ${milestoneId}`,
            metadata: { 
                projectId, 
                milestoneId,
                payerId,
                internalIntentId // Internal ID passed to PSP for webhook correlation
            },
            captureMethod: 'manual', // Hold funds in escrow
            returnUrl,
        };

        // 3. Call PSP Adapter (Decoupled)
        const pspOutput = await adapter.createIntent(pspInput);

        // 4. Create Transaction Record (Status: 'created')
        const newTransaction = new PaymentTransactionModel({
            intentId: internalIntentId,
            projectId: new Types.ObjectId(projectId),
            milestoneId: new Types.ObjectId(milestoneId),
            payerId: new Types.ObjectId(payerId),
            provider: adapter.providerName,
            providerPaymentIntentId: pspOutput.providerPaymentIntentId,
            type: 'escrow_lock', // Type is for eventual escrow/hold
            amount,
            currency,
            status: pspOutput.status === 'created' ? 'created' : 'pending',
            metadata: pspInput.metadata,
        });
        await newTransaction.save();
        
        // PRODUCTION: Emit 'payment.intent.created' event (Task 35 subscribes)
        console.log(`[Event] Payment intent ${internalIntentId} created via ${adapter.providerName}.`);


        // 5. Return Client-facing DTO
        return {
            intentId: internalIntentId,
            provider: adapter.providerName,
            providerPaymentIntentId: pspOutput.providerPaymentIntentId,
            clientSecret: pspOutput.clientSecret,
            checkoutUrl: pspOutput.checkoutUrl,
            status: newTransaction.status,
        };
    }
}
```

#### **34.3. `src/controllers/payment.controller.ts` (New File)**

```typescript
// src/controllers/payment.controller.ts
import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { PaymentService } from '../services/payment.service';

const paymentService = new PaymentService();

// --- Validation Middleware ---

export const createPaymentIntentValidation = [
    body('projectId').isMongoId().withMessage('Project ID is required.'),
    body('milestoneId').isMongoId().withMessage('Milestone ID is required.'),
    body('amount').isInt({ min: 100 }).toInt().withMessage('Minimum payment amount is $1.00 (100 cents/paise).'),
    body('currency').isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter ISO code.'),
    body('returnUrl').optional().isURL().withMessage('Return URL must be a valid URL.'),
];


/** Creates a payment intent/checkout session. POST /payments/intents */
export const createPaymentIntentController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    // 2. Authorization Check (Payer must be authenticated)
    if (!req.user) { return res.status(401).send(); }

    try {
        const payerId = req.user!.sub;

        // 3. Service Call
        const result = await paymentService.createPaymentIntent(payerId, req.body);

        // 4. Success (201 Created)
        return res.status(201).json(result);

    } catch (error: any) {
        // 5. Error Handling
        if (error.message.includes('PSP configuration')) { return res.status(500).json({ error: { code: 'config_error', message: 'Payment provider configuration error.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during payment intent creation.' } });
    }
};
```

#### **34.4. `src/routes/payment.routes.ts` (New File)**

```typescript
// src/routes/payment.routes.ts
import { Router } from 'express';
import { createPaymentIntentController, createPaymentIntentValidation } from '../controllers/payment.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();

// --- Payments Endpoints ---

// POST /payments/intents - Create payment intent / checkout session (Task 34)
router.post(
    '/intents',
    authenticate,
    createPaymentIntentValidation,
    createPaymentIntentController
);

// NOTE: Future endpoints (webhooks, escrow, refunds, etc.) will be added here.

export default router;
```

#### **34.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T34.1** | `POST /intents` | Stripe Flow Check | `DEFAULT_PSP=stripe` | **201 Created** | `clientSecret` is present. `provider: 'stripe'` |
| **T34.2** | `POST /intents` | Razorpay Flow Check | `DEFAULT_PSP=razorpay` | **201 Created** | `checkoutUrl` is present. `provider: 'razorpay'` |
| **T34.3** | `POST /intents` | Fail: Min Amount Check | `amount: 1` | **422 Unprocessable** | `validation_error` |
| **T34.4** | `DB Check` | Transaction Record | T34.1 success | Record created with `status: 'created'` and `type: 'escrow_lock'`. |

---
