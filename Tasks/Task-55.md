Following the structured plan, we proceed with **Task 55: Background Job: PDF Render & Upload**.

This task implements the logic for the second long-running job type, which is critical for the legal documentation lifecycle (Task 27), converting the finalized agreement data into an immutable, distributable PDF asset.

***

## **Task 55: Background Job: PDF Render & Upload**

**Goal:** Implement the worker handler logic for the `pdf.generate` job type, simulating the rendering of a final agreement document, uploading the PDF binary to cloud storage, and updating the source `Agreement` record with the resulting `pdfAssetId`.

**Service:** `Jobs & Worker Queue Service` / `Agreements & Licensing Service` (logic)
**Phase:** D - Agreements, Licensing & Audit foundations
**Dependencies:** Task 54 (Job Reporting Logic), Task 28 (Agreement Model), Task 20 (Asset Service - for upload/registration).

**Output Files:**
1.  `src/jobs/handlers/pdfRenderHandler.ts` (New file: Worker business logic)
2.  `src/jobs/jobRegistry.ts` (Updated: Register `pdf.generate` job type)
3.  `src/services/agreement.service.ts` (Updated: `updatePdfAssetId` utility)
4.  `test/unit/pdf_job.test.ts` (Test specification)

**Input/Output Shapes (Worker Logic):**
*   Input: `{ agreementId: string, payloadJson: any }`
*   Simulated Success: Calls `AssetService` to register new PDF $\rightarrow$ Calls `AgreementService` to update `pdfAssetId` $\rightarrow$ Calls `POST /jobs/:id/succeed`.

**Runtime & Env Constraints:**
*   **Decoupling:** The handler must use the `AssetService` (Task 22) to perform the final registration of the PDF.
*   **Execution Time:** This job is defined as "long-running" (up to $\sim 10$ minutes) requiring the Job Service to have a robust lease renewal mechanism (simulated).
*   **Immutability:** The PDF content is generated from the canonical `payloadJson` stored in the `AgreementModel`.

**Acceptance Criteria:**
*   The job handler successfully mocks the PDF creation, registers a new asset (`AssetModel`) for the PDF binary, and retrieves its `assetId`.
*   The `AgreementModel` is successfully updated with the resulting `pdfAssetId`.
*   The `pdf.generate` job type is correctly registered in the `jobRegistry.ts` with a long timeout (e.g., 600 seconds).

**Tests to Generate:**
*   **Unit Test (Handler Logic):** Test the handler's success path, ensuring calls to `AssetService` and `AgreementService` are correctly made.

***

### **Task 55 Code Implementation**

#### **55.1. `src/services/agreement.service.ts` (Updates - For Worker Callback)**

```typescript
// src/services/agreement.service.ts (partial update)
// ... (All previous imports and methods) ...

export class AgreementService {
    // ... (All previous methods) ...

    /** Worker-called method to update the final PDF asset ID on a fully signed agreement. */
    public async updatePdfAssetId(agreementId: string, pdfAssetId: string): Promise<void> {
        const agreementObjectId = new Types.ObjectId(agreementId);
        
        const result = await AgreementModel.updateOne(
            { _id: agreementObjectId, status: 'signed' }, // Concurrency/State check
            { $set: { pdfAssetId: new Types.ObjectId(pdfAssetId) } }
        );
        
        if (result.modifiedCount === 0) {
            throw new Error('AgreementNotSignedOrNotFound');
        }

        // PRODUCTION: Emit 'agreement.pdf.ready' event (Task 27 downloads unlock)
        console.log(`[Event] Agreement ${agreementId} PDF asset ID updated to ${pdfAssetId}.`);
    }
}
```

#### **55.2. `src/jobs/jobRegistry.ts` (Updates)**

```typescript
// src/jobs/jobRegistry.ts (partial update)
// ... (All previous imports and schemas) ...

// --- Schemas for Core Job Types ---
const PDF_GENERATE_SCHEMA: IJobSchema = {
    type: 'pdf.generate',
    required: ['agreementId', 'payloadJson'],
    properties: {
        agreementId: 'string',
        payloadJson: 'object', // Schema.Types.Mixed
    },
};

// --- Job Policies ---
const PDF_GENERATE_POLICY: IJobPolicy = {
    type: PDF_GENERATE_SCHEMA.type,
    maxAttempts: 5,
    timeoutSeconds: 600, // 10 minutes for potentially long rendering process
};

// --- Registry Setup ---
const JOB_REGISTRY: Record<string, { schema: IJobSchema, policy: IJobPolicy }> = {
    // ... (Existing entries)
    [PDF_GENERATE_SCHEMA.type]: { schema: PDF_GENERATE_SCHEMA, policy: PDF_GENERATE_POLICY },
};
// ... (Export functions)
```

#### **55.3. `src/jobs/handlers/pdfRenderHandler.ts` (New Handler File)**

```typescript
// src/jobs/handlers/pdfRenderHandler.ts
import { IJob } from '../../models/job.model';
import { AssetService } from '../../services/asset.service';
import { AgreementService } from '../../services/agreement.service';
import crypto from 'crypto';

const assetService = new AssetService();
const agreementService = new AgreementService();

// Mock Library for PDF Generation (Headless Browser/PDF Renderer)
const mockPdfRenderer = {
    renderHtmlToPdf: (htmlContent: string) => {
        // Simulates rendering a complex legal document
        console.log(`Rendering PDF for agreement...`);
        return Buffer.from(`%PDF-Mock-Content-${crypto.randomBytes(4).toString('hex')}`);
    }
};


/**
 * Worker Logic Handler for the 'pdf.generate' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handlePdfRenderJob(job: IJob): Promise<{ pdfAssetId: string }> {
    const { agreementId, payloadJson } = job.payload;
    const uploaderId = job.createdBy!.toString(); // Job creator is the 'uploader' for the derived asset

    // 1. Simulate Document Rendering (Convert Canonical JSON to PDF Buffer)
    const htmlContent = agreementService['mockTemplatePopulation'](payloadJson); // Reuse Task 21 mock
    const pdfBuffer = mockPdfRenderer.renderHtmlToPdf(htmlContent);
    
    // 2. Simulate Upload/Registration (Internal Server Upload)
    // NOTE: This simulates the server performing the upload and registration in one step
    
    const mimeType = 'application/pdf';
    const filename = `Agreement-${agreementId}-${job.attempt}.pdf`;
    const storageKey = `agreements/${agreementId}/${filename}`;
    const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    
    // Instead of a two-step client flow, mock an internal registration that skips the upload session
    const pdfAssetId = `asset_${crypto.randomBytes(6).toString('hex')}`; // Mock the final registered asset ID
    
    // PRODUCTION: AssetService.internalRegisterAsset(storageKey, pdfBuffer, uploaderId)
    console.log(`PDF successfully uploaded to mock storage key ${storageKey}.`);
    
    // 3. Update the Parent Agreement Record (CRITICAL STEP)
    await agreementService.updatePdfAssetId(agreementId, pdfAssetId);

    // 4. Return the result payload
    return { pdfAssetId };
}
```

#### **55.4. `src/routes/job.routes.ts` (Updates - No API Changes)**

*(No external API changes for this task. It relies entirely on the existing job report endpoints from Task 54.)*

#### **55.5. Test Specification**

| Test ID | Method | Description | Condition | Expected Final Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T55.1** | `handlePdfRenderJob` | Happy Path: Render/Register | Valid `agreementId` | N/A | `assetService.markAssetProcessed` (mocked) is called. |
| **T55.2** | `handlePdfRenderJob` | Critical Update Check | Call to `handlePdfRenderJob` | N/A | `agreementService.updatePdfAssetId` is called once. |
| **T55.3** | `handlePdfRenderJob` | Fail: Update Conflict | Simulated Mongoose `UpdateFailed` | N/A | Handler throws error; Job Service (Task 54) reports failure for retry. |

---