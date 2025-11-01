Following the structured plan and moving into the critical Quality Assurance phase, we proceed with **Task 84: End-to-end Integration Tests (core flows)**.

This task is mandatory for validating the correct orchestration between all implemented microservices (Auth, Project, Payments, Notifications) and confirming that the full business logic is correctly enforced.

***

## **Task 84: End-to-end Integration Tests (core flows)**

**Goal:** Write and execute comprehensive integration tests that validate the full lifecycles of the two most critical business processes: 1) **Project Funding/Payout** and 2) **Project Collaboration/E-Sign**.

**Service:** `Quality Assurance` (Orchestration Test)
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** All core domain services (Task 1, 12, 14, 26, 36, 50, 60).

**Output Files:**
1.  `test/e2e/01_project_funding.e2e.test.ts` (New file: Tests Project/Payments lifecycle)
2.  `test/e2e/02_agreement_sign.e2e.test.ts` (New file: Tests Agreements/Audit lifecycle)

**Input/Output Shapes:**

| E2E Flow | Start $\rightarrow$ End | Critical Checks | Expected Final State |
| :--- | :--- | :--- | :--- |
| **Funding** | Creator Login $\rightarrow$ Project Create $\rightarrow$ Milestone Fund $\rightarrow$ Milestone Approve $\rightarrow$ Payout Check | 1. `Escrow` lock/release status. 2. `PayoutItem` created. 3. `AuditLog` for approval. | `Milestone.status: 'approved'`, `PayoutItem.status: 'scheduled'`. |
| **E-Sign** | Creator Login $\rightarrow$ Agreement Generate $\rightarrow$ Signer 1 Sign $\rightarrow$ Signer 2 Sign | 1. Signer status transitions. 2. `Agreement.status` becomes `'signed'`. 3. Final `AuditLog` written. | `Agreement.status: 'signed'`, `pdfAssetId` populated (mocked). |

**Runtime & Env Constraints:**
*   Tests must rely on **live service endpoints** (HTTP calls) to validate the integration layer, not on mocked service methods.
*   Tests must run in the isolated CI/CD environment (Task 77) with a clean database instance.

**Acceptance Criteria:**
*   The Funding flow successfully simulates the external funding events (webhook mock) and verifies that the system internally schedules the payout batch.
*   The E-Sign flow successfully simulates multiple users signing the document and confirms the final status flip and triggering of the long-running PDF job.

**Tests to Generate:**
*   **e2e/01\_project\_funding.e2e.test.ts:** Test case for the full funding lifecycle.
*   **e2e/02\_agreement\_sign.e2e.test.ts:** Test case for the full multi-signer lifecycle.

***

### **Task 84 Code Implementation (Test Logic Specification)**

#### **84.1. `test/e2e/01_project_funding.e2e.test.ts` (Conceptual Test Flow)**

```typescript
// test/e2e/01_project_funding.e2e.test.ts (Conceptual Flow)

// Mocks: Mocked HTTP client for making calls, MOCK_WEBHOOK_SECRET, MOCK_TEST_USER_ID, MOCK_TEST_CREATOR_ID

describe('E2E: Project Funding and Payout Lifecycle', () => {
    let ownerToken: string;
    let projectOwnerId: string;
    let projectId: string;
    let milestoneId: string;
    let escrowId: string;

    // --- Setup/Login ---
    test('1. Setup: Register and Login Project Owner', async () => {
        // CALL POST /auth/signup (Task 1) -> get ownerToken, projectOwnerId
    });

    // --- Phase 1: Creation and Funding ---
    test('2. Project: Create Project and Milestone', async () => {
        // CALL POST /projects (Task 12) -> get projectId
        // CALL POST /projects/:id/milestones (Task 14) -> get milestoneId (Milestone status: 'pending')
    });

    test('3. Payments: Create Intent and Simulate Webhook Success', async () => {
        // CALL POST /payments/intents (Task 34) -> get intentId, providerId

        // SIMULATE WEBHOOK CALL (Internal integration test)
        // CALL POST /webhooks/provider/stripe (Task 69) with 'payment_intent.succeeded' payload
        // This webhook handler internally calls paymentService.lockEscrow (Task 35)
        
        // ASSERT: Transaction status in DB is 'succeeded'
        // ASSERT: Escrow record is created in DB (get escrowId)
        // ASSERT: Project Milestone status is 'funded'
    });
    
    // --- Phase 2: Completion and Approval ---
    test('4. Project: Mark Milestone as Completed (Contributor)', async () => {
        // CALL POST /projects/:id/milestones/:mid/complete (Task 14) (Milestone status: 'completed')
    });

    test('5. Project: Owner Approves Milestone (Triggers Payout)', async () => {
        // CALL POST /projects/:id/milestones/:mid/approve (Task 30)
        // This internally calls paymentService.releaseEscrow (Task 36)
        
        // ASSERT: Milestone status is now 'approved'
        // ASSERT: AuditLog written for 'milestone.approved' (Task 60)
    });

    // --- Phase 3: Payout and Final Check ---
    test('6. Payout: Check Batch Scheduling', async () => {
        // ASSERT: PayoutBatchModel exists in DB (Task 32)
        // ASSERT: PayoutBatch status is 'scheduled'
        // ASSERT: Batch contains correct number of PayoutItems based on revenue split
    });
});
```

#### **84.2. `test/e2e/02_agreement_sign.e2e.test.ts` (Conceptual Test Flow)**

```typescript
// test/e2e/02_agreement_sign.e2e.test.ts (Conceptual Flow)

describe('E2E: Agreement Signing and Immutability Lifecycle', () => {
    let ownerToken: string;
    let signer2Token: string;
    let agreementId: string;

    // --- Setup/Login ---
    test('1. Setup: Register and Login Two Signers', async () => {
        // CALL POST /auth/signup (x2) -> get ownerToken, signer2Token
    });

    // --- Phase 1: Draft and Sign ---
    test('2. Agreement: Generate Draft with Two Signers', async () => {
        // CALL POST /projects/:id/agreements/generate (Task 21)
        // Signers payload includes ownerId and signer2Id
        // ASSERT: Agreement.status is 'draft'
    });

    test('3. Agreement: Signer 1 (Owner) Executes Typed Sign', async () => {
        // CALL POST /agreements/:id/sign (Task 26) with ownerToken, method: 'typed'
        
        // ASSERT: Agreement.status is 'partially_signed'
        // ASSERT: Signers array shows Signer 1's status as 'signed: true'
    });

    test('4. Agreement: Signer 2 Executes Typed Sign (Finalization)', async () => {
        // CALL POST /agreements/:id/sign (Task 26) with signer2Token, method: 'typed'
        
        // ASSERT: Agreement.status is 'signed'
        // ASSERT: AuditLog written for 'agreement.signed' (Task 60)
    });

    // --- Phase 2: Immutability and Access ---
    test('5. Immutability: Check PDF Asset and Hash', async () => {
        // Wait for PDF generation job to complete (Mock wait or status check)
        
        // ASSERT: Agreement.pdfAssetId is NOT null (Task 55)
        // ASSERT: Agreement.immutableHash is NOT null (Task 28)
    });

    test('6. Access: Download Final PDF', async () => {
        // CALL GET /agreements/:id/pdf (Task 27) with ownerToken
        // ASSERT: Response is 200 OK with downloadUrl
        // CALL GET /agreements/:id/pdf (Task 27) with unauthorized user token
        // ASSERT: Response is 403 Forbidden
    });
});
```

---