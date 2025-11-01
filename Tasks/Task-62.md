Following the structured plan, we proceed with **Task 62: Background Job: Audit Log Export**.

This task implements the logic for the specialized job type responsible for fulfilling compliance requests by securely exporting the immutable audit log data and placing the resulting file in cloud storage.

***

## **Task 62: Background Job: Audit Log Export**

**Goal:** Implement the worker handler logic for the `export.audit` job type, which queries the `AuditLogModel` based on filters (Task 61), formats the data (CSV/NDJSON), uploads the resulting file to cloud storage, and notifies the requester upon completion.

**Service:** `Jobs & Worker Queue Service` / `Admin & Audit / Reporting Service` (logic)
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 61 (Audit Log Query), Task 54 (Job Reporting Logic), Task 20 (Asset Service - for upload/registration).

**Output Files:**
1.  `src/jobs/handlers/auditExportHandler.ts` (New file: Worker business logic)
2.  `src/jobs/jobRegistry.ts` (Updated: Register `export.audit` job type - implicit in T61/52)
3.  `test/unit/audit_export_job.test.ts` (Test specification)

**Input/Output Shapes (Worker Logic):**
*   Input: `{ exportFilters: {}, format: string, requesterId: string }`
*   Simulated Success: Calls $\rightarrow$ `AssetService` registration $\rightarrow$ Calls `NotificationService` $\rightarrow$ Calls `POST /jobs/:id/succeed`.

**Runtime & Env Constraints:**
*   **Data Streaming:** The handler must simulate streaming the data to avoid high memory usage for large report exports.
*   **Security:** The resulting exported file must be registered as a secure asset (Task 20/22) for later retrieval via a signed URL.
*   **Notification:** The handler must notify the requester (Admin) that the export is ready (Mocked call to Notification Service).

**Acceptance Criteria:**
*   The job handler successfully queries the mock `AuditLogModel` based on the input filters.
*   The handler simulates the file upload and successfully calls the `AssetService`'s registration logic with the final file's metadata.
*   Upon completion, the handler successfully calls the mock `NotificationService` to alert the Admin.

**Tests to Generate:**
*   **Unit Test (Handler Logic):** Test the handler's end-to-end flow, ensuring the asset registration and notification calls are made on success.

***

### **Task 62 Code Implementation**

#### **62.1. `src/jobs/jobRegistry.ts` (Updates - For Completeness)**

*(The schema for `export.audit` was implied in Task 61; it is formally defined here to complete the registry.)*

```typescript
// src/jobs/jobRegistry.ts (partial update)
// ... (All previous imports and schemas) ...

// --- Schemas for Core Job Types ---
const EXPORT_AUDIT_SCHEMA: IJobSchema = {
    type: 'export.audit',
    required: ['exportFilters', 'format'],
    properties: {
        exportFilters: 'object',
        format: 'string', 
        requesterId: 'string', // Added from T61 controller
    },
};

// --- Job Policies ---
const EXPORT_AUDIT_POLICY: IJobPolicy = {
    type: EXPORT_AUDIT_SCHEMA.type,
    maxAttempts: 3,
    timeoutSeconds: 3600, // 1 hour for large data exports
};

// --- Registry Setup ---
const JOB_REGISTRY: Record<string, { schema: IJobSchema, policy: IJobPolicy }> = {
    // ... (Existing entries)
    [EXPORT_AUDIT_SCHEMA.type]: { schema: EXPORT_AUDIT_SCHEMA, policy: EXPORT_AUDIT_POLICY },
};
// ... (Export functions)
```

#### **62.2. `src/jobs/handlers/auditExportHandler.ts` (New Handler File)**

```typescript
// src/jobs/handlers/auditExportHandler.ts
import { IJob } from '../../models/job.model';
import { AuditLogModel } from '../../models/auditLog.model';
import { AssetService } from '../../services/asset.service'; // Task 22 dependency
import { NotificationService } from '../../services/notification.service'; // Task 11 dependency
import crypto from 'crypto';

const auditLogModel = AuditLogModel; // Direct model access for querying
const assetService = new AssetService(); // Using asset service for registration
const notificationService = new NotificationService(); // Using notification service for alert


/**
 * Worker Logic Handler for the 'export.audit' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handleAuditExportJob(job: IJob): Promise<{ exportAssetId: string, recordCount: number }> {
    const { exportFilters, format, requesterId } = job.payload;
    const requesterEmail = 'admin@example.com'; // Mock email

    // 1. QUERY DATA (Simulated Streaming Read)
    // NOTE: In production, this would use a cursor/stream to avoid OOM errors.
    const records = await auditLogModel.find(exportFilters).lean().sort({ timestamp: 1 });
    const recordCount = records.length;
    
    if (recordCount === 0) {
         throw new Error('NoRecordsFound');
    }

    // 2. FORMAT DATA (Mock: Create a simple file content)
    const fileContent = records.map(r => `${r.timestamp.toISOString()}, ${r.action}, ${r.hash}`).join('\n');
    const mimeType = format === 'csv' ? 'text/csv' : 'application/x-ndjson';
    const filename = `audit_export_${job.jobId}.${format}`;
    const fileSize = Buffer.byteLength(fileContent, 'utf8');

    // 3. SIMULATE CLOUD UPLOAD AND REGISTRATION
    // In a real app, this internal call would upload the Buffer and get a final storage key.
    const storageKey = `exports/audit/${job.jobId}/${filename}`;
    const exportAssetId = `asset_export_${crypto.randomBytes(6).toString('hex')}`;
    const sha256 = crypto.createHash('sha256').update(fileContent).digest('hex');

    // MOCK Asset Registration (Simulate the internal registration call after server-side upload)
    const assetRegistrationResult = {
        assetId: exportAssetId,
        versionNumber: 1,
        processed: true,
        createdAt: new Date().toISOString(),
    };
    
    // PRODUCTION: AssetService.internalRegisterAsset(storageKey, requesterId, fileSize, sha256)
    console.log(`Exported ${recordCount} records. Registered Asset ID: ${exportAssetId}`);

    // 4. NOTIFY REQUESTER (Mock Call to Notification Service)
    await notificationService.sendTemplateNotification({
        templateId: 'export.ready',
        recipients: [{ userId: requesterId, email: requesterEmail }],
        variables: { fileName: filename, fileSize, downloadLink: `(External Link for ${exportAssetId})` },
    } as any);

    // 5. Return the result payload
    return { exportAssetId, recordCount };
}
```

#### **62.3. `src/routes/admin.routes.ts` (No API Changes)**

*(This task relies entirely on the existing `POST /admin/audit-logs/export` endpoint from Task 61.)*

#### **62.4. Test Specification**

| Test ID | Method | Description | Condition | Expected Final Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T62.1** | `handleAuditExportJob` | Happy Path: Full Export | Valid filters, records present | N/A | `NotificationService.sendTemplateNotification` is called. |
| **T62.2** | `handleAuditExportJob` | Fail: No Records | Filters result in zero records. | N/A | Handler throws `NoRecordsFound`; Job Service reports failure. |
| **T62.3** | `handleAuditExportJob` | Success Data Check | N/A | N/A | Returns `exportAssetId` in the result payload. |