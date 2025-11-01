Following the structured plan, we proceed with **Task 57: Background Job: Anchor Hash On-Chain**.

This task implements the logic for the final compliance job, ensuring that the immutable hash of a signed agreement (Task 28) or other critical data is externally anchored on a ledger (blockchain or similar service) for tamper-evident proof.

***

## **Task 57: Background Job: Anchor Hash On-Chain**

**Goal:** Implement the worker handler logic for the `blockchain.anchor` job type, simulating the transmission of a document's `immutableHash` to an external ledger (`ChainGateway`) and updating the source `Agreement` record with the transaction ID.

**Service:** `Jobs & Worker Queue Service` / `Agreements & Licensing Service` (logic)
**Phase:** L - Optional / Future-ready services & experiments (CRITICAL in Phase D context)
**Dependencies:** Task 54 (Job Reporting Logic), Task 28 (Agreement Service).

**Output Files:**
1.  `src/jobs/handlers/anchorHandler.ts` (New file: Worker business logic)
2.  `src/jobs/jobRegistry.ts` (Updated: Register `blockchain.anchor` job type)
3.  `src/services/agreement.service.ts` (Updated: `updateAnchorTxId` utility)
4.  `test/unit/anchor_job.test.ts` (Test specification)

**Input/Output Shapes (Worker Logic):**
*   Input: `{ agreementId: string, immutableHash: string, chain: string }`
*   Simulated Success: Calls `ChainGateway` mock $\rightarrow$ Calls `AgreementService` to update `txId` $\rightarrow$ Calls `POST /jobs/:id/succeed`.

**Runtime & Env Constraints:**
*   **External Mock:** Requires mocking the external `ChainGateway` API (which returns a transaction ID).
*   **Immutability:** The job input relies on the hash being pre-computed and stored by Task 28.
*   **Execution Time:** Anchoring can be slow; the job type should have a generous timeout.

**Acceptance Criteria:**
*   The job handler successfully mocks the external transaction and retrieves a transaction ID (`txId`).
*   The `AgreementModel` is successfully updated with the anchoring transaction reference (`blockchainAnchors` array).
*   If the anchoring fails (mocked), the job must be failed for retry.

**Tests to Generate:**
*   **Unit Test (Handler Logic):** Test the handler's success path, ensuring calls to the mock `ChainGateway` and `AgreementService` are correctly made.

***

### **Task 57 Code Implementation**

#### **57.1. `src/services/agreement.service.ts` (Updates - For Worker Callback)**

```typescript
// src/services/agreement.service.ts (partial update)
// ... (All previous imports and methods) ...
import { IAgreement } from '../models/agreement.model';


export class AgreementService {
    // ... (All previous methods) ...
    
    /** Worker-called method to update the agreement with a successful anchoring transaction ID. */
    public async updateAnchorTxId(agreementId: string, txId: string, chain: string): Promise<void> {
        const agreementObjectId = new Types.ObjectId(agreementId);
        
        const update = {
            $push: { 
                blockchainAnchors: { txId, chain, createdAt: new Date() } // Append to array
            },
            $set: { 
                // Optionally update status to permanently anchor the hash
            }
        };

        const result = await AgreementModel.updateOne(
            { _id: agreementObjectId },
            update
        );
        
        if (result.modifiedCount === 0) {
            throw new Error('AgreementNotFound');
        }

        // PRODUCTION: Emit 'agreement.anchored' event
        console.log(`[Event] Agreement ${agreementId} anchored on ${chain} with TXID: ${txId}.`);
    }
}
```

#### **57.2. `src/jobs/jobRegistry.ts` (Updates)**

```typescript
// src/jobs/jobRegistry.ts (partial update)
// ... (All previous imports and schemas) ...

// --- Schemas for Core Job Types ---
const BLOCKCHAIN_ANCHOR_SCHEMA: IJobSchema = {
    type: 'blockchain.anchor',
    required: ['agreementId', 'immutableHash', 'chain'],
    properties: {
        agreementId: 'string',
        immutableHash: 'string',
        chain: 'string', // e.g., 'polygon', 'ipfs'
    },
};

// --- Job Policies ---
const BLOCKCHAIN_ANCHOR_POLICY: IJobPolicy = {
    type: BLOCKCHAIN_ANCHOR_SCHEMA.type,
    maxAttempts: 10, // High attempts due to network/gas failures
    timeoutSeconds: 1800, // 30 minutes
};

// --- Registry Setup ---
const JOB_REGISTRY: Record<string, { schema: IJobSchema, policy: IJobPolicy }> = {
    // ... (Existing entries)
    [BLOCKCHAIN_ANCHOR_SCHEMA.type]: { schema: BLOCKCHAIN_ANCHOR_SCHEMA, policy: BLOCKCHAIN_ANCHOR_POLICY },
};
// ... (Export functions)
```

#### **57.3. `src/jobs/handlers/anchorHandler.ts` (New Handler File)**

```typescript
// src/jobs/handlers/anchorHandler.ts
import { IJob } from '../../models/job.model';
import { AgreementService } from '../../services/agreement.service'; 
import crypto from 'crypto';

const agreementService = new AgreementService();

// Mock External Chain Gateway
class ChainGateway {
    // Simulates sending the hash to an external API/Smart Contract
    public async submitHash(hash: string, chain: string): Promise<{ txId: string }> {
        if (chain === 'fail_test') {
            throw new Error('ChainNetworkBusy');
        }
        
        // Mock success with a unique transaction ID
        const txId = `0x${crypto.randomBytes(32).toString('hex')}`;
        console.log(`Anchoring Hash ${hash.substring(0, 10)}... on ${chain}. TXID: ${txId}`);
        return { txId };
    }
}
const chainGateway = new ChainGateway();

/**
 * Worker Logic Handler for the 'blockchain.anchor' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handleAnchorJob(job: IJob): Promise<{ txId: string, chain: string }> {
    const { agreementId, immutableHash, chain } = job.payload;
    
    // 1. Submit Hash to External Chain Gateway
    const { txId } = await chainGateway.submitHash(immutableHash, chain);

    // 2. Report Back to Agreement Service (Update the Parent Agreement Record)
    await agreementService.updateAnchorTxId(agreementId, txId, chain);

    // 3. Return the result payload
    return { txId, chain };
}
```

#### **57.4. `src/routes/job.routes.ts` (Updates - No API Changes)**

*(This task relies entirely on the existing job report endpoints from Task 54.)*

#### **57.5. Test Specification**

| Test ID | Method | Description | Condition | Expected Final Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T57.1** | `handleAnchorJob` | Happy Path | Valid `agreementId` | N/A | `agreementService.updateAnchorTxId` is called. |
| **T57.2** | `handleAnchorJob` | Fail: External Service Down | `chain: 'fail_test'` | N/A | Handler throws `ChainNetworkBusy` error; Job Service reports failure for retry. |
| **T57.3** | `Job Registry` | Policy Check | `blockchain.anchor` type | N/A | `maxAttempts` is 10; `timeoutSeconds` is 1800. |

---