Following the project plan, we proceed with **Task 16: Project Search Index Hook & List**.

This task is the final step in connecting the Project Management domain to the search infrastructure, completing the core data flow for project discovery. We will implement the event emission hooks on project mutations and create the dedicated public listing endpoint.

***

## **Task 16: Project Search Index Hook & List**

**Goal:** Implement the event emission hooks (`project.created`, `project.updated`, `project.archived`) in the `ProjectService` and expose the final public-facing project listing endpoint (`GET /market/projects`) which utilizes the Search/Discovery service logic.

**Service:** `Project Management Service` & `Marketplace / Discovery / Search API`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 15 (Project Model/Service), Task 10 (Discovery Service framework).

**Output Files:**
1.  `src/services/project.service.ts` (Updated: add event emissions to `createProject`, `updateProject`, `deleteProject`).
2.  `src/services/discovery.service.ts` (Updated: `searchProjects` method).
3.  `src/controllers/discovery.controller.ts` (Updated: `searchProjectsController`).
4.  `src/routes/discovery.routes.ts` (New file: dedicated router for Marketplace/Search).
5.  `test/integration/project_index.test.ts` (Test specification).

**Input/Output Shapes:**

| Endpoint | Request (Query Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /market/projects** | `q?: string, category?, sort?, page?, per_page?` | `ProjectsListResponse` (Paginated, Public Projects) | Public |
| **Internal Event** | `project.updated` event payload | N/A | Service-to-Service |

**ProjectsListResponse (Excerpt):**
```json
{
  "meta": { "total": 45 },
  "data": [
    { "projectId": "proj_123", "title": "Echoes", "category": "AI Short Film", "ownerId": "user_id" }
  ]
}
```

**Runtime & Env Constraints:**
*   Event emission must be mocked (e.g., console log or simple queue mock) to represent calls to the Jobs Service (Task 52) or a dedicated message broker for indexing.
*   The `GET /market/projects` must be strictly limited to projects with `visibility: 'public'` and `status: 'active'` or `completed`.

**Acceptance Criteria:**
*   `createProject` and `updateProject` must emit the corresponding events with the project ID and any indexing metadata.
*   The deletion/archiving flow (simulated here with a service method) must emit a `project.archived` event.
*   `GET /market/projects` returns only projects marked as public and in an active/completed state.
*   The search implementation in `discovery.service.ts` correctly applies public visibility filters.

**Tests to Generate:**
*   **Unit Test (Events):** Mock the event emitter and verify that the correct events are triggered upon project mutations.
*   **Integration Test (Public Filter):** Query the endpoint and verify that private/draft projects are excluded from the results.

***

### **Task 16 Code Implementation**

#### **16.1. `src/services/project.service.ts` (Updates - Events)**

```typescript
// src/services/project.service.ts (partial update)
// ... (All previous imports and methods) ...

// Mock Event Emitter for Publishing Indexing Events
class MockEventEmitter {
    public emit(event: string, payload: any): void {
        console.log(`[EVENT EMITTED] ${event}:`, JSON.stringify(payload));
        // PRODUCTION: This payload would be sent to a Message Broker (Kafka/RabbitMQ)
    }
}
const eventEmitter = new MockEventEmitter();


export class ProjectService {
    // ... (createProject method)
    public async createProject(ownerId: string, data: ICreateProjectRequestDTO): Promise<IProject> {
        // ... (1. Create DTO and 2. Save) ...
        const savedProject = await newProject.save();
        // ... (3. Handle Initial Assignment) ...

        // 4. Trigger Events for Indexing (New)
        eventEmitter.emit('project.created', {
            projectId: savedProject._id!.toString(),
            ownerId: ownerId,
            visibility: savedProject.visibility,
            title: savedProject.title,
        });

        return savedProject.toObject() as IProject;
    }


    // ... (getProjectDetails and listProjects methods) ...

    /** Updates the main project document. */
    public async updateProject(projectId: string, requesterId: string, updateData: any): Promise<any> {
        // ... (1. Owner Access Check and 2. Build Update Object) ...
        const update: any = {};
        if (updateData.title !== undefined) update.title = updateData.title;
        if (updateData.description !== undefined) update.description = updateData.description;
        if (updateData.visibility !== undefined) update.visibility = updateData.visibility;
        if (updateData.status !== undefined) update.status = updateData.status;

        // 3. Execute Update
        const updatedProject = await ProjectModel.findOneAndUpdate(
            { _id: projectId },
            { $set: update },
            { new: true }
        );

        if (!updatedProject) { throw new Error('UpdateFailed'); }

        // 4. Trigger Events for Indexing (Updated/Visibility Change) (New)
        eventEmitter.emit('project.updated', {
            projectId: updatedProject._id!.toString(),
            changes: Object.keys(update),
            visibility: updatedProject.visibility,
            status: updatedProject.status,
            ownerId: updatedProject.ownerId.toString(),
        });

        // 5. Return updated DTO
        return this.getProjectDetails(projectId, requesterId, updatedProject.ownerId.toString() === requesterId ? updatedProject.ownerId.toString() : 'creator');
    }
    
    /** Deletes/Archives a project. Placeholder for PUT /projects/:id with status: 'archived' */
    public async archiveProject(projectId: string, requesterId: string): Promise<void> {
        await this.checkOwnerAccess(projectId, requesterId); // Check owner

        const result = await ProjectModel.updateOne(
            { _id: new Types.ObjectId(projectId) },
            { $set: { status: 'archived', visibility: 'private' } }
        );

        if (result.modifiedCount === 0) { throw new Error('ProjectNotFound'); }
        
        // Emit archive event for index removal
        eventEmitter.emit('project.archived', { projectId });

        // PRODUCTION: Check for and handle pending escrows (Task 35)
        console.log(`[Event] Project ${projectId} archived.`);
    }
}
```

#### **16.2. `src/services/discovery.service.ts` (Updates - Project Search)**

```typescript
// src/services/discovery.service.ts (partial update)
// ... (Imports, DiscoveryService class definition, searchCreators method from Task 10) ...
import { ProjectModel, IProject } from '../models/project.model';

interface IProjectListItem {
    projectId: string;
    title: string;
    ownerId: string;
    category: string;
    status: IProject['status'];
    // ... other public fields
}

export class DiscoveryService {
    // ... (searchCreators method from Task 10) ...

    /** Searches and lists public projects with pagination and filtering. */
    public async searchProjects(queryParams: any): Promise<any> {
        const { 
            q, 
            category, 
            sort = 'newest', 
            page = 1, 
            per_page = 20 
        } = queryParams;

        // 1. Build Query and Filter (Simulation of Search Engine Query)
        const limit = parseInt(per_page.toString());
        const skip = (parseInt(page.toString()) - 1) * limit;

        const filters: any = {
            // CORE SECURITY: Only include public and active/completed projects
            visibility: 'public', 
            status: { $in: ['active', 'completed'] }
        };
        
        // Apply Filters
        if (category) filters.category = category;
        // NOTE: Full text search 'q' requires dedicated index (omitted in this DB simulation)

        // 2. Build Sort Order
        let sortOrder: any = {};
        if (sort === 'newest') sortOrder.createdAt = -1;
        // NOTE: 'relevance' sort is omitted in this DB simulation.

        // 3. Execute DB Query
        const [totalResults, projects] = await Promise.all([
            ProjectModel.countDocuments(filters),
            ProjectModel.find(filters)
                .select('title ownerId category status createdAt')
                .sort(sortOrder)
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IProject[]>,
        ]);
        
        // 4. Map to Public DTOs
        const data: IProjectListItem[] = projects.map(project => ({
            projectId: project._id!.toString(),
            title: project.title,
            ownerId: project.ownerId.toString(),
            category: project.category,
            status: project.status,
            // SECURITY: Ensure no sensitive data is exposed
        }));

        // 5. Construct Paginated Response
        return {
            meta: {
                page: parseInt(page.toString()),
                per_page: limit,
                total: totalResults,
                total_pages: Math.ceil(totalResults / limit),
            },
            data,
        };
    }
}
```

#### **16.3. `src/controllers/discovery.controller.ts` (Updates)**

```typescript
// src/controllers/discovery.controller.ts (partial update)
// ... (Imports, discoveryService initialization, searchCreatorsController from Task 10) ...

// --- Validation Middleware ---
export const searchProjectsValidation = [
    query('category').optional().isString().withMessage('Category must be a string.'),
    query('sort').optional().isIn(['newest', 'relevance', 'budget_desc']).withMessage('Invalid sort parameter.'),
    // ... (page/per_page validation reused from Task 10) ...
];

/** Handles the search and listing of public projects. GET /market/projects */
export const searchProjectsController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Query parameter validation failed.', details: errors.array() }});
    }

    try {
        // 2. Service Call
        const results = await discoveryService.searchProjects(req.query);

        // 3. Success (200 OK)
        return res.status(200).json(results);

    } catch (error: any) {
        // Fallback for unexpected errors
        return res.status(500).json({ 
            error: { 
                code: 'server_error', 
                message: 'An unexpected error occurred during project search.' 
            } 
        });
    }
};
```

#### **16.4. `src/routes/discovery.routes.ts` (New File)**

```typescript
// src/routes/discovery.routes.ts
import { Router } from 'express';
import { searchCreatorsController, searchCreatorsValidation, searchProjectsController, searchProjectsValidation } from '../controllers/discovery.controller';

const router = Router();

// --- Public Discovery Endpoints ---

// GET /market/creators - Creator Directory Listing/Search (Task 10)
router.get(
    '/creators', 
    searchCreatorsValidation, 
    searchCreatorsController
);

// GET /market/projects - Public Project Listing/Search (Task 16)
router.get(
    '/projects', 
    searchProjectsValidation, 
    searchProjectsController
);


// NOTE: All endpoints are PUBLIC as required by the spec.

export default router;
```

#### **16.5. Test Specification**

| Test ID | Endpoint | Description | Action | Expected Status | Expected Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T16.1** | `Service Call` | Event Emission: Creation | `projectService.createProject` | N/A | `project.created` event emitted with project ID. |
| **T16.2** | `Service Call` | Event Emission: Update | `projectService.updateProject` | N/A | `project.updated` event emitted with changed fields. |
| **T16.3** | `Service Call` | Event Emission: Archive | `projectService.archiveProject` | N/A | `project.archived` event emitted. |
| **T16.4** | `GET /market/projects` | Happy Path: Public Listing | `sort=newest` | **200 OK** | Only shows `visibility='public'` and `status IN ('active', 'completed')`. |
| **T16.5** | `GET /market/projects` | Security: Visibility | N/A | **200 OK** | **MUST NOT** show `status='draft'` or `visibility='private'` projects. |
| **T16.6** | `GET /market/projects` | Fail: Invalid Sort Param | `sort=invalid_param` | **422 Unprocessable** | `validation_error` |

---