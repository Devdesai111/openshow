Following the structured plan and prioritizing administrative controls, we proceed with **Task 63: Moderation Queue & Actions API**.

This task implements the foundational tools for content and user behavior moderation, establishing the records and endpoints necessary for the platform's safety team to act on reported abuse.

***

## **Task 63: Moderation Queue & Actions API**

**Goal:** Implement the `ModerationRecord` model, the user-facing report content endpoint (`POST /moderation/report`), and the Admin-facing queue and action endpoints (`GET /admin/moderation/queue`, `POST /admin/moderation/:id/action`) to manage reported content.

**Service:** `Admin & Audit / Reporting Service`
**Phase:** H - Admin, Moderation, Disputes & Refunds
**Dependencies:** Task 60 (AuditLog Service), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/moderationRecord.model.ts` (New file: `IModerationRecord`, ModerationRecordSchema/Model)
2.  `src/services/moderation.service.ts` (New file: `reportContent`, `getModerationQueue`, `takeAction`)
3.  `src/controllers/admin.controller.ts` (Updated: new moderation controllers)
4.  `src/routes/admin.routes.ts` (Updated: new protected routes)
5.  `test/integration/moderation_flow.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /moderation/report** | `{ resourceType, resourceId, reason }` | `{ modId, status: 'open' }` | Auth/Public (Rate-limited) |
| **GET /admin/moderation/queue** | `query: { status?, severity? }` | `ModerationQueueResponse` (Paginated) | Auth (Admin/Moderator) |
| **POST /admin/moderation/:id/action** | `{ action: 'takedown'|'suspend', notes: string }` | `{ modId, status: 'actioned' }` | Auth (Admin/Moderator) |

**ModerationQueueResponse (Excerpt):**
```json
{
  "data": [
    { "modId": "mod_001", "resourceType": "comment", "severity": "high" }
  ]
}
```

**Runtime & Env Constraints:**
*   **Security:** The report endpoint must be rate-limited (Task 70). Admin endpoints require `ADMIN_DASHBOARD` RBAC.
*   **Audit:** All actions on a moderation record (report, assign, take action) must be recorded in the `AuditService` (Task 60).
*   **Downstream Action:** The `takeAction` logic must simulate calls to other services (e.g., `UserService.suspendUser` from Task 6) to enforce the action.

**Acceptance Criteria:**
*   `POST /report` successfully creates a record with `status: 'open'` and returns **201 Created**.
*   `POST /action` must record the action in the record and emit an `audit.created` event.
*   Admin users can retrieve the full queue, filtered by status and severity.
*   Non-Admin users cannot access the queue or action endpoints (403 Forbidden).

**Tests to Generate:**
*   **Integration Test (Reporting):** Test successful content reporting (201).
*   **Integration Test (Admin Action):** Test Admin retrieving the queue and successfully marking a record as `actioned` (verifying downstream call to `AuditService`).

***

### **Task 63 Code Implementation**

#### **63.1. `src/models/moderationRecord.model.ts` (New Model)**

```typescript
// src/models/moderationRecord.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IModerationAction {
  action: 'takedown' | 'suspend_user' | 'warn' | 'no_action' | 'escalate';
  by: Types.ObjectId; // Admin/Moderator ID
  notes?: string;
  createdAt: Date;
}

export interface IModerationRecord {
  _id?: Types.ObjectId;
  modId: string;
  resourceType: 'project' | 'asset' | 'user' | 'comment' | 'other';
  resourceId: Types.ObjectId; // The ID of the reported content/user
  reporterId?: Types.ObjectId; // The user who filed the report (optional if anonymous)
  severity: 'low' | 'medium' | 'high' | 'legal';
  status: 'open' | 'in_review' | 'actioned' | 'appealed' | 'closed';
  actions: IModerationAction[];
  evidenceAssetIds?: Types.ObjectId[];
  assignedTo?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const ModerationActionSchema = new Schema<IModerationAction>({
  action: { type: String, enum: ['takedown', 'suspend_user', 'warn', 'no_action', 'escalate'], required: true },
  by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  notes: { type: String, maxlength: 500 },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const ModerationRecordSchema = new Schema<IModerationRecord>({
  modId: { type: String, required: true, unique: true, default: () => `mod_${crypto.randomBytes(6).toString('hex')}` },
  resourceType: { type: String, enum: ['project', 'asset', 'user', 'comment', 'other'], required: true, index: true },
  resourceId: { type: Schema.Types.ObjectId, required: true, index: true },
  reporterId: { type: Schema.Types.ObjectId, ref: 'User' },
  severity: { type: String, enum: ['low', 'medium', 'high', 'legal'], default: 'medium', index: true },
  status: { type: String, enum: ['open', 'in_review', 'actioned', 'appealed', 'closed'], default: 'open', index: true },
  actions: { type: [ModerationActionSchema], default: [] },
  evidenceAssetIds: [{ type: Schema.Types.ObjectId, ref: 'Asset' }],
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

export const ModerationRecordModel = model<IModerationRecord>('ModerationRecord', ModerationRecordSchema);
```

#### **63.2. `src/services/moderation.service.ts` (New File)**

```typescript
// src/services/moderation.service.ts
import { ModerationRecordModel, IModerationRecord, IModerationAction } from '../models/moderationRecord.model';
import { AuditService } from './audit.service'; // Task 60 dependency
import { Types } from 'mongoose';
import { IAuthUser } from '../middlewares/auth.middleware';

const auditService = new AuditService(); // Instantiate Audit Service

interface IReportDTO {
    resourceType: IModerationRecord['resourceType'];
    resourceId: string;
    reason: string;
    evidenceAssetIds?: string[];
    severity?: IModerationRecord['severity'];
}

export class ModerationService {
    
    /** Allows users (or public) to report content. */
    public async reportContent(reporterId: string | null, data: IReportDTO): Promise<IModerationRecord> {
        const newRecord = new ModerationRecordModel({
            resourceType: data.resourceType,
            resourceId: new Types.ObjectId(data.resourceId),
            reporterId: reporterId ? new Types.ObjectId(reporterId) : undefined,
            severity: data.severity || 'medium',
            status: 'open',
            evidenceAssetIds: data.evidenceAssetIds?.map(id => new Types.ObjectId(id)),
            // Initial action note: The reason for the report
            actions: [{ action: 'report_filed', by: new Types.ObjectId('000000000000000000000000'), notes: data.reason }], // Placeholder ID for system/anon
        });

        const savedRecord = await newRecord.save();

        // 1. Audit Log (CRITICAL)
        await auditService.logAuditEntry({
            resourceType: 'moderation',
            resourceId: savedRecord._id.toString(),
            action: 'content.reported',
            actorId: reporterId,
            details: { reason: data.reason, resourceType: data.resourceType, resourceId: data.resourceId },
        });

        // PRODUCTION: Emit 'moderation.reported' event (Task 11 subscribes for Admin Alert)
        
        return savedRecord.toObject() as IModerationRecord;
    }

    /** Admin function to retrieve the moderation queue. */
    public async getModerationQueue(filters: any): Promise<any> {
        const { status, severity, page = 1, per_page = 20 } = filters;
        const limit = parseInt(per_page);
        const skip = (page - 1) * limit;

        const query: any = {};
        if (status) query.status = status;
        if (severity) query.severity = severity;

        // Execution
        const [totalResults, records] = await Promise.all([
            ModerationRecordModel.countDocuments(query),
            ModerationRecordModel.find(query)
                .sort({ createdAt: 1 }) // Oldest reports first
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IModerationRecord[]>
        ]);

        return {
            meta: { page, per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data: records.map(r => ({
                modId: r.modId,
                resourceType: r.resourceType,
                resourceId: r.resourceId.toString(),
                status: r.status,
                severity: r.severity,
                createdAt: r.createdAt!.toISOString(),
            })),
        };
    }

    /** Admin function to take action on a reported record. */
    public async takeAction(modId: string, adminId: string, action: IModerationAction['action'], notes: string): Promise<IModerationRecord> {
        const record = await ModerationRecordModel.findOne({ modId });
        if (!record) { throw new Error('RecordNotFound'); }
        
        if (record.status === 'closed' || record.status === 'actioned') {
             throw new Error('RecordAlreadyProcessed');
        }

        const newAction: IModerationAction = {
            action,
            by: new Types.ObjectId(adminId),
            notes,
            createdAt: new Date(),
        };

        // 1. Update Record
        record.actions.push(newAction);
        record.status = 'actioned'; // Simplest status transition
        record.assignedTo = new Types.ObjectId(adminId);
        const updatedRecord = await record.save();

        // 2. Downstream System Action (Mocked)
        if (action === 'suspend_user') {
            // PRODUCTION: Call AuthService.suspendUser (Task 6)
            console.log(`[System Call Mock] Suspending user ${record.resourceId.toString()}...`);
        }
        if (action === 'takedown') {
            // PRODUCTION: Call AssetService.deleteAsset or ProjectService.archiveProject
            console.log(`[System Call Mock] Takedown initiated for ${record.resourceType} ${record.resourceId.toString()}...`);
        }
        
        // 3. Audit Log (CRITICAL)
        await auditService.logAuditEntry({
            resourceType: 'moderation',
            resourceId: updatedRecord._id.toString(),
            action: `moderation.action.${action}`,
            actorId: adminId,
            details: { resourceType: record.resourceType, resourceId: record.resourceId.toString(), notes },
        });

        // PRODUCTION: Emit 'moderation.actioned' event
        
        return updatedRecord.toObject() as IModerationRecord;
    }
}
```

#### **63.3. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { body, param, query, validationResult } from 'express-validator';
import { ModerationService } from '../services/moderation.service';
import { Types } from 'mongoose';

const moderationService = new ModerationService();

// --- Validation Middleware ---
export const reportContentValidation = [
    body('resourceType').isIn(['project', 'asset', 'user', 'comment', 'other']).withMessage('Invalid resource type.'),
    body('resourceId').isMongoId().withMessage('Resource ID must be a valid Mongo ID.'),
    body('reason').isString().isLength({ min: 10 }).withMessage('Reason is required (min 10 chars).'),
    body('evidenceAssetIds').optional().isArray().withMessage('Evidence must be an array of asset IDs.'),
];

export const moderationQueueValidation = [
    query('status').optional().isIn(['open', 'in_review', 'actioned', 'closed']).withMessage('Invalid status filter.'),
    query('severity').optional().isIn(['low', 'medium', 'high', 'legal']).withMessage('Invalid severity filter.'),
];

export const takeActionValidation = [
    param('modId').isString().withMessage('Moderation ID is required.'),
    body('action').isIn(['takedown', 'suspend_user', 'warn', 'no_action', 'escalate']).withMessage('Invalid moderation action.'),
    body('notes').isString().isLength({ min: 5 }).withMessage('Notes are required for action.'),
];


// --- Admin Moderation Controllers ---

/** Allows users (or public) to report content. POST /moderation/report (exposed via public route) */
export const reportContentController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        // Reporter ID is optional (public report), but grab if authenticated
        const reporterId = req.user?.sub || null; 
        
        const record = await moderationService.reportContent(reporterId, req.body);

        return res.status(201).json({
            modId: record.modId,
            status: record.status,
            message: 'Report filed successfully. Thank you.',
        });
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error filing report.' } });
    }
};

/** Admin retrieves the moderation queue. GET /admin/moderation/queue */
export const getModerationQueueController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const queue = await moderationService.getModerationQueue(req.query);
        return res.status(200).json(queue);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving moderation queue.' } });
    }
};

/** Admin takes action on a reported record. POST /admin/moderation/:id/action */
export const takeActionController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { modId } = req.params;
        const { action, notes } = req.body;
        const adminId = req.user!.sub;

        const updatedRecord = await moderationService.takeAction(modId, adminId, action, notes);

        return res.status(200).json({
            modId: updatedRecord.modId,
            status: updatedRecord.status,
            actionTaken: action,
            message: 'Action recorded successfully. Downstream system calls may be initiated.',
        });
    } catch (error: any) {
        if (error.message === 'RecordNotFound') { return res.status(404).json({ error: { code: 'record_not_found', message: 'Moderation record not found.' } }); }
        if (error.message === 'RecordAlreadyProcessed') { return res.status(409).json({ error: { code: 'already_processed', message: 'This report has already been actioned or closed.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error taking action.' } });
    }
};
```

#### **63.4. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 39/42/60) ...
import { 
    reportContentController, getModerationQueueController, takeActionController,
    reportContentValidation, moderationQueueValidation, takeActionValidation
} from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// --- Public/Auth Moderation Endpoint (Task 63) ---

// POST /moderation/report - Allows users/public to report content
// NOTE: This endpoint should be rate-limited heavily for production.
router.post(
    '/moderation/report',
    // No authenticate required for anonymous reporting, but we check if req.user exists
    reportContentValidation,
    reportContentController
);


// --- Admin Moderation Endpoints (Task 63) ---

// GET /admin/moderation/queue - Get list of open reports
router.get(
    '/moderation/queue',
    authenticate,
    authorize(adminAccess), 
    moderationQueueValidation,
    getModerationQueueController
);

// POST /admin/moderation/:modId/action - Take action (takedown, suspend, warn)
router.post(
    '/moderation/:modId/action',
    authenticate,
    authorize(adminAccess),
    takeActionValidation,
    takeActionController
);


export default router;
```

#### **63.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T63.1** | `POST /moderation/report` | Happy Path: Creation | Auth User, Valid Payload | **201 Created** | `status: open`, Audit Log written. |
| **T63.2** | `GET /admin/moderation/queue`| Happy Path: Admin View | Auth Admin | **200 OK** | Returns list of reported content. |
| **T63.3** | `POST /admin/moderation/:id/action` | Happy Path: Suspend User | Auth Admin, `action: 'suspend_user'` | **200 OK** | Audit Log written, status $\rightarrow$ `actioned`. |
| **T63.4** | `POST /admin/moderation/:id/action` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T63.5** | `POST /admin/moderation/:id/action` | Fail: Double Action | Auth Admin, Record is already `actioned` | **409 Conflict** | `already_processed` |
