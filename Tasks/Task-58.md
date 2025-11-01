Following the structured plan and prioritizing the financial execution, we proceed with **Task 58: Background Job: Payout Execution Orchestration**.

This task implements the final, most sensitive job in the financial flow, responsible for orchestrating the actual transfer of funds via the PSP and updating the payout status.

***

## **Task 58: Background Job: Payout Execution Orchestration**

**Goal:** Implement the worker handler logic for the `payout.execute` job type, which retrieves a `PayoutBatch`, iterates through the `PayoutItems`, calls the decoupled PSP adapter (Task 33) for each item, and updates the batch/item statuses.

**Service:** `Jobs & Worker Queue Service` / `Revenue Calculation & Payouts Service` (logic)
**Phase:** F - Revenue & Payouts execution, Accounting integration
**Dependencies:** Task 54 (Job Reporting Logic), Task 33 (Adapter Factory), Task 32 (Payout Model/Service), Task 44 (User Settings - for recipient details).

**Output Files:**
1.  `src/jobs/handlers/payoutHandler.ts` (New file: Worker business logic)
2.  `src/jobs/jobRegistry.ts` (Updated: Finalize `payout.execute` job type)
3.  `src/services/revenue.service.ts` (Updated: `executePayoutBatch`)
4.  `test/unit/payout_job.test.ts` (Test specification)

**Input/Output Shapes (Worker Logic):**
*   Input: `{ batchId: string }`
*   Simulated Success: Calls `IPaymentAdapter.releaseEscrow` for each item $\rightarrow$ Updates `PayoutItem.status` $\rightarrow$ Calls `POST /jobs/:id/succeed`.

**Runtime & Env Constraints:**
*   **Idempotency (CRITICAL):** The handler must be idempotent. If a transfer is already initiated, it should skip that item (or check the existing provider ID) to prevent double payment.
*   **Decoupling:** Must use the `PaymentAdapterFactory` for external calls.
*   **Data Source:** Must fetch recipient details (`payoutMethod`) from the `UserSettings` model (Task 44) before transfer.
*   **Concurrency:** Needs to handle the state transition of multiple embedded `PayoutItem` sub-documents.

**Acceptance Criteria:**
*   The job handler successfully calls the PSP adapter mock for each *unpaid* item in the batch.
*   Upon successful transfer, the handler updates the corresponding `PayoutItem.status` to `'processing'` (pending webhook confirmation) and records the `providerPayoutId`.
*   If a recipient is missing required payout details, the item is marked `'pending_kyc'` or `'failed'` and the job continues (partial success).

**Tests to Generate:**
*   **Unit Test (Batch Execution):** Test a batch with one successful item and one item lacking recipient details. Verify status transitions (Success/Pending_KYC).
*   **Unit Test (Idempotency):** Test running the job twice; the second run should skip already processed/processing items.

***

### **Task 58 Code Implementation**

#### **58.1. `src/services/revenue.service.ts` (Updates - Execution Logic)**

```typescript
// src/services/revenue.service.ts (partial update)
// ... (Imports, PayoutBatchModel, RevenueService class definition) ...
import { IPayoutBatch, IPayoutItem } from '../models/payout.model';
import { UserSettingsModel } from '../models/userSettings.model';
import { PaymentAdapterFactory, PSPProvider } from '../paymentAdapters/adapter.factory';
import { ReleaseInputDTO } from '../paymentAdapters/payment.interface';


export class RevenueService {
    // ... (All previous methods) ...
    
    /**
     * Executes a single Payout Batch, calling the PSP adapter for each item.
     * @returns Summary of execution.
     */
    public async executePayoutBatch(batchId: string): Promise<{ totalItems: number, totalSubmitted: number }> {
        const batch = await PayoutBatchModel.findOne({ batchId });
        if (!batch) { throw new Error('BatchNotFound'); }

        const adapter = PaymentAdapterFactory.getAdapter(batch.provider as PSPProvider);
        let totalSubmitted = 0;
        
        for (let i = 0; i < batch.items.length; i++) {
            const item = batch.items[i];
            
            // 1. IDEMPOTENCY & STATE CHECK
            if (item.status === 'paid' || item.status === 'processing') {
                continue; // Skip already active/paid items
            }
            
            // 2. Fetch Recipient Payout Details (KYC/Account)
            const settings = await UserSettingsModel.findOne({ userId: item.userId })
                .select('payoutMethod').lean();

            if (!settings?.payoutMethod?.isVerified || !settings.payoutMethod.providerAccountId) {
                // Failsafe/KYC Check: Mark as pending KYC and skip execution
                batch.items[i].status = 'pending_kyc';
                batch.items[i].failureReason = 'Missing or unverified payout method/KYC.';
                continue;
            }

            try {
                // 3. CALL PSP Adapter (Release/Transfer/Payout)
                const pspInput: ReleaseInputDTO = {
                    providerPaymentId: settings.payoutMethod.providerAccountId, // Target account (simplified)
                    amount: item.netAmount,
                    currency: batch.currency,
                    recipientId: item.userId.toString(),
                };
                
                const pspOutput = await adapter.releaseEscrow(pspInput); // e.g., Stripe Capture/Transfer
                
                // 4. Update Item Status (Optimistic update to 'processing')
                batch.items[i].status = 'processing';
                batch.items[i].providerPayoutId = pspOutput.providerTransferId;
                totalSubmitted++;

                // PRODUCTION: Emit 'payout.item.submitted'
                console.log(`[Event] Payout ${item._id} submitted to PSP: ${pspOutput.providerTransferId}`);

            } catch (error: any) {
                // 5. Handle PSP Failure (e.g., PSP network error)
                batch.items[i].status = 'failed';
                batch.items[i].failureReason = `PSP error on submission: ${error.message}`;
                // Job will be retried by the next scheduled run
                console.error(`[Payout Error] Payout ${item._id} failed submission. Reason: ${error.message}`);
            }
        }

        // 6. Save the entire updated batch document
        await batch.save();

        return { totalItems: batch.items.length, totalSubmitted };
    }
}
```

#### **58.2. `src/jobs/handlers/payoutHandler.ts` (New Handler File)**

```typescript
// src/jobs/handlers/payoutHandler.ts
import { IJob } from '../../models/job.model';
import { RevenueService } from '../../services/revenue.service'; 

const revenueService = new RevenueService();

/**
 * Worker Logic Handler for the 'payout.execute' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handlePayoutJob(job: IJob): Promise<{ totalSubmitted: number }> {
    const { batchId } = job.payload;
    
    // NOTE: Job Service handles atomicity/concurrency. We just execute the business logic.

    // 1. Execute the Batch
    const result = await revenueService.executePayoutBatch(batchId);
    
    // 2. Determine Success/Failure
    if (result.totalItems > 0 && result.totalSubmitted === 0) {
        // If items were pending KYC or failed submission, we throw an error to signal the Job Service to retry later
        throw new Error('PartialSubmissionFailure');
    }

    // If totalSubmitted > 0 and the Job completed, it means the transfers were submitted to the PSP.
    // The final status update (paid/failed) is handled by the webhook (Task 35).
    return { totalSubmitted: result.totalSubmitted };
}
```

#### **58.3. `src/routes/job.routes.ts` (No API Changes)**

*(This task relies entirely on the existing job report endpoints from Task 54.)*

#### **58.4. Test Specification**

| Test ID | Method | Description | Condition | Expected Output (Code) | Expected Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T58.1** | `handlePayoutJob` | Happy Path: Submit All | Batch with all valid recipients | `200 OK` (via Job Success Report) | All items status $\rightarrow$ `'processing'`; adapter mock called N times. |
| **T58.2** | `handlePayoutJob` | Partial Failure/KYC | Batch with one valid, one missing KYC | `500 Server Error` (internal retry signal) | Item 1 status $\rightarrow$ `'processing'$; Item 2 status $\rightarrow$ `'pending_kyc'`. |
| **T58.3** | `Integration` | Idempotency Check | Run job twice on same batch | `200 OK` | Adapter mock called N times total (second run skips processing items). |

---