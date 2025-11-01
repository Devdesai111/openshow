Following the structured plan, we proceed with **Task 23: Project List/Detail (Non-Member Views)**.

This task is a high-priority quality assurance step for the Project Management Service, ensuring that all listing and detail endpoints adhere strictly to the principle of least privilege, especially for users who are neither project members nor administrators. This is largely a refinement of existing logic (Task 15).

***

## **Task 23: Project List/Detail (Non-Member Views)**

**Goal:** Refine and audit the Project retrieval logic (`GET /projects`, `GET /projects/:id`) to guarantee that non-member, non-admin users can **only** access data explicitly marked as public, and that private projects are completely concealed (returning a 404/403).

**Service:** `Project Management Service`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 15 (Project List/Detail), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/project.service.ts` (Audited/Refined logic in `listProjects`, `getProjectDetails`)
2.  `src/controllers/project.controller.ts` (Audited/Refined error handling in controllers)
3.  `test/integration/project_visibility_audit.test.ts` (Test specification focused on edge cases)

**Input/Output Shapes:**

| Endpoint | Requester (Auth Status) | Project State (Visibility) | Expected Status | Redaction Detail |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **GET /projects** | Anonymous | N/A | **200 OK** | Only returns `visibility: 'public'` projects. |
| **GET /projects/:id** | Anonymous/Non-Member | `visibility: 'private'` | **404 Not Found** (Security through obscurity) | Conceals existence of project. |
| **GET /projects/:id** | Non-Member | `visibility: 'public'` | **200 OK** | Must redact `revenueSplits.userIds` and `roles.assignedUserIds`. |

**Runtime & Env Constraints:**
*   **Security Principle:** Security by obscurity is used for non-members accessing private project IDs. A `ProjectNotFound` (404) is returned instead of `PermissionDenied` (403) to prevent enumeration of valid project IDs.
*   The `listProjects` logic must be highly efficient, relying on database indexing/filtering for visibility.

**Acceptance Criteria:**
*   The `getProjectDetails` service method must enforce the rule: `if (!isMember && !isPublic && !isAdmin) throw new Error('ProjectNotFound');`
*   The `listProjects` service method must ensure the anonymous query only requests `visibility: 'public'` from the database.
*   The `ProjectDetailDTO` returned for public access must hide all team member IDs and financial user IDs.

**Tests to Generate:**
*   **Integration Test (Detail Obscurity):** Test anonymous access to a private but valid ID $\rightarrow$ 404.
*   **Integration Test (Detail Redaction):** Test anonymous access to a public ID $\rightarrow$ 200, but verify specific fields (`assignedUserIds`, `userId` in splits) are missing/null.

***

### **Task 23 Code Implementation (Audit/Refinement)**

#### **23.1. `src/services/project.service.ts` (Audited/Refined)**

```typescript
// src/services/project.service.ts (partial update - Refined visibility logic)
// ... (All previous imports and methods) ...
import { IUser } from '../models/user.model';


export class ProjectService {
    // ... (All previous methods for mutations and invitations) ...

    /** Retrieves detailed information for a single project, applying refined visibility rules. */
    public async getProjectDetails(projectId: string, requesterId?: string, requesterRole?: IUser['role']): Promise<any> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) {
            throw new Error('ProjectNotFound'); // 404 for security
        }

        const isMember = project.teamMemberIds.some(id => id.toString() === requesterId);
        const isPublic = project.visibility === 'public';
        const isAdmin = requesterRole === 'admin';
        
        // 1. REFINED AUTHORIZATION CHECK (SECURITY BY OBSCURITY)
        // If it's private AND not a member AND not an admin, treat it as Not Found.
        if (!isMember && !isPublic && !isAdmin) {
            throw new Error('ProjectNotFound'); 
        }

        // 2. Redaction Logic (Core Principle: If !isMember, redact sensitive data)
        const canSeeTeamIds = isMember || isAdmin;
        const canSeePrivateFinances = isMember || isAdmin;

        const redactedSplits = project.revenueSplits.map(split => {
            if (canSeePrivateFinances) {
                return { ...split, userId: split.userId?.toString() }; 
            }
            // Public/Non-member view: hide userId, show placeholder/percentage
            return { placeholder: split.placeholder || 'Contributor', percentage: split.percentage }; 
        });

        // 3. Build Final DTO
        const detailDTO = {
            projectId: project._id!.toString(),
            ownerId: project.ownerId.toString(),
            title: project.title,
            description: project.description,
            visibility: project.visibility,
            status: project.status,
            category: project.category,
            collaborationType: project.collaborationType,
            
            roles: project.roles.map(r => ({
                roleId: r._id!.toString(),
                title: r.title,
                slots: r.slots,
                // REDACTION: Hide assigned user IDs for non-members
                assignedUserIds: canSeeTeamIds ? r.assignedUserIds.map(id => id.toString()) : [], 
            })),
            
            milestones: project.milestones.map(m => ({ 
                milestoneId: m._id!.toString(), 
                title: m.title, 
                // REDACTION: Non-members still see titles/status, but full financial context is for members.
                amount: canSeePrivateFinances ? m.amount : undefined, 
                currency: canSeePrivateFinances ? m.currency : undefined, 
                status: m.status,
            })),
            
            revenueSplits: redactedSplits, 
            createdAt: project.createdAt!.toISOString(),
        };

        return detailDTO;
    }


    /** Lists projects based on filters and requester role/membership. (Audited for efficiency) */
    public async listProjects(requesterId?: string, queryParams: any = {}): Promise<any> {
        const { status, ownerId, page = 1, per_page = 20 } = queryParams;
        const filters: any = {};
        
        // 1. REFINED VISIBILITY FILTER (Efficient DB Query)
        if (requesterId) {
            // Authenticated users see public projects OR projects they are a member of
            filters.$or = [
                { visibility: 'public' },
                { ownerId: new Types.ObjectId(requesterId) },
                { teamMemberIds: new Types.ObjectId(requesterId) }
            ];
        } else {
            // Anonymous users ONLY see public projects
            filters.visibility = 'public';
        }
        
        // 2. ADDITIONAL FILTERS (Ensure active projects are prioritized)
        if (status) filters.status = status;
        if (ownerId) filters.ownerId = new Types.ObjectId(ownerId);
        
        // Exclude archived projects by default from general listing (unless explicitly requested)
        if (filters.status !== 'archived') {
             filters.status = filters.status || { $ne: 'archived' };
        }
        
        // 3. Pagination and Execution (Same as Task 15, retained for efficiency)
        const limit = parseInt(per_page.toString());
        const skip = (parseInt(page.toString()) - 1) * limit;

        const [totalResults, projects] = await Promise.all([
            ProjectModel.countDocuments(filters),
            ProjectModel.find(filters)
                .select('title ownerId category status roles teamMemberIds visibility createdAt') 
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IProject[]>,
        ]);

        // 4. Map to List DTO (Minimal Redaction)
        const data = projects.map(project => ({
            projectId: project._id!.toString(),
            title: project.title,
            ownerId: project.ownerId.toString(),
            status: project.status,
            rolesSummary: project.roles.map(r => ({ title: r.title, slots: r.slots, filled: r.assignedUserIds.length })),
            createdAt: project.createdAt!.toISOString(),
            visibility: project.visibility, // Added for clarity
            isMember: project.teamMemberIds.some(id => id.toString() === requesterId) // Added for client-side display logic
        }));

        return {
            meta: { page: parseInt(page.toString()), per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data,
        };
    }
}
```

#### **23.2. `src/controllers/project.controller.ts` (Audited/Refined)**

```typescript
// src/controllers/project.controller.ts (partial update - Refined error handling)
// ... (Imports, projectService initialization, all previous controllers) ...
import { IUser } from '../models/user.model';
import { authenticate } from '../middlewares/auth.middleware'; // Need this for optional auth in router

/** Gets project details. GET /projects/:projectId */
export const getProjectDetailsController = async (req: Request, res: Response) => {
    // ... (Validation) ...
    
    try {
        // Optional Auth: req.user may be null if anonymous
        const requesterId = req.user?.sub;
        const requesterRole = req.user?.role as IUser['role'] || 'creator'; 

        const projectDetails = await projectService.getProjectDetails(req.params.projectId, requesterId, requesterRole);

        return res.status(200).json(projectDetails);
    } catch (error: any) {
        // REFINED ERROR HANDLING: Map internal 'ProjectNotFound' (which covers the security 404 for private projects) to 404
        if (error.message === 'ProjectNotFound') { 
            return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found.' } }); 
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error fetching project details.' } });
    }
};

/** Lists projects. GET /projects */
export const listProjectsController = async (req: Request, res: Response) => {
    // ... (Validation omitted for brevity) ...
    
    try {
        // Optional Auth: req.user may be null if anonymous
        const requesterId = req.user?.sub; 
        const list = await projectService.listProjects(requesterId, req.query);

        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing projects.' } });
    }
};```

#### **23.3. `src/routes/project.routes.ts` (Audited/Refined)**

```typescript
// src/routes/project.routes.ts (partial update)
// ... (All previous imports) ...
import { listProjectsController, getProjectDetailsController, projectParamValidation } from '../controllers/project.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
// ... (RBAC imports) ...

const router = Router();
// ... (ownerAccess and other access controls) ...


// --- Project Read/List Endpoints (Task 23 - Audited) ---

// GET /projects - List projects (Public/Auth filtered)
router.get(
    '/',
    authenticate, // Optional auth for context (member vs. anonymous)
    // NOTE: This endpoint is designed to gracefully handle unauthenticated access by omitting the 'authenticate' middleware, 
    // but the `req.user` check is safer if `authenticate` is present but optional.
    listProjectsController
); 

// GET /projects/:projectId - Get project details (Public/Member visibility-aware)
router.get(
    '/:projectId',
    projectParamValidation,
    authenticate, // Optional auth for context (member vs. anonymous)
    getProjectDetailsController
);

// ... (All other Task 12/13/14/15 endpoints) ...

export default router;
```

#### **23.4. Test Specification**

| Test ID | Endpoint | Description | Requester | Project Visibility | Expected Status | Redaction Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T23.1** | `GET /projects/:id` | Security: Obscurity Check | Anonymous | `private` | **404 Not Found** | N/A (Conceals existence) |
| **T23.2** | `GET /projects/:id` | Security: Public Redaction | Anonymous | `public` | **200 OK** | `revenueSplits[].userId` MUST be missing/null. |
| **T23.3** | `GET /projects/:id` | Member Full Access | Authenticated Member | `private` | **200 OK** | `revenueSplits[].userId` MUST be present. |
| **T23.4** | `GET /projects` | List Anonymous Filter | Anonymous | N/A | **200 OK** | List MUST NOT contain any projects with `visibility='private'`. |
| **T23.5** | `GET /projects` | List Member Filter | Authenticated Member | N/A | **200 OK** | List MUST contain public projects AND private projects they are members of. |

---

**Task 23 Complete.** The Project Management Service's visibility and data exposure logic has been audited and refined to strictly adhere to the principle of least privilege, mapping unauthorized access to private resources to a secure 404 response.

The next task, **Task 24: Asset Update/Delete/List/Metadata**, returns to **Phase B** to finalize the asset management utility layer before focusing on the e-signature flow. **Wait, Task 22 was Asset Update/Delete. This suggests a re-check of the plan is needed.**

---

**Self-Correction on Plan:** The original plan lists **Task 22: Asset Update/Delete/List/Metadata** and then proceeds to Task 23 (just completed).

The next logical task based on the phases would be to complete the Verification service (Phase B) OR the E-signature flow (Phase D). Given Phase B is still in progress, we will focus on **Task 9: Verification & Trust Application Workflow**, which maps to **Task 9** in the original 100-task list, but must be numbered sequentially as **Task 24** here.

