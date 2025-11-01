Following the structured plan and focusing on compliance and trust, we proceed with **Task 72: Immutable Snapshot Verification Tooling**.

This task implements the crucial administrative tool required to verify the integrity of the audit log and the cryptographic chain implemented in Tasks 60 and 71, ensuring no tampering has occurred.

***

## **Task 72: Immutable Snapshot Verification Tooling**

**Goal:** Implement the Admin-only verification endpoint (`GET /admin/audit-logs/verify`) that re-computes the cryptographic hash chain for a specified period (or the entire log) and compares the re-calculated hash against the stored hash of the subsequent log, reporting any tampering.

**Service:** `Admin & Audit / Reporting Service`
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 60 (AuditLog Service - Read), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/audit.service.ts` (Updated: `verifyAuditChainIntegrity`)
2.  `src/controllers/admin.controller.ts` (Updated: `verifyChainController`)
3.  `src/routes/admin.routes.ts` (Updated: new protected route)
4.  `test/unit/audit_verify.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /admin/audit-logs/verify** | `query: { from?, to? }` | `VerificationReportDTO` | Auth (Admin) |

**VerificationReportDTO (Excerpt):**
```json
{
  "status": "INTEGRITY_OK",
  "checkedLogsCount": 1500,
  "tamperDetected": false,
  "firstMismatchId": null,
  "verificationHash": "0xabcdef..."
}
```

**Runtime & Env Constraints:**
*   **Security (CRITICAL):** This is a read-intensive, highly privileged endpoint; it must be restricted to Admin access and may require elevated privileges.
*   **Cryptography:** Relies on the same `computeLogHash` utility (Task 60) for re-computation.
*   **Logic:** The process involves reading logs chronologically, re-hashing the log, and comparing the *re-calculated hash* to the *next log's stored `previousHash`*.

**Acceptance Criteria:**
*   The service successfully re-computes the hash for the requested period.
*   If no tampering is detected, `tamperDetected: false` is returned.
*   If tampering is simulated (by manually altering a log's content in the DB before running), the function returns `tamperDetected: true` and the `firstMismatchId`.

**Tests to Generate:**
*   **Unit Test (Tamper Check):** Test reading a chain of logs, manually alter Log B, and verify the checker correctly flags the chain break starting at Log C.

***

### **Task 72 Code Implementation**

#### **72.1. `src/services/audit.service.ts` (Updates)**

```typescript
// src/services/audit.service.ts (partial update)
// ... (Imports from Task 60, AuditLogModel, computeLogHash) ...

interface IVerificationReport {
    status: 'INTEGRITY_OK' | 'TAMPER_DETECTED' | 'NO_DATA';
    checkedLogsCount: number;
    tamperDetected: boolean;
    firstMismatchId: string | null;
    verificationHash: string; // The last successfully calculated hash (end of the chain)
}

export class AuditService {
    // ... (All previous methods) ...

    /** Re-computes the hash chain for a period to verify data integrity. */
    public async verifyAuditChainIntegrity(from?: Date, to?: Date): Promise<IVerificationReport> {
        const query: any = {};
        if (from || to) {
            query.timestamp = {};
            if (from) query.timestamp.$gte = from;
            if (to) query.timestamp.$lte = to;
        }

        // 1. Fetch Logs Chronologically (Must be the only reliable source)
        const logs = await AuditLogModel.find(query)
            .sort({ timestamp: 1 })
            .lean() as IAuditLog[];

        if (logs.length === 0) {
            return { status: 'NO_DATA', checkedLogsCount: 0, tamperDetected: false, firstMismatchId: null, verificationHash: '0x0' };
        }
        
        let previousHash = logs[0].previousHash; // Start with the first log's expected previous hash (0 for genesis)
        let tamperDetected = false;
        let firstMismatchId: string | null = null;
        let checkedLogsCount = 0;
        
        // 2. Iterate and Re-Compute Chain
        for (const currentLog of logs) {
            // Prepare data for re-hashing (excluding the stored hash/timestamps)
            const logDataToHash: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'> = {
                auditId: currentLog.auditId,
                resourceType: currentLog.resourceType,
                resourceId: currentLog.resourceId,
                action: currentLog.action,
                actorId: currentLog.actorId,
                actorRole: currentLog.actorRole,
                timestamp: currentLog.timestamp,
                ip: currentLog.ip,
                details: currentLog.details,
                previousHash: previousHash, // Use the hash from the *previous* successful computation
            };

            const reCalculatedHash = computeLogHash(logDataToHash, previousHash);
            
            // 3. Compare Stored Hash vs. Re-calculated Hash
            if (reCalculatedHash !== currentLog.hash) {
                tamperDetected = true;
                firstMismatchId = currentLog.auditId;
                console.error(`TAMPER DETECTED at Log ${currentLog.auditId}. Expected: ${reCalculatedHash}, Stored: ${currentLog.hash}`);
                break; // Stop on first error
            }

            // Update for the next iteration
            previousHash = reCalculatedHash; // The successfully validated hash becomes the next 'previousHash'
            checkedLogsCount++;
        }

        // 4. Return Report
        return {
            status: tamperDetected ? 'TAMPER_DETECTED' : 'INTEGRITY_OK',
            checkedLogsCount,
            tamperDetected,
            firstMismatchId,
            verificationHash: previousHash, // The last calculated hash
        };
    }
}
```

#### **72.2. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...

// --- Validation Middleware ---

export const auditVerifyValidation = [
    query('from').optional().isISO8601().toDate().withMessage('From date must be valid ISO 8601.'),
    query('to').optional().isISO8601().toDate().withMessage('To date must be valid ISO 8601.'),
];


// --- Admin Audit Controller ---

/** Verifies the cryptographic integrity of the audit chain. GET /admin/audit-logs/verify */
export const verifyChainController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { from, to } = req.query;
        
        // Service performs the integrity check
        const report = await auditService.verifyAuditChainIntegrity(from as unknown as Date, to as unknown as Date);

        // Success (200 OK)
        if (report.tamperDetected) {
            // Return 409 Conflict if tampering found (critical administrative alert)
            return res.status(409).json(report); 
        }
        
        return res.status(200).json(report);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during chain verification.' } });
    }
};
```

#### **72.3. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 66/67) ...
import { verifyChainController, auditVerifyValidation } from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// ... (Admin Audit Log Endpoints from Task 61) ...


// --- Admin Audit Verification Endpoints (Task 72) ---

// GET /admin/audit-logs/verify - Verify hash chain integrity
router.get(
    '/audit-logs/verify',
    authenticate,
    authorize(adminAccess), // RBAC check
    auditVerifyValidation,
    verifyChainController
);


export default router;
```

#### **72.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T72.1** | `GET /verify` | Happy Path: Integrity OK | Auth Admin, Logs are untouched. | **200 OK** | `tamperDetected: false`. |
| **T72.2** | `GET /verify` | Fail: Tamper Detected | Auth Admin, Simulate manual DB change to Log 2. | **409 Conflict** | `tamperDetected: true`, `firstMismatchId` points to Log 2. |
| **T72.3** | `GET /verify` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied`. |
| **T72.4** | `Unit Test` | Chain Logic | Re-hash a chain of 3 logs. | N/A | Calculated hash of Log 2 must equal Log 3's expected `previousHash`. |

--