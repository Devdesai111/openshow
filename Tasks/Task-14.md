***

## **Task 14: Project Milestones (CRUD & Completion)**

**Goal:** Implement CRUD functionality for project milestones (`POST /projects/:id/milestones`, `PUT /projects/:id/milestones/:mid`, `DELETE /projects/:id/milestones/:mid`) and the contributor-driven status transition to mark a milestone as complete (`POST /projects/:id/milestones/:mid/complete`).

**Service:** `Project Management Service`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 12 (Project Model), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/project.service.ts` (Updated: `addMilestone`, `updateMilestone`, `deleteMilestone`, `completeMilestone`)
2.  `src/controllers/project.controller.ts` (Updated: new milestone controllers)
3.  `src/routes/project.routes.ts` (Updated: new protected routes)
4.  `test/integration/milestones.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /projects/:id/milestones** | `{ title, amount: number, dueDate?: string }` | `{ milestoneId: string, status: 'pending' }` | Auth (Owner only) |
| **PUT /projects/:id/milestones/:mid** | `{ title?, amount?: number, ... }` | `MilestoneDTO` (updated) | Auth (Owner only) |
| **POST /projects/:id/milestones/:mid/complete** | `Body: { notes?: string, evidenceAssetIds?: string[] }` | `{ status: 'completed', completedBy: string }` | Auth (Member/Owner) |

**MilestoneDTO (Excerpt):**
```json
{
  "milestoneId": "m_650fa1b2",
  "title": "Rough Cut Delivery",
  "amount": 200000,
  "currency": "USD",
  "status": "pending"
}
```

**Runtime & Env Constraints:**
*   **Security:** `PUT` must prevent modification of `amount`/`currency` if the milestone status is already `'funded'`.
*   **Authorization:** Milestone CRUD is strictly limited to the `project.ownerId`.
*   **Subdocument Handling:** Use Mongoose's `$push`, `$set` with positional operator (`$`) and `$pull` for efficient embedded array manipulation.

**Acceptance Criteria:**
*   Milestone CRUD endpoints enforce **Owner-only** access (403 if not owner/admin).
*   `POST /milestones` must validate that `amount` is present and $\geq 0$.
*   `POST /complete` requires the authenticated user to be a member of the project (checked in service).
*   On `POST /complete`, the milestone status must transition from `pending`/`funded` to `'completed'`.

**Tests to Generate:**
*   **Integration Test (CRUD):** Test milestone creation, update, and deletion by the owner.
*   **Integration Test (Update Constraint):** Test failed attempt to change the amount of a simulated 'funded' milestone (409 Conflict).
*   **Integration Test (Completion):** Test a successful member submission to mark complete.

***

### **Task 14 Code Implementation**

#### **14.1. `src/services/project.service.ts` (Updates)**

```typescript
// src/services/project.service.ts (partial update)
// ... (Imports from Task 12/13) ...

// Mock for checking project membership (future Task 15/Auth Service logic)
class MockProjectAcl {
    public isProjectMember(project: IProject, userId: string): boolean {
        return project.teamMemberIds.some(id => id.toString() === userId);
    }
}
const projectAcl = new MockProjectAcl();


export class ProjectService {
    // ... (createProject, checkOwnerAccess, inviteUser, applyForRole, assignRole methods) ...


    /** Finds and returns a specific milestone from the project document. */
    private getMilestone(project: IProject, milestoneId: string): IMilestone {
        const milestoneObjectId = new Types.ObjectId(milestoneId);
        const milestone = project.milestones.find(m => m._id?.equals(milestoneObjectId));
        if (!milestone) { throw new Error('MilestoneNotFound'); }
        return milestone;
    }


    // --- Milestone CRUD ---

    /** Adds a new milestone to a project. */
    public async addMilestone(projectId: string, requesterId: string, data: any): Promise<IMilestone> {
        const project = await this.checkOwnerAccess(projectId, requesterId);
        
        // 1. Create sub-document
        const newMilestone: IMilestone = {
            _id: new Types.ObjectId(),
            title: data.title,
            description: data.description,
            amount: data.amount,
            currency: data.currency || 'USD',
            dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
            status: 'pending',
            escrowId: undefined, // Will be set in Task 35
        };

        // 2. Push to embedded array
        await ProjectModel.updateOne(
            { _id: project._id },
            { $push: { milestones: newMilestone } }
        );

        // PRODUCTION: Emit 'project.milestone.created' event (Task 16, 17, 11 subscribe)
        console.log(`[Event] Project ${projectId} milestone ${newMilestone._id.toString()} created.`);
        
        return newMilestone;
    }


    /** Updates an existing milestone. */
    public async updateMilestone(projectId: string, requesterId: string, milestoneId: string, data: any): Promise<IMilestone> {
        const project = await this.checkOwnerAccess(projectId, requesterId);
        const milestone = this.getMilestone(project, milestoneId);
        const milestoneObjectId = new Types.ObjectId(milestoneId);
        
        // SECURITY CHECK: Prevent financial changes if funds are already locked/released
        if (milestone.status === 'funded' && (data.amount !== undefined || data.currency !== undefined)) {
            throw new Error('MilestoneFundedConflict');
        }
        
        // 1. Build dynamic update set for sub-document positional update
        const setUpdate: any = {};
        if (data.title !== undefined) setUpdate['milestones.$.title'] = data.title;
        if (data.amount !== undefined) setUpdate['milestones.$.amount'] = data.amount;
        if (data.dueDate !== undefined) setUpdate['milestones.$.dueDate'] = new Date(data.dueDate);
        
        // 2. Perform Positional Update
        const updatedProject = await ProjectModel.findOneAndUpdate(
            { _id: project._id, 'milestones._id': milestoneObjectId },
            { $set: setUpdate },
            { new: true }
        );
        
        if (!updatedProject) { throw new Error('UpdateFailed'); }

        // 3. Return the specific updated milestone
        return this.getMilestone(updatedProject, milestoneId);
    }


    /** Deletes an existing milestone. */
    public async deleteMilestone(projectId: string, requesterId: string, milestoneId: string): Promise<void> {
        const project = await this.checkOwnerAccess(projectId, requesterId);
        const milestone = this.getMilestone(project, milestoneId);
        const milestoneObjectId = new Types.ObjectId(milestoneId);
        
        // SECURITY CHECK: Cannot delete if funds are locked/released (Task 35 integration required)
        if (milestone.escrowId) { 
             throw new Error('MilestoneFundedConflict'); 
        }

        // 1. Perform atomic pull operation
        const result = await ProjectModel.updateOne(
            { _id: project._id },
            { $pull: { milestones: { _id: milestoneObjectId } } }
        );

        if (result.modifiedCount === 0) { throw new Error('MilestoneNotFound'); }
        
        // PRODUCTION: Emit 'project.milestone.deleted' event
        console.log(`[Event] Project ${projectId} milestone ${milestoneId} deleted.`);
    }


    // --- Status Transitions ---

    /** Marks a milestone as completed by a project member/owner. */
    public async completeMilestone(projectId: string, milestoneId: string, completerId: string, notes?: string, evidenceAssetIds?: string[]): Promise<IMilestone> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) { throw new Error('ProjectNotFound'); }

        // 1. Check Project Membership
        if (!projectAcl.isProjectMember(project, completerId)) {
            throw new Error('PermissionDenied');
        }
        
        const milestone = this.getMilestone(project, milestoneId);
        const milestoneObjectId = new Types.ObjectId(milestoneId);
        
        // 2. State Check: Only transition from 'pending' or 'funded'
        if (milestone.status === 'completed' || milestone.status === 'approved') {
            throw new Error('MilestoneAlreadyProcessed');
        }

        // 3. Perform atomic status update
        const updatedProject = await ProjectModel.findOneAndUpdate(
            { _id: project._id, 'milestones._id': milestoneObjectId },
            { 
                $set: { 
                    'milestones.$.status': 'completed',
                    // PRODUCTION: Store completion metadata (completerId, notes, evidenceAssetIds) in a separate log/sub-document if needed.
                } 
            },
            { new: true }
        );
        
        if (!updatedProject) { throw new Error('UpdateFailed'); }

        // PRODUCTION: Emit 'project.milestone.completed' event (Task 17, 11 subscribe)
        console.log(`[Event] Milestone ${milestoneId} marked completed by ${completerId}.`);
        
        return this.getMilestone(updatedProject, milestoneId);
    }
}
```

#### **14.2. `src/controllers/project.controller.ts` (Updates)**

```typescript
// src/controllers/project.controller.ts (partial update)
// ... (Imports, projectService initialization, Task 13 controllers) ...

// --- Validation Middleware ---

export const milestoneParamValidation = [
    param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
    param('milestoneId').isMongoId().withMessage('Invalid Milestone ID format.').bail(),
];

export const addMilestoneValidation = [
    body('title').isString().isLength({ min: 3 }).withMessage('Milestone title is required.'),
    body('amount').isInt({ min: 0 }).toInt().withMessage('Amount must be a non-negative integer (cents).'),
    body('dueDate').optional().isISO8601().toDate().withMessage('Due date must be a valid ISO 8601 date.'),
];

// --- Milestone Controllers ---

/** Adds a new milestone. POST /projects/:id/milestones */
export const addMilestoneController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const newMilestone = await projectService.addMilestone(req.params.projectId, req.user!.sub, req.body);

        return res.status(201).json({
            milestoneId: newMilestone._id!.toString(),
            title: newMilestone.title,
            amount: newMilestone.amount,
            status: newMilestone.status,
            createdAt: newMilestone.createdAt!.toISOString(),
        });
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner can add milestones.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error adding milestone.' } });
    }
};

/** Updates an existing milestone. PUT /projects/:id/milestones/:mid */
export const updateMilestoneController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const updatedMilestone = await projectService.updateMilestone(req.params.projectId, req.user!.sub, req.params.milestoneId, req.body);
        
        return res.status(200).json({
            milestoneId: updatedMilestone._id!.toString(),
            title: updatedMilestone.title,
            amount: updatedMilestone.amount,
            status: updatedMilestone.status,
        });
    } catch (error: any) {
        if (error.message === 'MilestoneFundedConflict') { return res.status(409).json({ error: { code: 'funded_conflict', message: 'Cannot modify amount/currency of an already funded milestone.' } }); }
        if (error.message === 'MilestoneNotFound') { return res.status(404).json({ error: { code: 'milestone_not_found', message: 'Milestone not found for this project.' } }); }
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner can update milestones.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating milestone.' } });
    }
};

/** Deletes an existing milestone. DELETE /projects/:id/milestones/:mid */
export const deleteMilestoneController = async (req: Request, res: Response) => {
    try {
        await projectService.deleteMilestone(req.params.projectId, req.user!.sub, req.params.milestoneId);
        
        return res.status(204).send();
    } catch (error: any) {
        if (error.message === 'MilestoneFundedConflict') { return res.status(409).json({ error: { code: 'funded_conflict', message: 'Cannot delete a milestone with associated funds/escrow.' } }); }
        if (error.message === 'MilestoneNotFound') { return res.status(404).json({ error: { code: 'milestone_not_found', message: 'Milestone not found for this project.' } }); }
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner can delete milestones.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error deleting milestone.' } });
    }
};

/** Marks a milestone as completed. POST /projects/:id/milestones/:mid/complete */
export const completeMilestoneController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { projectId, milestoneId } = req.params;
        const completerId = req.user!.sub;

        const updatedMilestone = await projectService.completeMilestone(projectId, milestoneId, completerId, req.body.notes, req.body.evidenceAssetIds);

        return res.status(200).json({
            milestoneId: updatedMilestone._id!.toString(),
            status: updatedMilestone.status,
            completedBy: completerId,
            message: 'Milestone marked as complete, awaiting owner approval.',
        });
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_member', message: 'Only a project member can complete milestones.' } }); }
        if (error.message === 'MilestoneAlreadyProcessed') { return res.status(409).json({ error: { code: 'already_completed', message: 'Milestone is already completed or approved.' } }); }
        if (error.message === 'MilestoneNotFound') { return res.status(404).json({ error: { code: 'milestone_not_found', message: 'Milestone not found for this project.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error completing milestone.' } });
    }
};
```

#### **14.3. `src/routes/project.routes.ts` (Updates)**

```typescript
// src/routes/project.routes.ts (partial update)
import { Router } from 'express';
// ... (Task 12/13 Imports) ...
import {
    addMilestoneController, updateMilestoneController, deleteMilestoneController, completeMilestoneController,
    milestoneParamValidation, addMilestoneValidation,
} from '../controllers/project.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';

const router = Router();
const ownerAccess = [PERMISSIONS.PROJECT_CREATE]; // Generic permission to mutate project state

// --- Milestone Management Endpoints (Task 14) ---

// POST /projects/:projectId/milestones - Add milestone (Owner only)
router.post(
    '/:projectId/milestones',
    authenticate,
    authorize(ownerAccess),
    addMilestoneValidation,
    addMilestoneController
);

// PUT /projects/:projectId/milestones/:milestoneId - Update milestone (Owner only)
router.put(
    '/:projectId/milestones/:milestoneId',
    authenticate,
    authorize(ownerAccess),
    milestoneParamValidation,
    updateMilestoneController
);

// DELETE /projects/:projectId/milestones/:milestoneId - Delete milestone (Owner only)
router.delete(
    '/:projectId/milestones/:milestoneId',
    authenticate,
    authorize(ownerAccess),
    milestoneParamValidation,
    deleteMilestoneController
);

// POST /projects/:projectId/milestones/:milestoneId/complete - Mark milestone complete (Member/Owner)
router.post(
    '/:projectId/milestones/:milestoneId/complete',
    authenticate,
    milestoneParamValidation,
    // NOTE: RBAC check is only 'authenticate'; membership validation is handled in the service layer
    completeMilestoneController
);


// ... (All other Task 12/13 endpoints) ...

export default router;
```

---
