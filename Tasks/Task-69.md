You are correct that Task 69, **Webhook Receivers (Payments/Esign/Providers)**, is the next logical step. While we implemented the Email webhook (Task 48) and the core Payment webhook handler (Task 35), Task 69 in the overall plan represents the consolidation of all *external provider* webhooks into a robust, auditable system.

***

## **Task 69: Webhook Receivers (Payments/Esign/Providers)**

**Goal:** Implement the primary public webhook receiver (`POST /webhooks/provider/:providerName`) to handle asynchronous events from various third-party systems (PSP, E-sign, Realtime Provider) in a unified, secure, and auditable way.

**Service:** `Payments & Escrow Service`, `Agreements & Licensing Service` (Logic)
**Phase:** G - Notifications, Webhooks...
**Dependencies:** Task 35 (Webhook Handler), Task 26 (Agreement Signing), Task 60 (AuditLog Service).

**Output Files:**
1.  `src/controllers/payment.controller.ts` (Updated: `unifiedWebhookController`)
2.  `src/services/payment.service.ts` (Updated: `processPaymentEvent`)
3.  `src/services/agreement.service.ts` (Updated: `processEsignEvent`)
4.  `src/routes/payment.routes.ts` (Updated: unified webhook route)
5.  `test/integration/unified_webhook.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Headers/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /webhooks/provider/:name**| `Params: { providerName }`, Headers: `X-Signature`, Raw Body | **200 OK** | Public (Signature Validation) |

**Webhook Logic Flow:**
1.  Verify Signature (Provider-specific logic).
2.  Identify Event Type (`payment_intent.succeeded`, `envelope.signed`, etc.).
3.  Route to appropriate service (`PaymentService` or `AgreementService`).
4.  Log event receipt to `AuditService`.

**Runtime & Env Constraints:**
*   **Security (CRITICAL):** Signature verification must be dynamic (based on `providerName`) and strictly enforced before parsing the body.
*   **Decoupling:** The controller must be a thin router that immediately delegates logic to the appropriate domain service.
*   **Logging:** Every inbound webhook call must be logged, successful or not, to the `AuditService` (Task 60).

**Acceptance Criteria:**
*   The unified webhook controller successfully routes a mock `stripe` event to `PaymentService` and a mock `docusign` event to `AgreementService`.
*   The controller logs the receipt of the event to the `AuditService` upon entry.
*   An invalid signature returns **401 Unauthorized** regardless of the provider name.

**Tests to Generate:**
*   **Integration Test (Routing):** Test a `stripe` payload being sent and verify the `PaymentService` mock is called.
*   **Integration Test (Security):** Test an invalid signature with a valid payload (401).

***

### **Task 69 Code Implementation**

#### **69.1. `src/services/payment.service.ts` (Updates - For Webhook Routing)**

```typescript
// src/services/payment.service.ts (partial update)
// ... (Imports from Task 36) ...
import { IPaymentAdapter } from '../paymentAdapters/payment.interface';

// Mock Webhook Signature Utility (Centralized for all PSPs)
const PSP_SECRETS: Record<string, string> = {
    'stripe': process.env.STRIPE_WEBHOOK_SECRET || 'wh_stripe_secret',
    'razorpay': process.env.RAZORPAY_WEBHOOK_SECRET || 'wh_razorpay_secret',
    // ... add other PSP secrets here
};

class UnifiedWebhookSecurity {
    public verifySignature(provider: string, rawBody: string, signature: string): boolean {
        const expectedSecret = PSP_SECRETS[provider] || 'unknown_secret';
        // PRODUCTION: This would call HMAC verification logic for the specific provider
        return signature === expectedSecret; // Mock check
    }
}
const webhookSecurity = new UnifiedWebhookSecurity();


export class PaymentService {
    // ... (All previous methods) ...

    /** Worker-called method to process a specific payment-related event type. */
    public async processPaymentEvent(eventType: string, payload: any): Promise<void> {
        // NOTE: This logic is heavily simplified from Task 35's webhook logic
        
        const providerPaymentIntentId = payload.data.object.id; // Example extraction
        
        if (eventType === 'payment_intent.succeeded' || eventType === 'charge.succeeded') {
            // PRODUCTION: Find Transaction by Intent ID, update status, and TRIGGER lockEscrow (Task 35)
            console.log(`[Payment Event] Payment succeeded for Intent ID: ${providerPaymentIntentId}. Triggering Escrow Lock...`);
            // await this.lockEscrow({...}); 
            
        } else if (eventType === 'charge.refunded' || eventType === 'refund.succeeded') {
            // PRODUCTION: Find Refund Transaction, update status to 'succeeded'
            console.log(`[Payment Event] Refund succeeded for TX ID: ${providerPaymentIntentId}.`);
        }
        
        // PRODUCTION: Emit 'payment.updated' event
    }
}
```

#### **69.2. `src/services/agreement.service.ts` (Updates - For Webhook Routing)**

```typescript
// src/services/agreement.service.ts (partial update)
// ... (Imports from Task 27/28) ...

export class AgreementService {
    // ... (All previous methods) ...
    
    /** Worker-called method to process a specific e-sign related event type. */
    public async processEsignEvent(eventType: string, payload: any): Promise<void> {
        
        const providerEnvelopeId = payload.data.object.envelopeId; // Example Docusign/SignWell ID
        
        if (eventType === 'envelope.signed' || eventType === 'recipient.signed') {
            // PRODUCTION: Find Agreement by providerEnvelopeId
            // Call completeSigning internally (Task 26) using the 'complete_esign' method
            console.log(`[E-Sign Event] Recipient signed on Envelope ID: ${providerEnvelopeId}. Updating Agreement status...`);
            // await this.completeSigning('agreementId', 'signerEmail', 'complete_esign'); 
        }

        // PRODUCTION: Emit 'agreement.updated' event
    }
}
```

#### **69.3. `src/controllers/payment.controller.ts` (Updates - Unified Webhook)**

```typescript
// src/controllers/payment.controller.ts (partial update)
// ... (Imports, paymentService initialization, previous controllers) ...
import { AgreementService } from '../services/agreement.service'; // Dependency on Agreement Service
import { AuditService } from '../services/audit.service'; // Dependency on Audit Service

const agreementService = new AgreementService();
const auditService = new AuditService();
const webhookSecurity = new UnifiedWebhookSecurity();


/** Unified receiver for all external provider webhooks. POST /webhooks/provider/:name */
export const unifiedWebhookController = async (req: Request, res: Response) => {
    const { providerName } = req.params;
    const signature = req.headers['x-signature'] || req.headers['stripe-signature'] || 'no-signature'; // Unified header check
    const rawBody = (req as any).rawBody || JSON.stringify(req.body); 

    // 1. Audit Log Event Receipt (Log before validation to capture all attempts)
    await auditService.logAuditEntry({
        resourceType: 'webhook',
        action: `webhook.received.${providerName}`,
        actorId: '000000000000000000000001', // System user ID
        details: { providerName, eventType: req.body.type, headers: req.headers },
        ip: req.ip,
    });
    
    // 2. SECURITY: Signature Verification
    if (!webhookSecurity.verifySignature(providerName, rawBody, signature as string)) {
        // 401 Unauthorized is mandatory for signature failure
        return res.status(401).json({ error: { code: 'signature_invalid', message: `Signature validation failed for ${providerName}.` } });
    }

    // 3. Routing Logic
    try {
        const eventType = req.body.type;
        
        if (providerName === 'stripe' || providerName === 'razorpay') {
            await paymentService.processPaymentEvent(eventType, req.body);
        } else if (providerName === 'docusign' || providerName === 'signwell') {
            await agreementService.processEsignEvent(eventType, req.body);
        } else {
            // Unhandled provider, but still secure (200 OK to prevent retries)
            return res.status(200).send('Provider not handled.');
        }

        // 4. Success (200 OK) - Required by external provider
        return res.status(200).send('Event processed.');
    } catch (error: any) {
        // Log business logic failure but return 200/400 to provider to manage retries internally
        console.error(`Webhook Processing Fail [${providerName}]: ${error.message}`);
        return res.status(400).json({ error: { code: 'processing_fail', message: 'Business logic failure.' } });
    }
};
```

#### **69.4. `src/routes/payment.routes.ts` (Updates)**

```typescript
// src/routes/payment.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 34/35/36) ...
import { unifiedWebhookController } from '../controllers/payment.controller';

const router = Router();

// ... (All other previous routes) ...

// --- Unified Webhooks (Public) ---

// POST /webhooks/provider/:providerName - Unified receiver for all PSP/E-sign webhooks (Task 69)
// NOTE: This route needs special raw body parsing middleware in the main Express config.
router.post('/webhooks/provider/:providerName', unifiedWebhookController);


export default router;
```

#### **69.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T69.1** | `POST /webhooks/provider/stripe` | Security: Invalid Sig | Invalid `Stripe-Signature` header | **401 Unauthorized** | `signature_invalid` |
| **T69.2** | `POST /webhooks/provider/stripe` | Routing: Payment | Valid Sig, `type: 'payment_intent.succeeded'` | **200 OK** | `PaymentService.processPaymentEvent` called. |
| **T69.3** | `POST /webhooks/provider/docusign` | Routing: E-Sign | Valid Sig, `type: 'envelope.signed'` | **200 OK** | `AgreementService.processEsignEvent` called. |
| **T69.4** | `POST /webhooks/provider/unhandled` | Routing: Unhandled | Valid Sig, Unhandled provider | **200 OK** | Returns 'Provider not handled.' (No 4xx/5xx to prevent retry). |