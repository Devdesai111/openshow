Following the structured plan, we proceed with **Task 28: Agreements/Licensing Immutability & Hash Anchoring**.

This task is crucial for compliance and auditability, implementing the final layer of security for the signed agreements by generating a canonical, immutable hash and preparing for external anchoring.

***

## **Task 28: Agreements/Licensing Immutability & Hash Anchoring**

**Goal:** Implement the logic to compute a canonical `immutableHash` for a fully signed agreement and expose an internal endpoint (`POST /agreements/:id/hash`) to store this hash and trigger an optional external anchoring job (e.g., to a blockchain/IPFS).

**Service:** `Agreements & Licensing Service`
**Phase:** D - Agreements, Licensing & Audit foundations
**Dependencies:** Task 26 (Signing Logic), Task 52 (Jobs/Worker Queue - for anchoring).

**Output Files:**
1.  `src/services/agreement.service.ts` (Updated: `computeCanonicalHash`, `storeImmutableHash`)
2.  `src/controllers/agreement.controller.ts` (Updated: `storeHashController`)
3.  `src/routes/agreement.routes.ts` (Updated: new internal/admin route)
4.  `test/unit/hash_canonical.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /agreements/:id/hash** | `Params: { agreementId }`, Body: `{ anchorChain: boolean }` | `{ status: 'hashed', immutableHash: string, jobId?: string }` | Auth (Internal/System Only) |

**Success Response (Hashed/Anchored):**
```json
{
  "status": "hashed",
  "immutableHash": "sha256:a1b2c3d4...",
  "message": "Hash stored and blockchain anchoring job queued.",
  "jobId": "job_007"
}
```

**Runtime & Env Constraints:**
*   **Cryptography:** Requires Node's `crypto` module (`sha256`) for hash generation.
*   **Canonicalization:** The JSON object must be sorted by key (canonicalized) before hashing to ensure a stable, deterministic hash value regardless of payload creation order.
*   **Authorization:** Strictly an **Internal/System** endpoint (Admin-only for Phase 1).

**Acceptance Criteria:**
*   A custom utility function (`computeCanonicalHash`) must be implemented to serialize a JSON object with sorted keys before generating its SHA256 hash.
*   The `storeImmutableHash` service method must:
    1.  Verify the agreement is `signed`.
    2.  Compute the hash of the `payloadJson` and `signers` array.
    3.  Persist the hash to `IAgreement.immutableHash`.
    4.  If `anchorChain=true`, enqueue a `blockchain.anchor` job (Task 57).
*   The endpoint must be protected by the highest RBAC level (Admin/Service Token).

**Tests to Generate:**
*   **Unit Test (Canonical Hash):** Test the hash function with two objects containing the same data but different key orders; result **must be identical**.
*   **Integration Test (Store Hash):** Test successful hash storage and job queuing, and failure on not-fully-signed agreement (409 Conflict).

***

### **Task 28 Code Implementation**

#### **28.1. `src/services/agreement.service.ts` (Updates - Hash Logic)**

```typescript
// src/services/agreement.service.ts (partial update)
// ... (Imports from Task 21/26) ...

import crypto from 'crypto';
import { IAgreement, IPayloadJson, ISigner } from '../models/agreement.model'; 

// --- Utility: Canonicalization ---

/**
 * Deterministically stringifies an object by sorting keys for stable hashing.
 */
function canonicalizeJson(obj: any): string {
    if (typeof obj !== 'object' || obj === null) {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return '[' + obj.map(canonicalizeJson).join(',') + ']';
    }
    // Sort keys and recurse
    const keys = Object.keys(obj).sort();
    const parts = keys.map(key => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`);
    return '{' + parts.join(',') + '}';
}

/**
 * Computes the immutable SHA256 hash of the core agreement data.
 */
export function computeCanonicalHash(agreement: IAgreement): string {
    // 1. Combine core components for hashing
    const hashableObject = {
        payload: agreement.payloadJson,
        signers: agreement.signers.map(s => ({
            // Only include immutable signature-related metadata
            email: s.email, 
            signedAt: s.signedAt ? s.signedAt.toISOString() : null,
            signatureMethod: s.signatureMethod,
        })),
        // Add agreement metadata that anchors the version, e.g., agreementId and version
        agreementId: agreement.agreementId,
        version: agreement.version,
    };

    // 2. Canonicalize and Hash
    const canonicalString = canonicalizeJson(hashableObject);
    return `sha256:${crypto.createHash('sha256').update(canonicalString).digest('hex')}`;
}


// Mock Job Queue (updated from Task 26)
class MockJobQueue {
    public enqueuePdfJob(agreementId: string): void { /* ... */ }
    public enqueueAnchorJob(agreementId: string, hash: string): string {
        console.log(`[Job Enqueued] Blockchain anchoring for Agreement ${agreementId}. Hash: ${hash}`);
        return `job_${crypto.randomBytes(4).toString('hex')}`;
    }
}
const jobQueue = new MockJobQueue();


export class AgreementService {
    // ... (generateAgreementDraft, completeSigning methods) ...

    /**
     * Computes, stores the immutable hash, and triggers optional chain anchoring.
     * @throws {Error} - 'AgreementNotFound', 'NotFullySigned', 'AlreadyHashed'.
     */
    public async storeImmutableHash(agreementId: string, requesterId: string, anchorChain: boolean): Promise<any> {
        const agreement = await AgreementModel.findOne({ agreementId });
        if (!agreement) { throw new Error('AgreementNotFound'); }
        
        if (agreement.status !== 'signed') { throw new Error('NotFullySigned'); }
        if (agreement.immutableHash) { throw new Error('AlreadyHashed'); } // Idempotency check

        // 1. Compute Hash
        const immutableHash = computeCanonicalHash(agreement.toObject() as IAgreement);
        
        // 2. Persist Hash
        agreement.immutableHash = immutableHash;
        await agreement.save();

        let jobId: string | undefined;
        let message = "Hash computed and stored.";

        // 3. Trigger Anchoring Job (Task 57)
        if (anchorChain) {
            jobId = jobQueue.enqueueAnchorJob(agreementId, immutableHash);
            message = "Hash stored and blockchain anchoring job queued.";
        }
        
        // PRODUCTION: Emit 'agreement.hashed' event
        eventEmitter.emit('agreement.hashed', { agreementId, immutableHash, jobId });

        return { status: 'hashed', immutableHash, jobId, message };
    }
}
```

#### **28.2. `src/controllers/agreement.controller.ts` (Updates)**

```typescript
// src/controllers/agreement.controller.ts (partial update)
// ... (Imports, agreementService initialization, previous controllers) ...

// --- Validation Middleware ---

export const storeHashValidation = [
    param('agreementId').isString().withMessage('Agreement ID is required.'),
    body('anchorChain').isBoolean().withMessage('AnchorChain flag is required and must be boolean.'),
];


/** Stores the immutable hash and triggers optional anchoring. POST /agreements/:id/hash */
export const storeHashController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { agreementId } = req.params;
        const requesterId = req.user!.sub; // System/Admin ID

        // 2. Service Call
        const result = await agreementService.storeImmutableHash(agreementId, requesterId, req.body.anchorChain);

        // 3. Success (200 OK)
        return res.status(200).json(result);

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'AgreementNotFound') { return res.status(404).json({ error: { code: 'agreement_not_found', message: 'Agreement not found.' } }); }
        if (error.message === 'NotFullySigned') { return res.status(409).json({ error: { code: 'not_signed', message: 'Agreement must be fully signed before hash can be immutably stored.' } }); }
        if (error.message === 'AlreadyHashed') { return res.status(409).json({ error: { code: 'already_hashed', message: 'Immutable hash is already stored for this agreement.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error storing immutable hash.' } });
    }
};
```

#### **28.3. `src/routes/agreement.routes.ts` (Updates)**

```typescript
// src/routes/agreement.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 21/26/27) ...
import { storeHashController, storeHashValidation } from '../controllers/agreement.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
// ... (Other validation/imports) ...

// ... (All other Task 21/26/27 endpoints) ...


// --- Immutability Endpoints (Task 28) ---

// POST /agreements/:agreementId/hash - Store immutable hash / anchor request (System/Admin only)
router.post(
    '/:agreementId/hash',
    authenticate,
    authorize([PERMISSIONS.ADMIN_DASHBOARD]), // Highest security: Admin/System access only
    storeHashValidation,
    storeHashController
);


export default router;
```

#### **28.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T28.1** | `POST /:id/hash` | Happy Path: Store and Queue | Auth Admin, `status: signed`, `anchorChain: true` | **200 OK** | N/A (`status: hashed`, `jobId` present) |
| **T28.2** | `POST /:id/hash` | Fail: Not Signed | Auth Admin, `status: partially_signed` | **409 Conflict** | `not_fully_signed` |
| **T28.3** | `POST /:id/hash` | Fail: Already Hashed (Idempotency) | Auth Admin, `immutableHash` already set | **409 Conflict** | `already_hashed` |
| **T28.4** | `Unit Test` | Canonical Hash Check | Two identical objects with different key orders | **N/A** | Hash must be identical. |
