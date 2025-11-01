Following the structured plan, we proceed with **Task 29: Finalialize Project Management (Read/Archive)**.

This task finalizes the `Project Management Service`'s essential endpoints by implementing project deletion/archiving and adding the ability to retrieve the full team member list.

***

## **Task 29: Finalize Project Management (Read/Archive)**

**Goal:** Complete the Project Management API by implementing project deletion/archiving (`DELETE /projects/:projectId`) and providing the endpoint to retrieve the full, active team member list (`GET /projects/:id/team`).

**Service:** `Project Management Service`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 15 (Project List/Detail), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/project.service.ts` (Updated: `archiveProject`, `getTeamMembers`)
2.  `src/controllers/project.controller.ts` (Updated: new controllers)
3.  `src/routes/project.routes.ts` (Updated: new protected routes)
4.  `test/integration/project_finalize.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (204 No Content/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **DELETE /projects/:id** | `Params: { projectId }` | **204 No Content** | Auth (Owner/Admin) |
| **GET /projects/:id/team** | `Params: { projectId }` | `{ team: { userId, displayName, roleIds, ... }[] }` | Auth (Member/Admin) |

**Team List DTO (Excerpt - Denormalized):**
```json
{
  "projectId": "proj_123",
  "team": [
    { "userId": "user_owner", "displayName": "Owner", "roleIds": ["role_1"], "isOwner": true },
    { "userId": "user_member", "displayName": "Creator", "roleIds": ["role_2"] }
  ]
}
```

**Runtime & Env Constraints:**
*   **Security:** `DELETE /projects/:id` must be a **soft delete** (setting `status: 'archived'`) and must check for pending/locked escrows before archiving.
*   **Authorization:** The `DELETE` endpoint is restricted to the Project Owner or Admin.
*   **Performance:** `GET /team` requires denormalization (populating/lookup) of `project.teamMemberIds` and `UserModel` to provide display names and roles.

**Acceptance Criteria:**
*   `DELETE /projects/:id` returns **204 No Content** and sets `project.status='archived'` in the database.
*   If the project has an active escrow/funded milestone (mocked check), the delete must return **409 Conflict**.
*   `GET /projects/:id/team` returns **403 Forbidden** if the user is not a project member or Admin.
*   The team list DTO must correctly combine user data (`displayName`) with project data (roles).

**Tests to Generate:**
*   **Integration Test (Archive):** Test owner success, Admin success, and failure when active escrow exists (409).
*   **Integration Test (Team):** Test member access (200), non-member denial (403), and data consistency.

***

### **Task 29 Code Implementation**

#### **29.1. `src/services/project.service.ts` (Updates)**

```typescript
// src/services/project.service.ts (partial update)
// ... (Imports from Task 12/13/14/15) ...
import { UserModel, IUser } from '../models/user.model';
import { IAuthUser } from '../middlewares/auth.middleware';


export class ProjectService {
    // ... (All previous CRUD/Milestone/Invite/Apply/Assign methods) ...

    /** Checks if the requester is the project owner or Admin (for mutations). */
    private async checkOwnerOrAdminMutationAccess(projectId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<IProject> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) { throw new Error('ProjectNotFound'); }
        
        const isOwner = project.ownerId.toString() === requesterId;
        const isAdmin = requesterRole === 'admin';

        if (!isOwner && !isAdmin) { throw new Error('PermissionDenied'); }
        return project;
    }

    /** Archives a project (soft delete). */
    public async archiveProject(projectId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<void> {
        const project = await this.checkOwnerOrAdminMutationAccess(projectId, requesterId, requesterRole);

        // 1. BUSINESS RULE: Check for Active Escrows/Funded Milestones
        const hasActiveFunds = project.milestones.some(m => m.escrowId && m.status !== 'approved' && m.status !== 'rejected');
        if (hasActiveFunds) {
            throw new Error('ActiveEscrowConflict');
        }

        // 2. Execute Soft Delete/Archive
        const result = await ProjectModel.updateOne(
            { _id: project._id },
            { $set: { status: 'archived', visibility: 'private' } }
        );

        if (result.modifiedCount === 0) { throw new Error('ArchiveFailed'); }

        // PRODUCTION: Emit 'project.archived' event (Task 16 subscribes for index removal)
        eventEmitter.emit('project.archived', { projectId });
        console.log(`[Event] Project ${projectId} archived by ${requesterId}.`);
    }

    /** Retrieves the full, denormalized team member list. */
    public async getTeamMembers(projectId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<any> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) { throw new Error('ProjectNotFound'); }

        const isMember = project.teamMemberIds.some(id => id.toString() === requesterId);
        const isAdmin = requesterRole === 'admin';
        
        // 1. Authorization Check (Member/Admin only)
        if (!isMember && !isAdmin) {
            throw new Error('PermissionDenied');
        }

        // 2. Denormalize User Data (Fetch all users in one go)
        const teamMemberIds = project.teamMemberIds.map(id => id);
        const users = await UserModel.find({ _id: { $in: teamMemberIds } })
            .select('preferredName fullName email role')
            .lean() as IUser[];
        
        // Map user data to roles/project context
        const team = users.map(user => {
            const userRoles = project.roles.filter(r => 
                r.assignedUserIds.some(id => id.equals(user._id!))
            ).map(r => ({ roleId: r._id!.toString(), title: r.title }));

            return {
                userId: user._id!.toString(),
                displayName: user.preferredName || user.fullName || user.email,
                roleIds: userRoles.map(r => r.roleId),
                roleTitles: userRoles.map(r => r.title),
                isOwner: project.ownerId.equals(user._id!),
                // ... (Other denormalized fields like profile photo ID)
            };
        });

        return { projectId, team };
    }
}
```

#### **29.2. `src/controllers/project.controller.ts` (Updates)**

```typescript
// src/controllers/project.controller.ts (partial update)
// ... (Imports, projectService initialization, all previous controllers) ...

// --- Final Project Mutators/Readers ---

/** Archives a project (soft delete). DELETE /projects/:id */
export const archiveProjectController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid ID format.' }}); }

    try {
        await projectService.archiveProject(req.params.projectId, req.user!.sub, req.user!.role);
        
        return res.status(204).send(); // 204 No Content on successful deletion/archiving
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner_admin', message: 'Only the project owner or an Admin can archive this project.' } }); }
        if (error.message === 'ProjectNotFound') { return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found.' } }); }
        if (error.message === 'ActiveEscrowConflict') { return res.status(409).json({ error: { code: 'active_escrow', message: 'Project cannot be archived due to active escrow funds.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during archiving.' } });
    }
};

/** Retrieves the denormalized team list. GET /projects/:id/team */
export const getTeamMembersController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid ID format.' }}); }
    
    try {
        const teamDetails = await projectService.getTeamMembers(req.params.projectId, req.user!.sub, req.user!.role);
        
        return res.status(200).json(teamDetails);
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_member', message: 'You must be a project member to view the team list.' } }); }
        if (error.message === 'ProjectNotFound') { return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving team list.' } });
    }
};
```

#### **29.3. `src/routes/project.routes.ts` (Updates)**

```typescript
// src/routes/project.routes.ts (partial update)
import { Router } from 'express';
// ... (All previous imports) ...
import { 
    archiveProjectController, getTeamMembersController, projectParamValidation
} from '../controllers/project.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const ownerAccess = [PERMISSIONS.PROJECT_CREATE]; 
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; // Generic admin perm

// ... (All other Task 12/13/14/15 endpoints) ...


// --- Project Finalization Endpoints (Task 29) ---

// DELETE /projects/:projectId - Archive project (Owner/Admin only)
router.delete(
    '/:projectId',
    authenticate,
    // RBAC: Check for EITHER owner (checked in service) OR admin
    authorize(adminAccess), // Admin authorization is always highest, owner check is in service
    projectParamValidation,
    archiveProjectController
);

// GET /projects/:projectId/team - List team members (Member/Admin only)
router.get(
    '/:projectId/team',
    authenticate,
    projectParamValidation,
    // NOTE: Membership check is handled in the service
    getTeamMembersController
);


export default router;
```

#### **29.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T29.1** | `DELETE /:id` | Happy Path: Owner Archive | Auth Owner, No Escrow | **204 No Content** | N/A |
| **T29.2** | `DELETE /:id` | Fail: Active Escrow | Auth Owner, Funded Milestone | **409 Conflict** | `active_escrow` |
| **T29.3** | `DELETE /:id` | Fail: Non-Owner Archive | Auth Member | **403 Forbidden** | `not_owner_admin` |
| **T29.4** | `GET /:id/team` | Happy Path: Member Read | Auth Member | **200 OK** | Returns denormalized list of team members. |
| **T29.5** | `GET /:id/team` | Fail: Non-Member Read | Auth Non-Member | **403 Forbidden** | `not_member` |

---
