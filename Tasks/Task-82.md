Following the structured plan and prioritizing the robust security and stability of the financial system, we proceed with **Task 82: Payment Provider Production Hardening**.

This task implements the necessary internal logic to gracefully handle payment provider failures, ensuring the system can retry operations and alert administrators when a critical service is unavailable.

***

## **Task 82: Payment Provider Production Hardening**

**Goal:** Implement robust error handling in the `PaymentService` to detect PSP-side failures, trigger retry logic for payment intent creation (as a temporary measure), and implement a circuit breaker pattern (mocked) to prevent cascading failures during extended PSP outages.

**Service:** `Payments & Escrow Service`
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 34 (Payment Intent Logic), Task 33 (Adapter Abstraction).

**Output Files:**
1.  `src/utils/circuitBreaker.utility.ts` (New file: Circuit Breaker implementation/mock)
2.  `src/services/payment.service.ts` (Updated: `createPaymentIntent` with circuit breaker and retry logic)
3.  `test/unit/circuit_breaker.test.ts` (Test specification)

**Input/Output Shapes:**

| Middleware Action | Condition | Response (424 Failed Dependency/503 Service Unavailable) | Header Check |
| :--- | :--- | :--- | :--- |
| **Circuit Open** | PSP mock fails 3 times consecutively. | **503 Service Unavailable** | Returns circuit breaker message. |
| **Intent Failure** | PSP mock throws transient error. | **424 Failed Dependency** | Service signals failure, prompting client to retry. |

**Runtime & Env Constraints:**
*   **Decoupling:** The circuit breaker must wrap the calls to the `PaymentAdapterFactory`.
*   **Logic:** The circuit breaker state (`OPEN`, `HALF-OPEN`, `CLOSED`) must be correctly managed based on success/failure thresholds.

**Acceptance Criteria:**
*   The circuit breaker correctly moves from `CLOSED` to `OPEN` state after exceeding a defined failure threshold (e.g., 3 failures).
*   When the circuit is `OPEN`, the `createPaymentIntent` call must fail immediately *without* calling the PSP adapter.
*   The system returns **424 Failed Dependency** when a *transient* PSP error occurs, signaling the client/system to handle the failure gracefully.

**Tests to Generate:**
*   **Unit Test (Circuit Logic):** Test state transitions (CLOSED $\rightarrow$ OPEN $\rightarrow$ HALF-OPEN $\rightarrow$ CLOSED).
*   **Integration Test (Intent Failure):** Test multiple failed intent creations and verify the final failure status code (503/424).

***

### **Task 82 Code Implementation**

#### **82.1. `src/utils/circuitBreaker.utility.ts` (New Utility File)**

```typescript
// src/utils/circuitBreaker.utility.ts

enum CircuitState {
    CLOSED,     // Normal operation, all calls pass
    OPEN,       // Trips immediately, calls are blocked
    HALF_OPEN,  // After timeout, allows one test call
}

interface CircuitOptions {
    failureThreshold: number; // Max failures before trip
    resetTimeoutMs: number; // Time in MS to move from OPEN to HALF_OPEN
}

// Global Circuit Breaker State (Simulated)
let currentState = CircuitState.CLOSED;
let failureCount = 0;
let lastFailureTime = 0;

const defaultOptions: CircuitOptions = {
    failureThreshold: 3,
    resetTimeoutMs: 30000, // 30 seconds
};


/**
 * Circuit Breaker Utility (Mock)
 * Wraps a function call to prevent cascading failures during service outages.
 */
export class CircuitBreaker {

    public static get state(): CircuitState {
        if (currentState === CircuitState.OPEN && (Date.now() - lastFailureTime) > defaultOptions.resetTimeoutMs) {
            // Time elapsed: move to HALF_OPEN
            currentState = CircuitState.HALF_OPEN;
        }
        return currentState;
    }

    /**
     * Executes the wrapped function, checking the circuit state first.
     * @param operation - The asynchronous function to execute (e.g., PSP call).
     * @returns The result of the operation.
     * @throws {Error} - 'CircuitOpen' if the circuit is tripped.
     */
    public static async execute<T>(operation: () => Promise<T>): Promise<T> {
        const state = CircuitBreaker.state;

        if (state === CircuitState.OPEN) {
            throw new Error('CircuitOpen');
        }
        
        if (state === CircuitState.HALF_OPEN) {
            // Allows one test call
            console.warn('[Circuit Breaker] State is HALF_OPEN. Allowing one test call.');
        }

        try {
            const result = await operation();
            
            // On Success: Reset circuit state
            failureCount = 0;
            currentState = CircuitState.CLOSED;
            
            return result;
        } catch (error) {
            // On Failure: Record failure and potentially trip the circuit
            CircuitBreaker.recordFailure();
            throw error; // Re-throw the original error
        }
    }

    /** Records a failure and updates the circuit state if threshold is reached. */
    private static recordFailure(): void {
        failureCount++;
        lastFailureTime = Date.now();
        
        if (failureCount >= defaultOptions.failureThreshold) {
            currentState = CircuitState.OPEN;
            console.error('[Circuit Breaker] TRIP! Moving to OPEN state.');
        }
    }

    /** Helper function to manually reset the circuit (e.g., for Admin/Testing). */
    public static reset(): void {
        currentState = CircuitState.CLOSED;
        failureCount = 0;
        lastFailureTime = 0;
        console.log('[Circuit Breaker] Manually reset to CLOSED.');
    }
}
```

#### **82.2. `src/services/payment.service.ts` (Updates - Circuit Breaker Logic)**

```typescript
// src/services/payment.service.ts (partial update)
// ... (Imports from Task 34, 35) ...
import { CircuitBreaker } from '../utils/circuitBreaker.utility';

// Mock Transient Error definition (Errors that should trigger a retry/424)
const isTransientError = (e: Error) => {
    return e.message.includes('Timeout') || e.message.includes('Network') || e.message.includes('500');
};


export class PaymentService {
    // ... (All previous methods) ...

    /** Creates a payment intent via the selected PSP adapter, wrapped by a Circuit Breaker. */
    public async createPaymentIntent(payerId: string, data: ICreateIntentRequest): Promise<ICreateIntentResponse> {
        const { projectId, milestoneId, amount, currency, returnUrl } = data;
        
        const adapter = PaymentAdapterFactory.getAdapter();
        const internalIntentId = `payint_${crypto.randomBytes(8).toString('hex')}`;
        
        const pspInput: IntentInputDTO = {
            // ... (PSP Input DTO from Task 34) ...
            amount, currency, description: `Escrow for Project ${projectId}...`, metadata: {}
        };
        
        try {
            // 1. Execute PSP Call wrapped by Circuit Breaker
            const pspOutput = await CircuitBreaker.execute(() => adapter.createIntent(pspInput));

            // 2. Transaction and State update (from Task 34)
            const newTransaction = new PaymentTransactionModel({
                intentId: internalIntentId,
                projectId: new Types.ObjectId(projectId),
                milestoneId: new Types.ObjectId(milestoneId),
                payerId: new Types.ObjectId(payerId),
                provider: adapter.providerName,
                providerPaymentIntentId: pspOutput.providerPaymentIntentId,
                type: 'escrow_lock',
                amount,
                currency,
                status: pspOutput.status === 'created' ? 'created' : 'pending',
                metadata: pspInput.metadata,
            });
            await newTransaction.save();
            
            // 3. Return Client-facing DTO (from Task 34)
            return {
                intentId: internalIntentId,
                provider: adapter.providerName,
                providerPaymentIntentId: pspOutput.providerPaymentIntentId,
                clientSecret: pspOutput.clientSecret,
                checkoutUrl: pspOutput.checkoutUrl,
                status: newTransaction.status,
            };

        } catch (error: any) {
            // 4. Handle Circuit Breaker and Transient Errors
            if (error.message === 'CircuitOpen') {
                throw new Error('ServiceUnavailable'); // Maps to 503
            }
            if (isTransientError(error)) {
                // Service is alive but PSP failed temporarily
                throw new Error('FailedDependency'); // Maps to 424
            }
            // Re-throw other errors (e.g., Validation, Config errors)
            throw error;
        }
    }
    
    // ... (lockEscrow, releaseEscrow, refundEscrow, handleWebhook methods) ...
}
```

#### **82.3. `src/controllers/payment.controller.ts` (Updates - Error Mapping)**

```typescript
// src/controllers/payment.controller.ts (partial update)
// ... (Imports, paymentService initialization, createPaymentIntentController) ...

/** Creates a payment intent/checkout session. POST /payments/intents */
export const createPaymentIntentController = async (req: Request, res: Response) => {
    // ... (Input Validation & Auth check) ...

    try {
        const payerId = req.user!.sub;
        const result = await paymentService.createPaymentIntent(payerId, req.body);
        
        // Success (201 Created)
        return res.status(201).json(result);

    } catch (error: any) {
        // 5. REFINED ERROR MAPPING (Task 82)
        if (error.message === 'ServiceUnavailable') {
            // 503: Circuit is Open
            return res.status(503).json({ error: { code: 'service_unavailable', message: 'Payment service is temporarily down. Please try again later.' } });
        }
        if (error.message === 'FailedDependency') {
            // 424: Transient failure on the PSP side (client should retry later)
            return res.status(424).json({ error: { code: 'payment_retry', message: 'Payment provider failed temporarily. Please retry your payment.' } });
        }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during payment intent creation.' } });
    }
};
```

#### **82.4. Test Specification**

| Test ID | Method | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T82.1** | `execute` (Unit) | Circuit Trip Check | 3 consecutive mock failures in `createIntent` | N/A | Circuit state $\rightarrow$ `OPEN`. |
| **T82.2** | `POST /intents` | Circuit Open Block | Circuit state is `OPEN`. | **503 Service Unavailable** | `service_unavailable` (Fails fast). |
| **T82.3** | `POST /intents` | Transient Failure | Mock throws `TransientError`. | **424 Failed Dependency** | `payment_retry` (Signals client to retry). |
| **T82.4** | `execute` (Unit) | Half-Open Check | State moves from `OPEN` to `HALF_OPEN` after timeout. | N/A | Next call after timeout succeeds and resets to `CLOSED`. |

---
