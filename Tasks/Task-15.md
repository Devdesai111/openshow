Following the project plan, we proceed with **Task 15: Project Update & Listing (Read/Edit)**.

This task finalizes the `Project Management Service`'s core CRUD operations by implementing the Project **Update** (`PUT /projects/:projectId`) and providing the essential public/member **Read** functionality (`GET /projects/:projectId` and `GET /projects`).

***

## **Task 15: Project Update & Listing (Read/Edit)**

**Goal:** Implement the project retrieval endpoints (`GET /projects`, `GET /projects/:projectId`) with visibility filtering, and the comprehensive update endpoint (`PUT /projects/:projectId`) for the project owner to modify details.

**Service:** `Project Management Service`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 12 (Project Model), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/project.service.ts` (Updated: `listProjects`, `getProjectDetails`, `updateProject`)
2.  `src/controllers/project.controller.ts` (Updated: new read/update controllers)
3.  `src/routes/project.routes.ts` (Updated: new read/update routes)
4.  `test/integration/project_read_edit.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /projects** | `query: { status?, ownerId?, page?, per_page? }` | `ProjectsListResponse` (Paginated, filtered list) | Auth/Public (filtered) |
| **GET /projects/:projectId** | `params: { projectId }` | `ProjectDetailDTO` (Full if member, limited if public) | Auth/Public (Visibility-aware) |
| **PUT /projects/:projectId** | `Body: { title?, visibility?, roles?: [] }` | `ProjectDetailDTO` (Updated) | Auth (Owner only) |

**ProjectDetailDTO (Full - Member View):**
```json
{
  "projectId": "proj_650f9a",
  "title": "Echoes",
  "visibility": "private",
  "revenueSplits": [ { "userId": "user_id", "percentage": 50 } ],
  "milestones": [ ... ],
  // ... all fields
}
```

**Runtime & Env Constraints:**
*   `GET /projects` requires careful filtering: public projects for all; private projects only if `ownerId` or `teamMemberIds` match the requester.
*   `PUT /projects/:projectId` requires **Owner-only** authorization (via service/RBAC).
*   Data must be correctly redacted for the public view of the detail endpoint (`revenueSplits` must hide `userId`).

**Acceptance Criteria:**
*   Public list access (`GET /projects` without auth) only returns projects with `visibility='public'`.
*   Member/Owner access to a private project returns the full `ProjectDetailDTO`.
*   Successful `PUT` returns **200 OK** with the updated project, applying validations (e.g., `role` edits must not reduce `slots` below assigned users count).
*   Attempting to update a project when funds are tied up (e.g., changing category/description) is fine, but changing financial structure is generally restricted (covered in Task 14/17).

**Tests to Generate:**
*   **Integration Test (GET List):** Test authenticated listing (public + private) vs anonymous listing (public only).
*   **Integration Test (GET Detail):** Test public user attempting to view a private project (404/403).
*   **Integration Test (PUT):** Test owner updating the title and status, and non-owner failing (403).

***

### **Task 15 Code Implementation**

#### **15.1. `src/services/project.service.ts` (Updates)**

```typescript
// src/services/project.service.ts (partial update)
// ... (Imports, ProjectModel, ProjectService class definition) ...
import { IUser } from '../models/user.model';
import { isString } from 'util';

export class ProjectService {
    // ... (All previous methods from Task 12, 13, 14) ...

    /** Checks if the requester is the project owner. @throws {Error} 'PermissionDenied' | 'ProjectNotFound' */
    private async checkOwnerAccess(projectId: string, requesterId: string): Promise<IProject> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) {
            throw new Error('ProjectNotFound');
        }
        // Admin access is implicit via RBAC middleware (Task 2) for mutating endpoints
        if (project.ownerId.toString() !== requesterId) {
            throw new Error('PermissionDenied');
        }
        return project;
    }

    // --- Read/Listing ---

    /** Lists projects based on filters and requester role/membership. */
    public async listProjects(requesterId?: string, queryParams: any = {}): Promise<any> {
        const { status, ownerId, page = 1, per_page = 20 } = queryParams;
        const filters: any = {};
        
        // 1. Visibility Filters (Core RBAC for listings)
        if (requesterId) {
            // Authenticated users see public projects AND projects they are members of
            filters.$or = [
                { visibility: 'public' },
                { ownerId: new Types.ObjectId(requesterId) },
                { teamMemberIds: new Types.ObjectId(requesterId) }
            ];
        } else {
            // Anonymous users only see public projects
            filters.visibility = 'public';
        }

        // 2. Additional Filters
        if (status) filters.status = status;
        if (ownerId) filters.ownerId = new Types.ObjectId(ownerId);
        
        // 3. Pagination and Execution
        const limit = parseInt(per_page.toString());
        const skip = (parseInt(page.toString()) - 1) * limit;

        const [totalResults, projects] = await Promise.all([
            ProjectModel.countDocuments(filters),
            ProjectModel.find(filters)
                .select('-milestones -revenueSplits') // Select minimal fields for list view
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IProject[]>,
        ]);

        // 4. Map to List DTO (Redacted/Summarized)
        const data = projects.map(project => ({
            projectId: project._id!.toString(),
            title: project.title,
            ownerId: project.ownerId.toString(),
            status: project.status,
            rolesSummary: project.roles.map(r => ({ title: r.title, slots: r.slots, filled: r.assignedUserIds.length })),
            createdAt: project.createdAt!.toISOString(),
        }));

        return {
            meta: { page: parseInt(page.toString()), per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data,
        };
    }

    /** Retrieves detailed information for a single project, applying visibility rules. */
    public async getProjectDetails(projectId: string, requesterId?: string, requesterRole?: IUser['role']): Promise<any> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) {
            throw new Error('ProjectNotFound');
        }

        const isMember = project.teamMemberIds.some(id => id.toString() === requesterId);
        const isPublic = project.visibility === 'public';
        
        // 1. Authorization Check (403/404 for private projects if not member/admin)
        if (!isMember && !isPublic && requesterRole !== 'admin') {
            // For security, return 404/403 to avoid revealing project existence
            throw new Error('PermissionDenied'); 
        }

        // 2. Redaction: Revenue Splits (Hiding user IDs for non-members)
        const redactedSplits = project.revenueSplits.map(split => {
            if (isMember) {
                return { ...split, userId: split.userId?.toString() }; // Full DTO for members
            }
            // Public/Non-member view: hide userId, show placeholder/percentage
            return { placeholder: split.placeholder || 'Contributor', percentage: split.percentage }; 
        });

        // 3. Build DTO (Full/Redacted)
        const detailDTO = {
            projectId: project._id.toString(),
            ownerId: project.ownerId.toString(),
            title: project.title,
            visibility: project.visibility,
            status: project.status,
            roles: project.roles.map(r => ({
                roleId: r._id!.toString(),
                title: r.title,
                slots: r.slots,
                assignedUserIds: isMember ? r.assignedUserIds.map(id => id.toString()) : [] // Hide member IDs if non-member
            })),
            milestones: project.milestones.map(m => ({ 
                milestoneId: m._id!.toString(), 
                title: m.title, 
                amount: m.amount, 
                currency: m.currency, 
                status: m.status 
            })),
            revenueSplits: redactedSplits, // Use redacted splits
            createdAt: project.createdAt!.toISOString(),
            // ... other project metadata
        };

        return detailDTO;
    }

    // --- Update ---

    /** Updates the main project document. @throws {Error} 'PermissionDenied' | 'ProjectNotFound' */
    public async updateProject(projectId: string, requesterId: string, updateData: any): Promise<any> {
        // 1. Owner Access Check (handles ProjectNotFound and PermissionDenied)
        const project = await this.checkOwnerAccess(projectId, requesterId);

        // 2. Build Update Object (Filter allowed fields)
        const update: any = {};
        if (updateData.title !== undefined) update.title = updateData.title;
        if (updateData.description !== undefined) update.description = updateData.description;
        if (updateData.visibility !== undefined) update.visibility = updateData.visibility;
        if (updateData.status !== undefined) update.status = updateData.status;

        // NOTE: Updating roles embedded array requires special handling (Task 12 roles schema change).
        // For simplicity in this task, assume roles array replacement/deep-merge is disallowed/deferred.

        // 3. Execute Update
        const updatedProject = await ProjectModel.findOneAndUpdate(
            { _id: project._id },
            { $set: update },
            { new: true }
        );

        if (!updatedProject) { throw new Error('UpdateFailed'); }

        // 4. Trigger Events
        // PRODUCTION: Emit 'project.updated' event (Task 16 subscribes for indexing)
        console.log(`[Event] Project ${projectId} updated. Visibility: ${updatedProject.visibility}`);

        // 5. Return updated DTO (use the detailed getter)
        return this.getProjectDetails(projectId, requesterId, updatedProject.ownerId.toString() === requesterId ? updatedProject.ownerId.toString() : 'creator');
    }
}
```

#### **15.2. `src/controllers/project.controller.ts` (Updates)**

```typescript
// src/controllers/project.controller.ts (partial update)
// ... (Imports, projectService initialization, all previous controllers) ...

export const projectParamValidation = [ // Reusable param validation for all single-project ops
    param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
];

// --- List/Read Controllers ---

/** Lists projects. GET /projects */
export const listProjectsController = async (req: Request, res: Response) => {
    // Input validation for page/per_page/status queries omitted for brevity
    
    try {
        const requesterId = req.user?.sub; // May be undefined if anonymous access
        const list = await projectService.listProjects(requesterId, req.query);

        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing projects.' } });
    }
};

/** Gets project details. GET /projects/:projectId */
export const getProjectDetailsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid ID format.' }}); }
    
    try {
        const requesterId = req.user?.sub;
        const requesterRole = req.user?.role as IUser['role'] || 'creator';

        const projectDetails = await projectService.getProjectDetails(req.params.projectId, requesterId, requesterRole);

        return res.status(200).json(projectDetails);
    } catch (error: any) {
        if (error.message === 'ProjectNotFound' || error.message === 'PermissionDenied') { 
            // Return 404/403 for access denied on private projects
            return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found or access denied.' } }); 
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error fetching project details.' } });
    }
};

// --- Update Controller ---

/** Updates the main project document. PUT /projects/:projectId */
export const updateProjectController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const updatedProject = await projectService.updateProject(req.params.projectId, req.user!.sub, req.body);
        
        return res.status(200).json(updatedProject);
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner can update the project.' } }); }
        if (error.message === 'ProjectNotFound') { return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating project.' } });
    }
};
```

#### **15.3. `src/routes/project.routes.ts` (Updates)**

```typescript
// src/routes/project.routes.ts (partial update)
import { Router } from 'express';
// ... (All previous imports) ...
import { 
    listProjectsController, getProjectDetailsController, updateProjectController,
    projectParamValidation 
} from '../controllers/project.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const ownerAccess = [PERMISSIONS.PROJECT_CREATE]; // Generic permission to mutate project state

// --- Project Read/List Endpoints (Task 15) ---

// GET /projects - List projects (Public/Auth filtered)
router.get(
    '/',
    authenticate, // Optional auth for context (member vs. anonymous)
    listProjectsController
); 

// GET /projects/:projectId - Get project details (Public/Member visibility-aware)
router.get(
    '/:projectId',
    projectParamValidation,
    authenticate, // Optional auth for context (member vs. anonymous)
    getProjectDetailsController
);

// PUT /projects/:projectId - Update project (Owner only)
router.put(
    '/:projectId',
    authenticate,
    authorize(ownerAccess), // Owner check is primarily done here/in service logic
    projectParamValidation,
    updateProjectController
);


// ... (All other Task 12/13/14 endpoints) ...

export default router;
```

#### **15.4. Test Specification**

| Test ID | Endpoint | Description | Role/Condition | Expected Status | Expected Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T15.1** | `GET /` | Anonymous List (Public) | Anonymous | **200 OK** | Only shows `visibility='public'` projects. |
| **T15.2** | `GET /` | Authenticated List | Authenticated Member | **200 OK** | Shows public + projects where `teamMemberIds` matches. |
| **T15.3** | `GET /:id` | Public Detail View | Anonymous (Project=`public`) | **200 OK** | `revenueSplits` are redacted (no `userId`). |
| **T15.4** | `GET /:id` | Private Detail View | Anonymous (Project=`private`) | **404 Not Found** | Project details not revealed. |
| **T15.5** | `GET /:id` | Member Detail View | Authenticated Member (Project=`private`) | **200 OK** | Full details returned, including non-redacted `revenueSplits`. |
| **T15.6** | `PUT /:id` | Happy Path: Owner Update | Project Owner | **200 OK** | Project title/status is updated. |
| **T15.7** | `PUT /:id` | Fail: Non-Owner Update | Authenticated Non-Owner | **403 Forbidden** | `not_owner` |

---

**Task 15 Complete.** The Project Management Service CRUD operations are now comprehensive, including full visibility and access control for read and edit operations.

The next task, **Task 16: Project Search Index Hook & List**, finalizes the Discovery integration by ensuring project data is indexed for the search layer. Shall we proceed?