Following the project plan, we proceed with **Task 13: Project Member Management (Invite/Apply/Assign)**.

This task is crucial for collaboration, allowing project owners to build their teams by issuing invites and handling applications for open roles within the newly established `ProjectModel`.

***

## **Task 13: Project Member Management (Invite/Apply/Assign)**

**Goal:** Implement the core endpoints and domain logic for managing project membership: inviting users (`POST /projects/:id/invite`), receiving applications (`POST /projects/:id/apply`), and assigning users to roles (`POST /projects/:id/roles/:roleId/assign`).

**Service:** `Project Management Service`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 12 (Project Model), Task 1 (User Model), Task 2 (RBAC Middleware), Task 11 (Notification Service - integration/mock).

**Output Files:**
1.  `src/models/projectApplication.model.ts` (New file: Application/Invite/Role Models)
2.  `src/services/project.service.ts` (Updated: `inviteUser`, `applyForRole`, `assignRole`)
3.  `src/controllers/project.controller.ts` (Updated: new member controllers)
4.  `src/routes/project.routes.ts` (Updated: new protected routes)
5.  `test/integration/member_management.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /projects/:id/invite** | `Body: { userId, roleId, message }` | `{ inviteId, projectId, status: 'pending' }` | Auth (Owner only) |
| **POST /projects/:id/apply** | `Body: { roleId, message, proposedRate? }` | `{ applicationId, status: 'pending' }` | Auth (Creator/Owner) |
| **POST /projects/:id/roles/:roleId/assign** | `Body: { userId }` | `{ roleId, assignedUserIds: [...] }` | Auth (Owner only) |

**Runtime & Env Constraints:**
*   Project existence and role validation must be performed in every endpoint.
*   The `assign` logic must check role slot capacity and prevent double assignment.
*   Notification service calls are mandatory on `invite` and `apply` (mock dependency usage).

**Acceptance Criteria:**
*   Owner-only endpoints (`invite`, `assign`) must return **403 Forbidden** if authenticated user $\neq$ `project.ownerId` and $\neq$ `admin`.
*   `POST /apply` must fail if `project.collaborationType` is 'invite' (returns **403 Forbidden**).
*   `POST /assign` must fail if the target role has all slots filled (returns **409 Conflict**).
*   Successful actions must update the `project.roles` embedded array and the denormalized `project.teamMemberIds`.

**Tests to Generate:**
*   **Integration Test (Invite/Assign):** Test owner-only access, slot capacity check (409), and successful assignment.
*   **Integration Test (Apply):** Test application to an 'open' project and denied application to an 'invite' project (403).

***

### **Task 13 Code Implementation**

#### **13.1. `src/models/projectApplication.model.ts` (New File)**

```typescript
// src/models/projectApplication.model.ts
import { Schema, model, Types } from 'mongoose';

// --- Invite Model (Used for tracking owner-initiated invitations) ---
export interface IProjectInvite {
  _id?: Types.ObjectId;
  projectId: Types.ObjectId;
  roleId: Types.ObjectId;
  invitedBy: Types.ObjectId;
  invitedUserId: Types.ObjectId;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  token?: string; // Optional: for non-user email invites (future)
  createdAt?: Date;
  updatedAt?: Date;
}

const ProjectInviteSchema = new Schema<IProjectInvite>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  roleId: { type: Schema.Types.ObjectId, required: true }, // References Project.roles sub-doc _id
  invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  invitedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'expired'], default: 'pending' },
}, { timestamps: true });

export const ProjectInviteModel = model<IProjectInvite>('ProjectInvite', ProjectInviteSchema);


// --- Application Model (Used for tracking user-initiated applications to open roles) ---
export interface IProjectApplication {
  _id?: Types.ObjectId;
  projectId: Types.ObjectId;
  roleId: Types.ObjectId;
  applicantId: Types.ObjectId;
  message?: string;
  proposedRate?: number; // Cents
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn';
  createdAt?: Date;
  updatedAt?: Date;
}

const ProjectApplicationSchema = new Schema<IProjectApplication>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  roleId: { type: Schema.Types.ObjectId, required: true },
  applicantId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  message: { type: String, maxlength: 1000 },
  proposedRate: { type: Number },
  status: { type: String, enum: ['pending', 'accepted', 'rejected', 'withdrawn'], default: 'pending' },
}, { timestamps: true });

// Ensure a user can only have one application per role per project
ProjectApplicationSchema.index({ projectId: 1, roleId: 1, applicantId: 1 }, { unique: true });

export const ProjectApplicationModel = model<IProjectApplication>('ProjectApplication', ProjectApplicationSchema);
```

#### **13.2. `src/services/project.service.ts` (Updates)**

```typescript
// src/services/project.service.ts (partial update)
// ... (Imports from Task 12, ProjectModel) ...

import { ProjectInviteModel, ProjectApplicationModel, IProjectApplication } from '../models/projectApplication.model';
import { Types } from 'mongoose';

// Mock Notification Service for dependency fulfillment
class MockNotificationService {
    public async sendInvite(projectId: string, userId: string, roleTitle: string): Promise<void> {
        console.log(`[Notification Mock] Sent Project ${projectId} invite to User ${userId} for role ${roleTitle}`);
    }
    public async notifyOwnerOfApplication(projectId: string, applicantId: string): Promise<void> {
        console.log(`[Notification Mock] Notified Owner of Project ${projectId} about application from User ${applicantId}`);
    }
}
const notificationService = new MockNotificationService();

export class ProjectService {
    // ... (createProject method) ...

    /** Checks if the requester is the project owner. @throws {Error} 'PermissionDenied' | 'ProjectNotFound' */
    private async checkOwnerAccess(projectId: string, requesterId: string): Promise<IProject> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) {
            throw new Error('ProjectNotFound');
        }
        if (project.ownerId.toString() !== requesterId) {
            throw new Error('PermissionDenied');
        }
        return project;
    }


    /**
     * Invites a user to a specific role.
     * @throws {Error} - 'ProjectNotFound', 'PermissionDenied', 'RoleNotFound', 'RoleFull'.
     */
    public async inviteUser(projectId: string, requesterId: string, targetUserId: string, roleId: string, message: string): Promise<IProjectInvite> {
        const project = await this.checkOwnerAccess(projectId, requesterId);
        const roleObjectId = new Types.ObjectId(roleId);
        const targetObjectId = new Types.ObjectId(targetUserId);

        // 1. Validate role and capacity
        const role = project.roles.find(r => r._id?.equals(roleObjectId));
        if (!role) { throw new Error('RoleNotFound'); }
        if (role.assignedUserIds.length >= role.slots) { throw new Error('RoleFull'); }
        
        // 2. Create Invite Record
        const newInvite = new ProjectInviteModel({
            projectId: project._id,
            roleId: roleObjectId,
            invitedBy: new Types.ObjectId(requesterId),
            invitedUserId: targetObjectId,
        });
        const savedInvite = await newInvite.save();

        // 3. Trigger Notifications (Mocked)
        await notificationService.sendInvite(projectId, targetUserId, role.title);
        
        // PRODUCTION: Emit 'project.invite.sent' event
        
        return savedInvite.toObject();
    }


    /**
     * User applies for a role in an Open project.
     * @throws {Error} - 'ProjectNotFound', 'ProjectNotOpen', 'RoleNotFound', 'AlreadyApplied'.
     */
    public async applyForRole(projectId: string, applicantId: string, roleId: string, message?: string, proposedRate?: number): Promise<IProjectApplication> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        const roleObjectId = new Types.ObjectId(roleId);
        const applicantObjectId = new Types.ObjectId(applicantId);

        if (!project) { throw new Error('ProjectNotFound'); }
        if (project.collaborationType !== 'open') { throw new Error('ProjectNotOpen'); }
        const role = project.roles.find(r => r._id?.equals(roleObjectId));
        if (!role) { throw new Error('RoleNotFound'); }

        // 1. Check if application already exists (handled by unique index/DB check)
        
        // 2. Create Application Record
        const newApplication = new ProjectApplicationModel({
            projectId: project._id,
            roleId: roleObjectId,
            applicantId: applicantObjectId,
            message,
            proposedRate,
        });
        const savedApplication = await newApplication.save();

        // 3. Trigger Notifications (Mocked)
        await notificationService.notifyOwnerOfApplication(projectId, applicantId);
        
        // PRODUCTION: Emit 'project.application.submitted' event
        
        return savedApplication.toObject();
    }


    /**
     * Assigns a user to a specific role, consuming a slot.
     * @throws {Error} - 'ProjectNotFound', 'PermissionDenied', 'RoleNotFound', 'RoleFull', 'AlreadyAssigned'.
     */
    public async assignRole(projectId: string, requesterId: string, targetUserId: string, roleId: string): Promise<IProject> {
        const project = await this.checkOwnerAccess(projectId, requesterId);
        const roleObjectId = new Types.ObjectId(roleId);
        const targetObjectId = new Types.ObjectId(targetUserId);

        const role = project.roles.find(r => r._id?.equals(roleObjectId));
        if (!role) { throw new Error('RoleNotFound'); }
        
        // 1. Capacity and Conflict Checks
        if (role.assignedUserIds.length >= role.slots) { throw new Error('RoleFull'); }
        if (role.assignedUserIds.some(id => id.equals(targetObjectId))) { throw new Error('AlreadyAssigned'); }
        
        // 2. Perform Atomic Update: Push to embedded role array and denormalized teamMemberIds
        const updatedProject = await ProjectModel.findOneAndUpdate(
            { _id: project._id, 'roles._id': roleObjectId },
            { 
                $push: { 
                    'roles.$.assignedUserIds': targetObjectId 
                },
                $addToSet: { // Add to denormalized list only if not already present
                    teamMemberIds: targetObjectId, 
                } 
            },
            { new: true }
        );

        if (!updatedProject) { throw new Error('ProjectNotFound'); } // Should not happen

        // PRODUCTION: Emit 'project.role.assigned' event (Tasks 16, 17 subscribe)
        console.log(`[Event] User ${targetUserId} assigned to role ${role.title} in Project ${projectId}.`);

        return updatedProject.toObject() as IProject;
    }
}
```

#### **13.3. `src/controllers/project.controller.ts` (Updates)**

```typescript
// src/controllers/project.controller.ts (partial update)
// ... (Imports, projectService initialization, createProjectController) ...

import { param, body, validationResult } from 'express-validator';
import { Types } from 'mongoose';

// --- Validation Middleware ---

export const projectAndRoleParamValidation = [
    param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
    param('roleId').isMongoId().withMessage('Invalid Role ID format.').bail(),
];

export const inviteValidation = [
    ...projectAndRoleParamValidation,
    body('userId').isMongoId().withMessage('Target User ID is required and must be valid Mongo ID.'),
    body('message').optional().isString().isLength({ max: 500 }),
];

export const applyValidation = [
    ...projectAndRoleParamValidation,
    body('message').optional().isString().isLength({ max: 1000 }),
    body('proposedRate').optional().isInt({ min: 0 }).toInt(),
];

export const assignValidation = [
    ...projectAndRoleParamValidation,
    body('userId').isMongoId().withMessage('Target User ID is required and must be valid Mongo ID.'),
];


// --- Member Management Controllers ---

/** Handles owner inviting a user. POST /projects/:id/invite */
export const inviteUserController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { projectId, roleId } = req.params;
        const { userId: targetUserId, message } = req.body;
        const requesterId = req.user!.sub;

        const invite = await projectService.inviteUser(projectId, requesterId, targetUserId, roleId, message);

        return res.status(201).json({
            inviteId: invite._id!.toString(),
            projectId,
            roleId,
            status: invite.status,
            invitedUserId: invite.invitedUserId.toString(),
            message: 'Invitation sent.',
        });
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner can send invitations.' } }); }
        if (error.message === 'RoleNotFound') { return res.status(404).json({ error: { code: 'role_not_found', message: 'The specified role does not exist in this project.' } }); }
        if (error.message === 'RoleFull') { return res.status(409).json({ error: { code: 'role_full', message: 'The specified role has no available slots.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during invite.' } });
    }
};

/** Handles user applying for a role. POST /projects/:id/apply */
export const applyForRoleController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }

    try {
        const { projectId, roleId } = req.params;
        const applicantId = req.user!.sub;

        const application = await projectService.applyForRole(projectId, applicantId, roleId, req.body.message, req.body.proposedRate);

        return res.status(201).json({
            applicationId: application._id!.toString(),
            projectId,
            roleId,
            applicantId,
            status: application.status,
            appliedAt: application.createdAt!.toISOString(),
        });
    } catch (error: any) {
        if (error.message === 'ProjectNotOpen') { return res.status(403).json({ error: { code: 'project_private', message: 'This project does not accept open applications.' } }); }
        if (error.message === 'RoleNotFound') { return res.status(404).json({ error: { code: 'role_not_found', message: 'The specified role does not exist in this project.' } }); }
        if (error.code === 11000) { return res.status(409).json({ error: { code: 'already_applied', message: 'You have already applied for this role.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during application.' } });
    }
};

/** Handles owner assigning an applicant/invitee to a role. POST /projects/:id/roles/:roleId/assign */
export const assignRoleController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }

    try {
        const { projectId, roleId } = req.params;
        const { userId: targetUserId } = req.body;
        const requesterId = req.user!.sub;

        // Service handles capacity check and atomic DB update
        const updatedProject = await projectService.assignRole(projectId, requesterId, targetUserId, roleId);
        const assignedRole = updatedProject.roles.find(r => r._id?.toString() === roleId);

        return res.status(200).json({
            roleId,
            assignedUserIds: assignedRole?.assignedUserIds.map(id => id.toString()),
            message: `User ${targetUserId} successfully assigned to role.`,
        });

    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner can assign roles.' } }); }
        if (error.message === 'RoleFull') { return res.status(409).json({ error: { code: 'role_full', message: 'Cannot assign; the role slots are full.' } }); }
        if (error.message === 'AlreadyAssigned') { return res.status(409).json({ error: { code: 'already_assigned', message: 'User is already assigned to this role.' } }); }
        if (error.message === 'RoleNotFound') { return res.status(404).json({ error: { code: 'role_not_found', message: 'The specified role does not exist.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during role assignment.' } });
    }
};
```

#### **13.4. `src/routes/project.routes.ts` (Updates)**

```typescript
// src/routes/project.routes.ts (partial update)
import { Router } from 'express';
// ... (Task 12 Imports) ...
import { 
    inviteUserController, inviteValidation, 
    applyForRoleController, applyValidation, 
    assignRoleController, assignValidation 
} from '../controllers/project.controller';

const router = Router();

// Define reusable middleware chain for Project Owner/Admin access
const ownerAccess = [PERMISSIONS.PROJECT_CREATE]; // Generic permission to mutate project state

// --- Project Creation (Task 12) ---
// POST /projects ...

// --- Member Management Endpoints (Task 13) ---

// POST /projects/:projectId/invite - Invite user to role (Owner only)
router.post(
    '/:projectId/invite',
    authenticate,
    authorize(ownerAccess), 
    inviteValidation,
    inviteUserController
);

// POST /projects/:projectId/apply - Apply for open role (Creator/User)
router.post(
    '/:projectId/apply',
    authenticate,
    applyValidation,
    // RBAC: Requires Auth, access check is done in the service based on project.collaborationType
    applyForRoleController 
);

// POST /projects/:projectId/roles/:roleId/assign - Assign user to role (Owner only)
router.post(
    '/:projectId/roles/:roleId/assign',
    authenticate,
    authorize(ownerAccess),
    assignValidation,
    assignRoleController
);


// ... (Future Task 14/15 endpoints go here) ...

export default router;
```

#### **13.5. Test Specification**

| Test ID | Endpoint | Description | Role/Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T13.1** | `POST /:id/invite` | Happy Path | Project Owner | **201 Created** | N/A |
| **T13.2** | `POST /:id/invite` | Fail: Not Owner | Authenticated Creator | **403 Forbidden** | `not_owner` |
| **T13.3** | `POST /:id/apply` | Happy Path: Open Project | Authenticated Creator | **201 Created** | N/A |
| **T13.4** | `POST /:id/apply` | Fail: Invite-Only Project | Authenticated Creator | **403 Forbidden** | `project_private` |
| **T13.5** | `POST /:id/roles/:roleId/assign` | Happy Path: Assign User | Project Owner | **200 OK** | N/A |
| **T13.6** | `POST /:id/roles/:roleId/assign` | Fail: Role Slots Full | Project Owner | **409 Conflict** | `role_full` |
| **T13.7** | `POST /:id/roles/:roleId/assign` | Fail: Role Not Found | Project Owner | **404 Not Found** | `role_not_found` |

---
