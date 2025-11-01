Following the structured plan and focusing on completing the financial conflict resolution tools, we proceed with **Task 65: Dispute Resolution & Manual Escrow Action**.

This task implements the administrative endpoints for overseeing the dispute queue and, crucially, the manual actions required to resolve a dispute by forcing a release or refund of the contested escrow funds.

***

## **Task 65: Dispute Resolution & Manual Escrow Action**

**Goal:** Implement the administrative queue for disputes (`GET /admin/disputes/queue`) and the manual resolution endpoint (`POST /admin/disputes/:id/resolve`) which orchestrates fund movement via the Payment Service (Task 36).

**Service:** `Admin & Audit / Reporting Service`
**Phase:** H - Admin, Moderation, Disputes & Refunds
**Dependencies:** Task 30 (Milestone Dispute Logic), Task 36 (Payment Service - Release/Refund), Task 60 (AuditLog Service).

**Output Files:**
1.  `src/models/disputeRecord.model.ts` (New file: `IDisputeRecord`, DisputeRecordSchema/Model)
2.  `src/services/admin.service.ts` (Updated: `getDisputeQueue`, `resolveDispute`)
3.  `src/controllers/admin.controller.ts` (Updated: new dispute controllers)
4.  `src/routes/admin.routes.ts` (Updated: new protected routes)
5.  `test/integration/dispute_resolve.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /admin/disputes/queue** | `query: { status?, page? }` | `DisputeListResponse` | Auth (Admin/Disputes Role) |
| **POST /admin/disputes/:id/resolve** | `{ resolution: 'release'|'refund'|'split', amount?: number, notes: string }` | `{ disputeId, status: 'resolved' }` | Auth (Admin/Disputes Role) |

**Resolution Logic:**
*   `resolution: 'release'` $\rightarrow$ Calls `PaymentService.releaseEscrow` (Task 36) for the full amount.
*   `resolution: 'refund'` $\rightarrow$ Calls `PaymentService.refundEscrow` (Task 36) for the full amount.
*   `resolution: 'split'` $\rightarrow$ Calls both `releaseEscrow` and `refundEscrow` for the specified split amounts.

**Runtime & Env Constraints:**
*   **Authorization:** All dispute endpoints require Admin access (`ADMIN_DASHBOARD`).
*   **Transactional Orchestration:** The `resolveDispute` method must update the `DisputeRecord`, then call the *critical* external financial services (Payments Service).
*   **Audit:** All resolution actions **must** be recorded in the `AuditService` (Task 60).

**Acceptance Criteria:**
*   `POST /resolve` successfully calls the correct financial service method (`releaseEscrow` or `refundEscrow`).
*   The `DisputeRecord` status transitions to `'resolved'` and stores the resolution details.
*   The resolution action is audited with details including the resolution type.

**Tests to Generate:**
*   **Integration Test (Queue):** Test Admin successfully querying the queue.
*   **Integration Test (Resolution - Release):** Test Admin resolving a dispute with `'release'` and verify the call to `PaymentService.releaseEscrow` mock.

***

### **Task 65 Code Implementation**

#### **65.1. `src/models/disputeRecord.model.ts` (New Model)**

```typescript
// src/models/disputeRecord.model.ts
import { Schema, model, Types } from 'mongoose';

// Defines the final action taken to resolve the dispute
interface IResolution {
  outcome: 'release' | 'refund' | 'split' | 'deny';
  resolvedAmount?: number; // The amount released/refunded (if full/split)
  refundAmount?: number;
  notes: string;
  resolvedBy: Types.ObjectId;
  resolvedAt: Date;
}

export interface IDisputeRecord {
  _id?: Types.ObjectId;
  disputeId: string;
  projectId: Types.ObjectId;
  escrowId: Types.ObjectId;
  milestoneId: Types.ObjectId;
  raisedBy: Types.ObjectId;
  reason: string;
  status: 'open' | 'under_review' | 'resolved' | 'escalated' | 'closed';
  resolution?: IResolution;
  evidenceAssetIds?: Types.ObjectId[];
  assignedTo?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const ResolutionSchema = new Schema<IResolution>({
    outcome: { type: String, enum: ['release', 'refund', 'split', 'deny'], required: true },
    resolvedAmount: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },
    notes: { type: String, required: true, maxlength: 1000 },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    resolvedAt: { type: Date, required: true, default: Date.now },
}, { _id: false });

const DisputeRecordSchema = new Schema<IDisputeRecord>({
  disputeId: { type: String, required: true, unique: true, default: () => `dsp_${crypto.randomBytes(6).toString('hex')}` },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  escrowId: { type: Schema.Types.ObjectId, ref: 'Escrow', required: true, unique: true, index: true },
  milestoneId: { type: Schema.Types.ObjectId, required: true },
  raisedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  reason: { type: String, required: true, maxlength: 2000 },
  status: { type: String, enum: ['open', 'under_review', 'resolved', 'escalated', 'closed'], default: 'open', index: true },
  resolution: { type: ResolutionSchema },
  evidenceAssetIds: [{ type: Schema.Types.ObjectId, ref: 'Asset' }],
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

export const DisputeRecordModel = model<IDisputeRecord>('DisputeRecord', DisputeRecordSchema);
```

#### **65.2. `src/services/admin.service.ts` (Updates)**

```typescript
// src/services/admin.service.ts (partial update)
// ... (Imports, AuditService, AdminService class definition) ...
import { DisputeRecordModel, IDisputeRecord } from '../models/disputeRecord.model';
import { PaymentService } from './payment.service'; // Task 36 Dependency

const paymentService = new PaymentService();

interface IResolveDisputeDTO {
    resolution: IResolution['outcome'];
    releaseAmount?: number;
    refundAmount?: number;
    notes: string;
}


export class AdminService {
    // ... (listAllUsers, updateUserRole methods from Task 64) ...

    /** Admin function to retrieve the dispute queue. */
    public async getDisputeQueue(filters: any): Promise<any> {
        const { status, page = 1, per_page = 20 } = filters;
        const limit = parseInt(per_page);
        const skip = (page - 1) * limit;

        const query: any = { status };
        
        // Execution
        const [totalResults, disputes] = await Promise.all([
            DisputeRecordModel.countDocuments(query),
            DisputeRecordModel.find(query)
                .sort({ createdAt: 1 }) 
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IDisputeRecord[]>
        ]);

        return {
            meta: { page: parseInt(page.toString()), per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data: disputes.map(d => ({ 
                disputeId: d.disputeId,
                projectId: d.projectId.toString(),
                escrowId: d.escrowId.toString(),
                status: d.status,
                reason: d.reason,
                createdAt: d.createdAt!.toISOString(),
            })),
        };
    }

    /** Manually resolves a financial dispute. */
    public async resolveDispute(disputeId: string, adminId: string, resolutionData: IResolveDisputeDTO): Promise<IDisputeRecord> {
        const dispute = await DisputeRecordModel.findOne({ disputeId, status: { $in: ['open', 'under_review'] } });
        if (!dispute) { throw new Error('DisputeNotFoundOrResolved'); }

        const { resolution, releaseAmount = 0, refundAmount = 0, notes } = resolutionData;
        
        // 1. FINANCIAL ORCHESTRATION (CRITICAL)
        let totalReleased = 0;
        
        if (resolution === 'release' || resolution === 'split') {
            const amount = resolution === 'release' ? dispute.escrowId : releaseAmount;
            // NOTE: PaymentService.releaseEscrow needs Project Owner ID for access check, using Admin ID as proxy here.
            await paymentService.releaseEscrow(dispute.escrowId.toString(), adminId, 'admin', amount);
            totalReleased += amount;
        }
        
        if (resolution === 'refund' || resolution === 'split') {
            // Refund amount is often determined by the contested amount minus any released portion
            await paymentService.refundEscrow(dispute.escrowId.toString(), adminId, 'admin', refundAmount, `Dispute Resolution (${disputeId})`);
            totalReleased -= refundAmount; // Reduce released amount for tracking
        }
        
        // 2. Update Dispute Record
        const resolutionEntry: IResolution = {
            outcome: resolution,
            resolvedAmount: totalReleased > 0 ? totalReleased : 0,
            refundAmount: refundAmount,
            notes,
            resolvedBy: new Types.ObjectId(adminId),
            resolvedAt: new Date(),
        };

        dispute.status = 'resolved';
        dispute.resolution = resolutionEntry;
        const updatedDispute = await dispute.save();

        // 3. Audit Log
        await auditService.logAuditEntry({
            resourceType: 'dispute',
            resourceId: dispute._id.toString(),
            action: `dispute.resolved.${resolution}`,
            actorId: adminId,
            details: { escrowId: dispute.escrowId.toString(), resolution: resolutionEntry },
        });

        return updatedDispute.toObject() as IDisputeRecord;
    }
}
```

#### **65.3. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { body, query, param, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const disputeQueueValidation = [
    query('status').optional().isIn(['open', 'under_review', 'escalated']).withMessage('Invalid dispute status filter.'),
    // ... (page/per_page validation reused)
];

export const resolveDisputeValidation = [
    param('disputeId').isString().withMessage('Dispute ID is required.'),
    body('resolution').isIn(['release', 'refund', 'split', 'deny']).withMessage('Invalid resolution outcome.'),
    body('notes').isString().isLength({ min: 10 }).withMessage('Notes are required for resolution.'),
    body('releaseAmount').optional().isInt({ min: 0 }).toInt().withMessage('Release amount must be non-negative integer.'),
    body('refundAmount').optional().isInt({ min: 0 }).toInt().withMessage('Refund amount must be non-negative integer.'),
];


// --- Admin Dispute Controllers ---

/** Retrieves the dispute queue. GET /admin/disputes/queue */
export const getDisputeQueueController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const queue = await adminService.getDisputeQueue(req.query);
        return res.status(200).json(queue);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving dispute queue.' } });
    }
};

/** Manually resolves a dispute. POST /admin/disputes/:id/resolve */
export const resolveDisputeController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { disputeId } = req.params;
        const adminId = req.user!.sub;

        const updatedDispute = await adminService.resolveDispute(disputeId, adminId, req.body);

        return res.status(200).json({
            disputeId: updatedDispute.disputeId,
            status: updatedDispute.status,
            resolution: updatedDispute.resolution,
            message: 'Dispute successfully resolved and financial actions initiated.',
        });
    } catch (error: any) {
        if (error.message === 'DisputeNotFoundOrResolved') { return res.status(404).json({ error: { code: 'dispute_not_found', message: 'Dispute not found or already resolved.' } }); }
        // Future: Catch specific financial errors (e.g., Funds not available)
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error resolving dispute.' } });
    }
};
```

#### **65.4. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 64) ...
import { 
    getDisputeQueueController, resolveDisputeController, 
    disputeQueueValidation, resolveDisputeValidation 
} from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// ... (Admin User Management/Financial/Monitoring/Audit Endpoints) ...


// --- Admin Dispute Management Endpoints (Task 65) ---

// GET /admin/disputes/queue - Get list of open/pending disputes
router.get(
    '/disputes/queue',
    authenticate,
    authorize(adminAccess), 
    disputeQueueValidation,
    getDisputeQueueController
);

// POST /admin/disputes/:disputeId/resolve - Manually resolve a dispute
router.post(
    '/disputes/:disputeId/resolve',
    authenticate,
    authorize(adminAccess),
    resolveDisputeValidation,
    resolveDisputeController
);


export default router;
```

#### **65.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T65.1** | `GET /disputes/queue` | Happy Path: Admin Query | Auth Admin | **200 OK** | Returns list of open disputes. |
| **T65.2** | `POST /disputes/:id/resolve` | Resolution: Full Release | Auth Admin, `resolution: 'release'` | **200 OK** | `PaymentService.releaseEscrow` is called once. |
| **T65.3** | `POST /disputes/:id/resolve` | Resolution: Full Refund | Auth Admin, `resolution: 'refund'` | **200 OK** | `PaymentService.refundEscrow` is called once. |
| **T65.4** | `POST /disputes/:id/resolve` | Resolution: Split | Auth Admin, `resolution: 'split'`, with both amounts | **200 OK** | Both `releaseEscrow` and `refundEscrow` are called. |
| **T65.5** | `POST /disputes/:id/resolve` | Fail: Not Admin | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T65.6** | `POST /disputes/:id/resolve` | Fail: Already Resolved | Auth Admin, `status: 'resolved'` | **404 Not Found** | `dispute_not_found` |

---