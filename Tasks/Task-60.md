Following the structured plan and prioritizing critical compliance infrastructure, we proceed with **Task 60: Audit Log Writer & Chainable Hashing**.

This task implements the core, immutable ledger for system events, which is essential for auditability, compliance (GDPR, finance), and security against log tampering.

***

## **Task 60: Audit Log Writer & Chainable Hashing**

**Goal:** Implement the immutable `AuditLog` model with cryptographic chain-hashing (`previousHash` and `hash`) and expose the internal write API (`POST /audit`) used by all other services to record irreversible system actions.

**Service:** `Admin & Audit / Reporting Service`
**Phase:** D - Agreements, Licensing & Audit foundations
**Dependencies:** Task 1 (User Model/ID types), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/auditLog.model.ts` (New file: `IAuditLog`, AuditLogSchema/Model)
2.  `src/utils/hashChain.utility.ts` (New file: Canonicalization and Hashing logic)
3.  `src/services/audit.service.ts` (New file: `logAuditEntry`, `getLastLog`)
4.  `src/controllers/admin.controller.ts` (Updated: `logAuditController`)
5.  `src/routes/admin.routes.ts` (Updated: new protected route)
6.  `test/unit/audit_chain.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (201 Created) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /audit** | `{ resourceType, action, actorId, details }` | `{ auditId, hash }` | Auth (Internal/System Only) |

**AuditLogDTO (Excerpt):**
```json
{
  "auditId": "audit_001",
  "action": "user.suspended",
  "previousHash": "0x0000...",
  "hash": "0xabcdef...",
  "timestamp": "2025-11-01T15:00:00Z"
}
```

**Runtime & Env Constraints:**
*   **Security (CRITICAL):** This endpoint is strictly restricted to **System/Internal Service** access (`ADMIN_DASHBOARD`).
*   **Cryptography:** Requires Node's `crypto` module (`sha256`) for all hashing operations.
*   **Immutability:** The logic must be append-only; no update/delete methods are allowed. The hash generation **must** include the previous log's hash in its input.

**Acceptance Criteria:**
*   `POST /audit` successfully calculates the new log's hash based on the previous log's hash (chaining) and saves the record.
*   The service correctly handles the "genesis" block (the very first log where `previousHash` is null).
*   The utility logic for canonicalization (sorting JSON keys) is robust and testable.
*   An attempt to write a log without authentication returns **403 Forbidden**.

**Tests to Generate:**
*   **Unit Test (Chaining):** Test the full hashing utility: `Log A` creates `Hash A`; `Log B` uses `Hash A` as `previousHash` to create `Hash B`.
*   **Integration Test (Write/Read):** Test writing two sequential logs and verify the chain integrity check (simulated).

***

### **Task 60 Code Implementation**

#### **60.1. `src/models/auditLog.model.ts` (New Model)**

```typescript
// src/models/auditLog.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IAuditLog {
  _id?: Types.ObjectId;
  auditId: string; // Internal identifier
  resourceType: string; // e.g., 'project', 'user', 'payment'
  resourceId?: Types.ObjectId;
  action: string; // e.g., 'user.suspended', 'refund.initiated'
  actorId?: Types.ObjectId; // User/System who performed action
  actorRole?: string;
  timestamp: Date;
  ip?: string;
  details: any; // Full context/payload of the action
  previousHash: string; // Hash of the immediately preceding log
  hash: string; // SHA256 of canonicalized record + previousHash
  immutable: boolean; // Flag to indicate if archived/verified
  createdAt?: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  auditId: { type: String, required: true, unique: true, default: () => `audit_${crypto.randomBytes(6).toString('hex')}` },
  resourceType: { type: String, required: true, index: true },
  resourceId: { type: Schema.Types.ObjectId, index: true },
  action: { type: String, required: true, index: true },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  actorRole: { type: String },
  timestamp: { type: Date, required: true, default: Date.now, index: true },
  ip: { type: String },
  details: { type: Schema.Types.Mixed },
  previousHash: { type: String, required: true }, // The chain link
  hash: { type: String, required: true, unique: true }, // The unique hash
  immutable: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } }); // Append-only

// PERFORMANCE: Primary index for chronological query
AuditLogSchema.index({ timestamp: -1, resourceType: 1 });

export const AuditLogModel = model<IAuditLog>('AuditLog', AuditLogSchema);
```

#### **60.2. `src/utils/hashChain.utility.ts` (New Utility File)**

```typescript
// src/utils/hashChain.utility.ts
import crypto from 'crypto';

/**
 * Deterministically stringifies an object by sorting keys for stable hashing (Canonicalization).
 */
export function canonicalizeJson(obj: any): string {
    if (typeof obj !== 'object' || obj === null) {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return '[' + obj.map(canonicalizeJson).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    const parts = keys.map(key => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`);
    return '{' + parts.join(',') + '}';
}

/**
 * Computes the unique, chainable hash for an audit log entry.
 * @param logData - The core log data (excluding current hash).
 * @param previousHash - The hash of the previous log entry.
 * @returns The SHA256 hash string.
 */
export function computeLogHash(logData: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'>, previousHash: string): string {
    // 1. Prepare hashable object including the chain link
    const hashableObject = {
        ...logData,
        previousHash: previousHash,
        // Convert IDs to strings explicitly for hashing consistency
        resourceId: logData.resourceId?.toString(),
        actorId: logData.actorId?.toString(),
    };

    // 2. Canonicalize and Hash (SHA256)
    const canonicalString = canonicalizeJson(hashableObject);
    return crypto.createHash('sha256').update(canonicalString).digest('hex');
}
```

#### **60.3. `src/services/audit.service.ts` (New File)**

```typescript
// src/services/audit.service.ts
import { AuditLogModel, IAuditLog } from '../models/auditLog.model';
import { computeLogHash, canonicalizeJson } from '../utils/hashChain.utility';
import { Types } from 'mongoose';

interface ILogEntryDTO {
    resourceType: string;
    resourceId?: string;
    action: string;
    actorId?: string;
    actorRole?: string;
    ip?: string;
    details: any;
}

export class AuditService {
    
    /** Retrieves the last successfully committed log for chain linking. */
    private async getLastLog(): Promise<IAuditLog | null> {
        return AuditLogModel.findOne({})
            .sort({ timestamp: -1 })
            .select('hash')
            .lean() as Promise<IAuditLog | null>;
    }

    /** Logs an immutable, cryptographically chained audit entry. */
    public async logAuditEntry(data: ILogEntryDTO): Promise<IAuditLog> {
        const lastLog = await this.getLastLog();
        
        // 1. Determine Previous Hash (Genesis Block is '0')
        const previousHash = lastLog ? lastLog.hash : '0000000000000000000000000000000000000000000000000000000000000000'; // 64 zeroes
        
        // 2. Prepare Log Data
        const timestamp = new Date();
        const logData: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'> = {
            auditId: `audit_${crypto.randomBytes(6).toString('hex')}`,
            resourceType: data.resourceType,
            resourceId: data.resourceId ? new Types.ObjectId(data.resourceId) : undefined,
            action: data.action,
            actorId: data.actorId ? new Types.ObjectId(data.actorId) : undefined,
            actorRole: data.actorRole,
            timestamp,
            ip: data.ip,
            details: data.details,
            previousHash,
        };

        // 3. Compute Hash
        const newHash = computeLogHash(logData, previousHash);
        
        // 4. Create and Save (Append-only)
        const newLog = new AuditLogModel({
            ...logData,
            hash: newHash,
        });

        const savedLog = await newLog.save();

        // PRODUCTION: Emit 'audit.created' event (Task 61 subscribes)
        console.log(`[Event] AuditLog ${savedLog.auditId} created with hash ${newHash.substring(0, 10)}...`);

        return savedLog.toObject() as IAuditLog;
    }
}
```

#### **60.4. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { body, validationResult } from 'express-validator';
import { AuditService } from '../services/audit.service';

const auditService = new AuditService();

// --- Validation Middleware ---

export const logAuditValidation = [
    body('resourceType').isString().withMessage('Resource type is required.'),
    body('action').isString().withLength({ min: 5 }).withMessage('Action is required.'),
    body('actorId').optional().isMongoId().withMessage('Actor ID must be a valid Mongo ID.'),
    body('details').isObject().withMessage('Details object is required.'),
];


// --- Admin Audit Controller ---

/** Writes an immutable audit log entry. POST /audit */
export const logAuditController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        // Use authenticated system/admin ID as the default actor
        const actorId = req.user!.sub; 
        const actorRole = req.user!.role;

        // 2. Service Call (Performs hashing and saves)
        const savedLog = await auditService.logAuditEntry({
            ...req.body,
            actorId,
            actorRole,
            ip: req.ip,
        });

        // 3. Success (201 Created)
        return res.status(201).json({
            auditId: savedLog.auditId,
            resourceType: savedLog.resourceType,
            action: savedLog.action,
            hash: savedLog.hash,
            timestamp: savedLog.timestamp.toISOString(),
        });

    } catch (error: any) {
        // High likelihood of a concurrency/DB error during save (E11000 - unique hash collision)
        return res.status(500).json({ error: { code: 'audit_save_fail', message: 'Internal server error saving immutable log.' } });
    }
};
```

#### **60.5. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 39/42) ...
import { logAuditController, logAuditValidation } from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// ... (Admin Financial/Monitoring/Ranking Endpoints) ...


// --- Admin Audit Log Endpoints (Task 60) ---

// POST /audit - Writes a new immutable log entry (Internal/System only)
router.post(
    '/audit',
    authenticate,
    authorize(adminAccess), // RBAC check: System/Admin access only
    logAuditValidation,
    logAuditController
);


export default router;
```

#### **60.6. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T60.1** | `POST /audit` | Happy Path: Genesis Log | Auth Admin, No previous logs in DB | **201 Created** | `previousHash: '000...'` |
| **T60.2** | `POST /audit` | Happy Path: Chained Log | Auth Admin, Log 2 follows Log 1 | **201 Created** | Log 2 `previousHash` equals Log 1 `hash`. |
| **T60.3** | `POST /audit` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T60.4** | `Unit Test` | Canonical Check | Two logs, same data, different key order | **N/A** | Calculated `hash` must be identical. |
