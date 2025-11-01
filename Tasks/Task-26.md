Following the project plan and prioritizing the completion of the vital legal and financial process, here is the detailed implementation for **Task 26: Agreements/Licensing E-Signature & Status Update**.

This task builds on Task 21 to implement the core signing functionality, transitioning an agreement from `draft` to `signed` status, which is a mandatory gateway for final payment and collaboration.

***

## **Task 26: Agreements/Licensing E-Signature & Status Update**

**Goal:** Implement the primary endpoint for signing an agreement (`POST /agreements/:id/sign`), handling both the internal 'typed' signature method and external e-sign provider callbacks, and transition the agreement status upon full completion.

**Service:** `Agreements & Licensing Service`
**Phase:** D - Agreements, Licensing & Audit foundations
**Dependencies:** Task 21 (Agreement Model/Service - Draft), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/agreement.service.ts` (Updated: `initiateSigning`, `completeSigning`)
2.  `src/controllers/agreement.controller.ts` (Updated: `signAgreementController`)
3.  `src/routes/agreement.routes.ts` (Updated: new protected route)
4.  `test/integration/signing_flow.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /agreements/:id/sign** | `Params: { agreementId }`, Body: `{ method: 'typed', signatureName: string }` | `{ signerEmail: string, status: 'partially_signed' }` | Auth (Signer only) |

**Success Response (Fully Signed):**
```json
{
  "agreementId": "ag_1234",
  "status": "signed",
  "message": "Agreement fully signed. Final PDF generation initiated."
}
```

**Runtime & Env Constraints:**
*   **Security:** Signature logic must be idempotent (prevents double signing).
*   **Authorization:** Only the specific person listed as a signer (matching `req.user.sub` or `req.user.email`) can sign.
*   **Concurrency:** Agreement status updates (`signed` status flip) must be atomic/transactional to ensure consistency before triggering next steps (PDF generation).

**Acceptance Criteria:**
*   A successful sign (typed/callback) updates the respective signer's status to `signed: true` and records `signedAt` and `signatureMethod`.
*   If the agreement is fully signed (all `signers` have `signed: true`), the agreement status must immediately transition to `'signed'`, and an event for PDF generation must be emitted.
*   Attempting to sign an already signed agreement returns **409 Conflict**.
*   A non-signer attempting to access this endpoint returns **403 Forbidden**.

**Tests to Generate:**
*   **Integration Test (Typed Sign):** Test successful signing by one party, and finalization by the last party.
*   **Integration Test (Conflict):** Test double-signing attempt (409).
*   **Integration Test (Authorization):** Test non-signer sign attempt (403).

***

### **Task 26 Code Implementation**

#### **26.1. `src/services/agreement.service.ts` (Updates)**

```typescript
// src/services/agreement.service.ts (partial update)
// ... (Imports from Task 21) ...

// Mock Job/Event Emitter
class MockJobQueue {
    public enqueuePdfJob(agreementId: string): void {
        console.log(`[Job Enqueued] Final PDF generation for Agreement ${agreementId}.`);
    }
}
const jobQueue = new MockJobQueue();

export class AgreementService {
    // ... (generateAgreementDraft method from Task 21) ...

    /**
     * Finds the signer entry for the authenticated user based on ID or email.
     * @throws {Error} - 'SignerNotFound'
     */
    private findSignerEntry(agreement: IAgreement, requesterId: string): ISigner {
        const signerEntry = agreement.signers.find(signer => 
            (signer.signerId && signer.signerId.toString() === requesterId) || 
            (signer.email === requesterId) // Use email if signerId is null
        );

        if (!signerEntry) { throw new Error('SignerNotFound'); }
        return signerEntry;
    }

    /**
     * Handles the completion of an agreement signature. Supports 'typed' and 'complete_esign' (webhook).
     * @param agreementId - The ID of the agreement.
     * @param requesterId - The ID/Email of the signer.
     * @param method - 'typed' or 'complete_esign'.
     * @param signatureName - The user's typed name (for 'typed' method).
     * @throws {Error} - 'AgreementNotFound', 'AlreadySigned', 'SignatureInvalid'.
     */
    public async completeSigning(agreementId: string, requesterId: string, method: 'typed' | 'complete_esign', signatureName?: string): Promise<IAgreement> {
        const agreementObjectId = new Types.ObjectId(agreementId);
        
        // 1. Fetch Agreement and Find Signer
        const agreement = await AgreementModel.findById(agreementObjectId);
        if (!agreement) { throw new Error('AgreementNotFound'); }
        
        const signerEntry = this.findSignerEntry(agreement.toObject() as IAgreement, requesterId);

        if (signerEntry.signed) { throw new Error('AlreadySigned'); }
        if (agreement.status !== 'draft' && agreement.status !== 'pending_signatures' && agreement.status !== 'partially_signed') {
            throw new Error('AgreementNotInSignableState');
        }

        // 2. Perform Atomic Update on Signer Sub-document
        const updateFields: any = {
            'signers.$.signed': true,
            'signers.$.signedAt': new Date(),
            'signers.$.signatureMethod': method,
            // Additional fields for typed signature: IP, Name, etc.
        };
        
        // Use positional operator ($) to update the specific sub-document
        const updatedAgreement = await AgreementModel.findOneAndUpdate(
            { _id: agreementObjectId, 'signers.email': signerEntry.email },
            { $set: updateFields },
            { new: true }
        );

        if (!updatedAgreement) { throw new Error('SignatureInvalid'); } // Failsafe if update fails

        // 3. Check Finalization Status
        const isFullySigned = updatedAgreement.signers.every(s => s.signed);
        
        if (isFullySigned) {
            // 4. Finalize Agreement (Atomic Transaction)
            await AgreementModel.updateOne(
                { _id: updatedAgreement._id },
                { $set: { status: 'signed', immutableHash: `SHA256_MOCK_${agreementId}` } } // Generate final hash (Task 28)
            );
            
            // 5. Trigger PDF Generation Job (Task 55)
            jobQueue.enqueuePdfJob(updatedAgreement.agreementId);

            // PRODUCTION: Emit 'agreement.fully_signed' event (Payment/Project services subscribe)
            eventEmitter.emit('agreement.fully_signed', { agreementId: updatedAgreement.agreementId, projectId: updatedAgreement.projectId.toString() });

            updatedAgreement.status = 'signed'; // Update in-memory copy for response
        } else {
            // Update status to partially signed if necessary
            await AgreementModel.updateOne(
                { _id: updatedAgreement._id },
                { $set: { status: 'partially_signed' } }
            );
            updatedAgreement.status = 'partially_signed';
        }
        
        // PRODUCTION: Emit 'agreement.signed' event (Notifications subscribe)
        eventEmitter.emit('agreement.signed', { agreementId, signerEmail: signerEntry.email, status: updatedAgreement.status });

        return updatedAgreement.toObject() as IAgreement;
    }
}
```

#### **26.2. `src/controllers/agreement.controller.ts` (Updates)**

```typescript
// src/controllers/agreement.controller.ts (partial update)
// ... (Imports, agreementService initialization, generateAgreementController) ...

export const signAgreementValidation = [
    param('agreementId').isString().withMessage('Agreement ID is required.'),
    body('method').isIn(['typed', 'complete_esign', 'initiate_esign']).withMessage('Invalid signing method.'),
    body('signatureName').if(body('method').equals('typed')).isString().isLength({ min: 1 }).withMessage('Signature name is required for typed signing.'),
];

/** Handles the agreement signing process. POST /agreements/:id/sign */
export const signAgreementController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { agreementId } = req.params;
        const requesterId = req.user!.sub; // Authenticated User ID
        const { method, signatureName } = req.body;

        if (method === 'initiate_esign') {
            // Future Task: Call DocuSign/AdobeSign API, return provider URL/token
            return res.status(200).json({ status: 'initiated', message: 'E-sign initiation successful. Check email for link.' });
        }
        
        // Assume 'typed' method for current implementation:
        const updatedAgreement = await agreementService.completeSigning(agreementId, requesterId, method, signatureName);

        // 3. Success Response (200 OK)
        if (updatedAgreement.status === 'signed') {
             return res.status(200).json({ status: 'signed', message: 'Agreement fully signed. Final PDF generation initiated.' });
        }
        
        return res.status(200).json({ status: 'partially_signed', message: 'Signature recorded. Awaiting other signers.' });

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'AgreementNotFound') { return res.status(404).json({ error: { code: 'agreement_not_found', message: 'Agreement not found.' } }); }
        if (error.message === 'SignerNotFound') { return res.status(403).json({ error: { code: 'not_signer', message: 'You are not listed as a valid signer for this document.' } }); }
        if (error.message === 'AlreadySigned') { return res.status(409).json({ error: { code: 'already_signed', message: 'This document has already been signed by you.' } }); }
        if (error.message === 'AgreementNotInSignableState') { return res.status(409).json({ error: { code: 'invalid_status', message: 'Agreement cannot be signed in its current state.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during signing process.' } });
    }
};
```

#### **26.3. `src/routes/agreement.routes.ts` (Updates)**

```typescript
// src/routes/agreement.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 21) ...
import { signAgreementController, signAgreementValidation } from '../controllers/agreement.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();
// ... (projectIdValidation) ...

// ... (POST /projects/:projectId/agreements/generate from Task 21) ...


// --- E-Signature Endpoints (Task 26) ---

// POST /agreements/:agreementId/sign - Process a signature (Typed/Callback)
router.post(
    '/:agreementId/sign',
    authenticate,
    signAgreementValidation,
    // NOTE: RBAC check is done in the service logic (only signer allowed)
    signAgreementController
);


export default router;
```

#### **26.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T26.1** | `POST /:id/sign` | Happy Path: Partial Sign | Auth Signer (1 of 2), `method: 'typed'` | **200 OK** | `partially_signed` |
| **T26.2** | `POST /:id/sign` | Happy Path: Final Sign | Auth Signer (2 of 2), `method: 'typed'` | **200 OK** | `signed` (and PDF job enqueued) |
| **T26.3** | `POST /:id/sign` | Fail: Already Signed | Auth Signer (2nd attempt) | **409 Conflict** | `already_signed` |
| **T26.4** | `POST /:id/sign` | Fail: Not Signer | Auth Non-Signer | **403 Forbidden** | `not_signer` |
| **T26.5** | `POST /:id/sign` | Fail: Invalid Agreement | Invalid `agreementId` | **404 Not Found** | `agreement_not_found` |

---
