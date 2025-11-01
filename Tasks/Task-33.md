Following the structured plan and maintaining the focus on core financial infrastructure, we proceed with **Task 33: Payments & Escrow Adapter Abstraction**.

This task is foundational for the Payments Service, establishing the necessary interfaces and abstraction layer to communicate with external Payment Service Providers (PSPs) like Stripe and Razorpay, ensuring the rest of the application remains vendor-agnostic.

***

## **Task 33: Payments & Escrow Adapter Abstraction**

**Goal:** Define the standard adapter interface (`IPaymentAdapter`) and create a factory that provides mock implementations for key payment actions (creating intents, releasing escrow, refunding) to decouple the service logic from specific PSP APIs.

**Service:** `Payments & Escrow Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** None (This is the foundation for the Payments Service).

**Output Files:**
1.  `src/paymentAdapters/payment.interface.ts` (New file: Adapter Interface and DTOs)
2.  `src/paymentAdapters/stripe.adapter.ts` (New file: Mock Stripe implementation)
3.  `src/paymentAdapters/razorpay.adapter.ts` (New file: Mock Razorpay implementation)
4.  `src/paymentAdapters/adapter.factory.ts` (New file: Adapter selection/factory logic)
5.  `test/unit/adapter_abstraction.test.ts` (Test specification)

**Input/Output Shapes:**

| Adapter Method | Input DTO | Output DTO | PSP/Provider |
| :--- | :--- | :--- | :--- |
| **createIntent** | `IntentInputDTO` | `IntentOutputDTO` | Stripe/Razorpay |
| **releaseEscrow** | `ReleaseInputDTO` | `ReleaseOutputDTO` | Stripe/Razorpay |
| **refundPayment** | `RefundInputDTO` | `RefundOutputDTO` | Stripe/Razorpay |

**Runtime & Env Constraints:**
*   **Decoupling:** No direct calls to `Stripe` or `Razorpay` libraries should exist in the core `PaymentsService` (to be implemented in Task 34); all calls must go through the chosen adapter.
*   **Strict Typing:** Interfaces must define the exact contract between the `PaymentsService` and the external provider logic.
*   **Provider Selection:** The adapter factory should rely on an environment variable (`process.env.DEFAULT_PSP`) to select the active provider.

**Acceptance Criteria:**
*   The `AdapterFactory` must successfully instantiate the correct mock adapter based on the configured provider name.
*   The mock adapters must implement the `IPaymentAdapter` interface fully.
*   The `createIntent` mock must return a placeholder `providerPaymentIntentId` and `clientSecret/checkoutUrl` as defined in the interface.

**Tests to Generate:**
*   **Unit Test (Adapter Interface):** Verify mock adapters implement all required methods and return expected DTO types.
*   **Unit Test (Factory):** Test the factory function for provider selection based on environment configuration.

***

### **Task 33 Code Implementation**

#### **33.1. `src/paymentAdapters/payment.interface.ts` (New Interface File)**

```typescript
// src/paymentAdapters/payment.interface.ts

// --- DTOs for Intent/Checkout ---
export interface IntentInputDTO {
    amount: number; // Cents/Paise
    currency: string;
    description: string;
    metadata: Record<string, string>;
    captureMethod: 'automatic' | 'manual';
    returnUrl?: string;
}

export interface IntentOutputDTO {
    provider: string;
    providerPaymentIntentId: string;
    clientSecret?: string; // For Stripe/Client-side confirmation
    checkoutUrl?: string; // For Razorpay/Hosted checkout
    status: 'created' | 'requires_action';
}

// --- DTOs for Escrow Release/Hold ---
export interface ReleaseInputDTO {
    providerPaymentId: string; // Original charge/intent ID to reference for release
    amount: number;
    currency: string;
    recipientId: string; // Target recipient for fund transfer
}

export interface ReleaseOutputDTO {
    providerTransferId: string; // Transfer/Payout ID for the release
    status: 'pending' | 'succeeded' | 'failed';
}

export interface RefundInputDTO {
    providerPaymentId: string; // Original charge/payment ID
    amount: number;
    reason: string;
}

export interface RefundOutputDTO {
    providerRefundId: string;
    status: 'pending' | 'succeeded' | 'failed';
}


/**
 * The Standard Interface for all Payment Service Provider (PSP) Adapters.
 * All adapter implementations MUST adhere to this contract.
 */
export interface IPaymentAdapter {
    providerName: string;

    /** Step 1: Initiates a payment flow (e.g., Stripe PaymentIntent, Razorpay Order). */
    createIntent(data: IntentInputDTO): Promise<IntentOutputDTO>;

    /** Step 2: Releases a held payment (escrow). E.g., Stripe Capture + Transfer. */
    releaseEscrow(data: ReleaseInputDTO): Promise<ReleaseOutputDTO>;

    /** Initiates a refund against an original payment. */
    refundPayment(data: RefundInputDTO): Promise<RefundOutputDTO>;
    
    // Future: handleWebhookSignature, createPayoutMethod
}
```

#### **33.2. `src/paymentAdapters/stripe.adapter.ts` (Mock Implementation)**

```typescript
// src/paymentAdapters/stripe.adapter.ts
import { 
    IPaymentAdapter, IntentInputDTO, IntentOutputDTO, 
    ReleaseInputDTO, ReleaseOutputDTO, RefundInputDTO, RefundOutputDTO 
} from './payment.interface';
import crypto from 'crypto';

/**
 * Mock implementation of the Stripe Payment Adapter.
 * Assumes a flow of: PaymentIntent (Intent) -> Capture + Transfer (Release).
 */
export class StripeAdapter implements IPaymentAdapter {
    public providerName = 'stripe';

    public async createIntent(data: IntentInputDTO): Promise<IntentOutputDTO> {
        // PRODUCTION: Stripe.paymentIntents.create({...})
        const intentId = `pi_${crypto.randomBytes(12).toString('hex')}`;
        const clientSecret = `${intentId}_secret_${crypto.randomBytes(6).toString('hex')}`;

        return {
            provider: this.providerName,
            providerPaymentIntentId: intentId,
            clientSecret,
            status: 'requires_action',
        };
    }

    public async releaseEscrow(data: ReleaseInputDTO): Promise<ReleaseOutputDTO> {
        // PRODUCTION: Stripe.charges.capture() + Stripe.transfers.create()
        const transferId = `tr_${crypto.randomBytes(12).toString('hex')}`;
        
        // Simulates an async PSP action
        return {
            providerTransferId: transferId,
            status: 'pending', // Will be confirmed via webhook later
        };
    }

    public async refundPayment(data: RefundInputDTO): Promise<RefundOutputDTO> {
        // PRODUCTION: Stripe.refunds.create()
        const refundId = `re_${crypto.randomBytes(12).toString('hex')}`;
        
        return {
            providerRefundId: refundId,
            status: 'pending',
        };
    }
}
```

#### **33.3. `src/paymentAdapters/razorpay.adapter.ts` (Mock Implementation)**

```typescript
// src/paymentAdapters/razorpay.adapter.ts
import { 
    IPaymentAdapter, IntentInputDTO, IntentOutputDTO, 
    ReleaseInputDTO, ReleaseOutputDTO, RefundInputDTO, RefundOutputDTO 
} from './payment.interface';
import crypto from 'crypto';

/**
 * Mock implementation of the Razorpay Payment Adapter.
 * Assumes a flow of: Order (Intent) -> Payment Capture + Payouts (Release).
 */
export class RazorpayAdapter implements IPaymentAdapter {
    public providerName = 'razorpay';

    public async createIntent(data: IntentInputDTO): Promise<IntentOutputDTO> {
        // PRODUCTION: Razorpay.orders.create()
        const orderId = `order_${crypto.randomBytes(10).toString('hex')}`;
        const checkoutUrl = `https://checkout.razorpay.com/pay/${orderId}`;

        return {
            provider: this.providerName,
            providerPaymentIntentId: orderId,
            checkoutUrl,
            status: 'created',
        };
    }

    public async releaseEscrow(data: ReleaseInputDTO): Promise<ReleaseOutputDTO> {
        // PRODUCTION: Razorpay.payouts.create() or direct transfer after capture
        const payoutId = `pout_${crypto.randomBytes(12).toString('hex')}`;
        
        // Simulates an async PSP action
        return {
            providerTransferId: payoutId,
            status: 'pending',
        };
    }

    public async refundPayment(data: RefundInputDTO): Promise<RefundOutputDTO> {
        // PRODUCTION: Razorpay.payments.refund()
        const refundId = `refr_${crypto.randomBytes(12).toString('hex')}`;
        
        return {
            providerRefundId: refundId,
            status: 'pending',
        };
    }
}
```

#### **33.4. `src/paymentAdapters/adapter.factory.ts` (New Factory File)**

```typescript
// src/paymentAdapters/adapter.factory.ts
import { IPaymentAdapter } from './payment.interface';
import { StripeAdapter } from './stripe.adapter';
import { RazorpayAdapter } from './razorpay.adapter';

// Enum for configuration safety
export enum PSPProvider {
    STRIPE = 'stripe',
    RAZORPAY = 'razorpay',
    MOCK = 'mock', // Useful for testing
}

// Default provider configuration (Environment Variable)
const DEFAULT_PSP: PSPProvider = (process.env.DEFAULT_PSP as PSPProvider) || PSPProvider.STRIPE;


/**
 * Factory to retrieve the correct PSP Adapter instance.
 */
export class PaymentAdapterFactory {

    /**
     * Gets a payment adapter instance based on the configured provider.
     * @param providerName - Optional override for provider selection.
     * @returns An instance of a class implementing IPaymentAdapter.
     * @throws {Error} - If the configured provider is not supported.
     */
    public static getAdapter(providerName: PSPProvider = DEFAULT_PSP): IPaymentAdapter {
        switch (providerName) {
            case PSPProvider.STRIPE:
                return new StripeAdapter();
            case PSPProvider.RAZORPAY:
                return new RazorpayAdapter();
            default:
                throw new Error(`Unsupported PSP configuration: ${providerName}`);
        }
    }
}
```

#### **33.5. Test Specification (Self-Correction/Internal Plan)**

| Test ID | Description | Component | Condition | Expected Output |
| :--- | :--- | :--- | :--- | :--- |
| **T33.1** | Interface Compliance | StripeAdapter | `createIntent` call | Returns `IntentOutputDTO` with `providerPaymentIntentId` |
| **T33.2** | Adapter Routing | PaymentAdapterFactory | `DEFAULT_PSP` set to 'razorpay' | Instantiates `RazorpayAdapter` |
| **T33.3** | DTO Check (Intent) | StripeAdapter | `createIntent` call | `clientSecret` must be present. |
| **T33.4** | DTO Check (Release) | RazorpayAdapter | `releaseEscrow` call | `providerTransferId` must be present. |

*(The logic above is purely service/utility; it is not exposed via Express and does not need a controller/route in this task, but will be integrated in Task 34.)*

---