Following the structured plan, we proceed with **Task 30: Project Milestone Approval & Dispute**.

This task is critical for the financial flow, implementing the owner's gateway for releasing funds (approval) and the mechanism for challenging a completed milestone (dispute).

***

## **Task 30: Project Milestone Approval & Dispute**

**Goal:** Implement the owner-driven milestone approval endpoint (`POST /projects/:id/milestones/:mid/approve`) which triggers escrow release, and the member-driven dispute endpoint (`POST /projects/:id/milestones/:mid/dispute`) which puts funds on hold.

**Service:** `Project Management Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 14 (Milestone CRUD/Complete), Task 2 (RBAC Middleware), Task 8 (Payments & Escrow Service - mock integration for release).

**Output Files:**
1.  `src/services/project.service.ts` (Updated: `approveMilestone`, `disputeMilestone`)
2.  `src/controllers/project.controller.ts` (Updated: new controllers)
3.  `src/routes/project.routes.ts` (Updated: new protected routes)
4.  `test/integration/milestone_release.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /projects/:id/milestones/:mid/approve** | `Params: { projectId, milestoneId }` | `{ status: 'approved', released: true }` | Auth (Owner only) |
| **POST /projects/:id/milestones/:mid/dispute** | `Body: { reason: string, evidenceAssetIds?: string[] }` | `{ status: 'disputed', disputeId: string }` | Auth (Member only) |

**Success Response (Approval):**
```json
{
  "milestoneId": "m_650fa1b2",
  "status": "approved",
  "escrowReleaseStatus": "release_initiated",
  "message": "Milestone approved and funds release initiated."
}
```

**Runtime & Env Constraints:**
*   **Transactional Logic:** Milestone approval **MUST** only proceed if the milestone status is `'completed'` and not already `'approved'`.
*   **Concurrency/Idempotency:** Approval must trigger a call to the Payments/Escrow Service to release funds (mocked here, but in Task 35, this will be critical and must be idempotent).
*   **Dispute:** The dispute action is simple and only requires membership.

**Acceptance Criteria:**
*   `POST /approve` returns **409 Conflict** if the milestone is not in `'completed'` state.
*   Approval successfully transitions status to `'approved'` and emits a `milestone.approved` event.
*   The service must return **409 Conflict** if a dispute is filed on an already `'approved'` milestone.
*   The `disputeMilestone` method must transition status to `'disputed'` and emit a `milestone.disputed` event.

**Tests to Generate:**
*   **Integration Test (Approve):** Test owner approval success, non-owner failure (403), and state conflict (409).
*   **Integration Test (Dispute):** Test member dispute success, non-member denial (403), and verify status transition.

***

### **Task 30 Code Implementation**

#### **30.1. `src/services/project.service.ts` (Updates)**

```typescript
// src/services/project.service.ts (partial update)
// ... (Imports from Task 29) ...
import { IMilestone, IProject } from '../models/project.model';
import { ProjectModel } from '../models/project.model';

// Mock Payments Service for fund release (Task 35 dependency)
class MockPaymentService {
    /** Simulates the request to release funds from escrow. Returns provider job ID. */
    public async releaseEscrow(escrowId: string, milestoneId: string, amount: number): Promise<{ releaseJobId: string }> {
        console.log(`[Payment Mock] Initiating release for ESCROW ${escrowId}. Amount: ${amount}.`);
        return { releaseJobId: `release_job_${crypto.randomBytes(4).toString('hex')}` };
    }

    /** Simulates the request to put escrow on hold during a dispute. */
    public async holdEscrow(escrowId: string, disputeId: string): Promise<void> {
        console.log(`[Payment Mock] Placing HOLD on ESCROW ${escrowId} due to dispute ${disputeId}.`);
    }
}
const paymentService = new MockPaymentService();


export class ProjectService {
    // ... (All previous CRUD/Milestone/Invite/Archive methods) ...

    /** Milestone Approval Logic. Triggers fund release. */
    public async approveMilestone(projectId: string, requesterId: string, milestoneId: string): Promise<IMilestone> {
        const project = await this.checkOwnerAccess(projectId, requesterId); // Check is owner
        const milestone = this.getMilestone(project, milestoneId);
        const milestoneObjectId = new Types.ObjectId(milestoneId);
        
        // 1. STATE CHECK (Must be 'completed')
        if (milestone.status !== 'completed') {
            throw new Error('MilestoneNotCompleted');
        }
        
        // 2. FUND RELEASE CHECK (Must be funded to release)
        if (!milestone.escrowId || !milestone.amount) {
            throw new Error('MilestoneNotFunded');
        }

        // 3. EXECUTE RELEASE (Mocked External Call)
        const { releaseJobId } = await paymentService.releaseEscrow(
            milestone.escrowId.toString(), 
            milestoneId, 
            milestone.amount
        );

        // 4. Perform Atomic Status Update
        const updatedProject = await ProjectModel.findOneAndUpdate(
            { _id: project._id, 'milestones._id': milestoneObjectId },
            { 
                $set: { 
                    'milestones.$.status': 'approved',
                    // Optional: Store releaseJobId/metadata here
                } 
            },
            { new: true }
        );
        
        if (!updatedProject) { throw new Error('UpdateFailed'); }

        // PRODUCTION: Emit 'project.milestone.approved' event (Task 32 subscribes for Payouts)
        eventEmitter.emit('project.milestone.approved', { projectId, milestoneId, releaseJobId });
        
        return this.getMilestone(updatedProject, milestoneId);
    }

    /** Milestone Dispute Logic. Triggers fund hold. */
    public async disputeMilestone(projectId: string, completerId: string, milestoneId: string, reason: string, evidenceAssetIds?: string[]): Promise<IMilestone> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) { throw new Error('ProjectNotFound'); }
        
        // 1. Check Project Membership (Requester must be a member)
        if (!project.teamMemberIds.some(id => id.toString() === completerId)) {
            throw new Error('PermissionDenied');
        }
        
        const milestone = this.getMilestone(project, milestoneId);
        const milestoneObjectId = new Types.ObjectId(milestoneId);

        // 2. STATE CHECK (Cannot dispute if already approved/disputed)
        if (milestone.status === 'approved' || milestone.status === 'disputed' || milestone.status === 'rejected') {
            throw new Error('MilestoneAlreadyProcessed');
        }
        
        // 3. Trigger Fund Hold (Mocked External Call, if funded)
        let disputeId: string | undefined;
        if (milestone.escrowId) {
            disputeId = `dispute_${crypto.randomBytes(6).toString('hex')}`;
            await paymentService.holdEscrow(milestone.escrowId.toString(), disputeId);
        }

        // 4. Perform Atomic Status Update
        const updatedProject = await ProjectModel.findOneAndUpdate(
            { _id: project._id, 'milestones._id': milestoneObjectId },
            { 
                $set: { 
                    'milestones.$.status': 'disputed',
                    // PRODUCTION: Store dispute metadata (reason, asset IDs, disputeId) in a log/sub-document
                } 
            },
            { new: true }
        );
        
        if (!updatedProject) { throw new Error('UpdateFailed'); }

        // PRODUCTION: Emit 'project.milestone.disputed' event (Task 65 subscribes for Admin)
        eventEmitter.emit('project.milestone.disputed', { projectId, milestoneId, completerId, disputeId });

        return this.getMilestone(updatedProject, milestoneId);
    }
}
```

#### **30.2. `src/controllers/project.controller.ts` (Updates)**

```typescript
// src/controllers/project.controller.ts (partial update)
// ... (Imports, projectService initialization, all previous controllers) ...
import { body, param, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const disputeValidation = [
    body('reason').isString().isLength({ min: 10 }).withMessage('A reason for dispute is required (min 10 chars).'),
    body('evidenceAssetIds').optional().isArray().withMessage('Evidence must be an array of asset IDs.'),
];

// --- Milestone Approval/Dispute Controllers ---

/** Owner approves a completed milestone. POST /projects/:id/milestones/:mid/approve */
export const approveMilestoneController = async (req: Request, res: Response) => {
    // Validation for params is sufficient here
    
    try {
        const { projectId, milestoneId } = req.params;
        const approvedMilestone = await projectService.approveMilestone(projectId, req.user!.sub, milestoneId);
        
        // NOTE: Assume external service handles the actual release; we report status as initiated
        return res.status(200).json({
            milestoneId: approvedMilestone._id!.toString(),
            status: approvedMilestone.status,
            escrowReleaseStatus: 'release_initiated',
            message: 'Milestone approved and funds release process initiated.',
        });

    } catch (error: any) {
        if (error.message === 'MilestoneNotCompleted') { return res.status(409).json({ error: { code: 'not_completed', message: 'Milestone must be completed before it can be approved.' } }); }
        if (error.message === 'MilestoneNotFunded') { return res.status(409).json({ error: { code: 'not_funded', message: 'Milestone has no associated escrow funds to release.' } }); }
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner can approve milestones.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during approval.' } });
    }
};

/** Member/Owner disputes a milestone. POST /projects/:id/milestones/:mid/dispute */
export const disputeMilestoneController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { projectId, milestoneId } = req.params;
        const updatedMilestone = await projectService.disputeMilestone(projectId, req.user!.sub, milestoneId, req.body.reason, req.body.evidenceAssetIds);

        return res.status(200).json({
            milestoneId: updatedMilestone._id!.toString(),
            status: updatedMilestone.status,
            message: 'Milestone dispute logged. Funds release is paused.',
        });
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_member', message: 'You must be a project member to dispute a milestone.' } }); }
        if (error.message === 'MilestoneAlreadyProcessed') { return res.status(409).json({ error: { code: 'already_processed', message: 'Milestone is already approved or disputed.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during dispute.' } });
    }
};
```

#### **30.3. `src/routes/project.routes.ts` (Updates)**

```typescript
// src/routes/project.routes.ts (partial update)
import { Router } from 'express';
// ... (All previous imports) ...
import {
    approveMilestoneController, disputeMilestoneController,
    milestoneParamValidation, disputeValidation
} from '../controllers/project.controller';

const router = Router();
const ownerAccess = [PERMISSIONS.PROJECT_CREATE]; 


// ... (All other Task 12/13/14/15/29 endpoints) ...


// --- Milestone Approval/Dispute Endpoints (Task 30) ---

// POST /projects/:projectId/milestones/:milestoneId/approve - Owner approves (triggers fund release)
router.post(
    '/:projectId/milestones/:milestoneId/approve',
    authenticate,
    authorize(ownerAccess), // Must be owner
    milestoneParamValidation,
    approveMilestoneController
);

// POST /projects/:projectId/milestones/:milestoneId/dispute - Member disputes (triggers fund hold)
router.post(
    '/:projectId/milestones/:milestoneId/dispute',
    authenticate,
    milestoneParamValidation,
    disputeValidation,
    // NOTE: Membership check is done in the service
    disputeMilestoneController
);

export default router;
```

#### **30.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T30.1** | `POST /approve` | Happy Path: Approval | Auth Owner, Milestone=`completed`, `escrowId` present | **200 OK** | N/A (`release_initiated`) |
| **T30.2** | `POST /approve` | Fail: Not Completed | Auth Owner, Milestone=`pending` | **409 Conflict** | `not_completed` |
| **T30.3** | `POST /approve` | Fail: Not Owner | Auth Member | **403 Forbidden** | `not_owner` |
| **T30.4** | `POST /dispute` | Happy Path: Dispute | Auth Member, Milestone=`completed` | **200 OK** | N/A (`status: disputed`) |
| **T30.5** | `POST /dispute` | Fail: Not Member | Auth Non-Member | **403 Forbidden** | `not_member` |
| **T30.6** | `POST /dispute` | Fail: Already Approved | Auth Member, Milestone=`approved` | **409 Conflict** | `already_processed` |

---
