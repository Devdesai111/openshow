Following the structured plan and prioritizing the completeness of the core Collaboration service, here is the detailed implementation for **Task 18: Activity Feed (Write/Read)**.

This task finalizes the `Collaboration Workspace Service` by implementing the immutable activity log used by all other services (Projects, Payments, etc.) for auditing and historical context.

***

## **Task 18: Activity Feed (Write/Read)**

**Goal:** Implement the immutable `Activity` model and the service layer for writing activity events (`POST /projects/:id/activity`) (used by internal services) and retrieving the chronological activity feed (`GET /projects/:id/activity`) for project members.

**Service:** `Collaboration Workspace Service`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 17 (Collaboration Service, Project Membership Check), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/activity.model.ts` (New file: IActivity, ActivitySchema/Model)
2.  `src/services/collaboration.service.ts` (Updated: `logActivity`, `getActivityFeed`)
3.  `src/controllers/collaboration.controller.ts` (Updated: activity controllers)
4.  `src/routes/collaboration.routes.ts` (Updated: new protected routes)
5.  `test/integration/activity_feed.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Query) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /projects/:id/activity** | `{ type: string, summary: string, actorId?: string, payload: any }` | `{ activityId, createdAt }` | Auth (Internal/Admin/Service Token) |
| **GET /projects/:id/activity** | `query: { limit?, after? }` | `ActivityListResponse` (Paginated/Chronological) | Auth (Member only) |

**ActivityListResponse (Excerpt):**
```json
{
  "meta": { "limit": 50, "returned": 10 },
  "data": [ { "activityId": "act_001", "type": "milestone.created", "actorId": "user_1" } ]
}
```

**Runtime & Env Constraints:**
*   **Immutability:** Activity records should be treated as append-only.
*   **Security:** `POST` endpoint must be restricted to trusted internal services or admin users (high-level RBAC).
*   **Performance:** `GET` must use an efficient index on `projectId` and `createdAt`.

**Acceptance Criteria:**
*   `POST /activity` must validate the `type` and `summary` fields.
*   `POST /activity` requires `ADMIN_DASHBOARD` permission (simulating Service Token authentication for Phase 1).
*   `GET /activity` returns events sorted chronologically descending (`createdAt: -1`).
*   Both endpoints must return **403 Forbidden** if the user is not a project member (for `GET`) or not an Admin (for `POST` in this mock).

**Tests to Generate:**
*   **Integration Test (Write):** Test successful log entry by an Admin, and non-Admin failure (403).
*   **Integration Test (Read):** Test member retrieval success, non-member retrieval failure (403), and time-based sorting correctness.

***

### **Task 18 Code Implementation**

#### **18.1. `src/models/activity.model.ts` (New Model)**

```typescript
// src/models/activity.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IActivity {
  _id?: Types.ObjectId;
  activityId: string; // Unique short ID
  projectId: Types.ObjectId;
  actorId?: Types.ObjectId; // User or System actor
  type: string; // e.g., 'asset.uploaded', 'milestone.approved'
  summary: string; // Human-readable summary (e.g., "Dev Bhai approved Milestone 1")
  payload?: any; // Structured JSON for deep linking/context
  createdAt?: Date;
}

const ActivitySchema = new Schema<IActivity>({
  activityId: { type: String, required: true, unique: true, default: () => `act_${crypto.randomBytes(8).toString('hex')}` },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, required: true, index: true },
  summary: { type: String, required: true, maxlength: 500 },
  payload: { type: Schema.Types.Mixed },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } }); // Immutable, so no updatedAt

// PERFORMANCE: Primary index for chronological retrieval
ActivitySchema.index({ projectId: 1, createdAt: -1 });

export const ActivityModel = model<IActivity>('Activity', ActivitySchema);
```

#### **18.2. `src/services/collaboration.service.ts` (Updates)**

```typescript
// src/services/collaboration.service.ts (partial update)
// ... (Imports, CollaborationService class definition, checkMembership method) ...

import { ActivityModel, IActivity } from '../models/activity.model';

interface IActivityLogDTO {
    type: string;
    summary: string;
    actorId?: string;
    payload?: any;
}

export class CollaborationService {
    // ... (sendMessage, getMessages, updateMessage, deleteMessage methods from Task 17) ...

    /** Logs an immutable activity event for a project. (Internal/Service Use) */
    public async logActivity(projectId: string, actorId: string | null, data: IActivityLogDTO): Promise<IActivity> {
        // NOTE: Membership check is skipped here; assumed to be handled by the Admin/Service Auth check
        
        const newActivity = new ActivityModel({
            projectId: new Types.ObjectId(projectId),
            actorId: actorId ? new Types.ObjectId(actorId) : undefined,
            type: data.type,
            summary: data.summary,
            payload: data.payload,
        });

        const savedActivity = await newActivity.save();
        
        // PRODUCTION: Emit 'activity.created' event (Notifications Service subscribes)
        console.log(`[Event] Activity ${savedActivity.activityId} logged: ${savedActivity.type}.`);

        return savedActivity.toObject() as IActivity;
    }

    /** Retrieves the chronological activity feed for a project. */
    public async getActivityFeed(projectId: string, requesterId: string, requesterRole: IAuthUser['role'], limit: number, after?: string): Promise<any> {
        // 1. Security Check: Only members can read the feed
        await this.checkMembership(projectId, requesterId, requesterRole); 
        
        const filters: any = { projectId: new Types.ObjectId(projectId) };
        
        // Cursor-based pagination logic (if 'after' is an activityId or timestamp)
        if (after) {
            // Assume 'after' is an activityId, look up its creation date for cursor
            const afterActivity = await ActivityModel.findOne({ activityId: after }).select('createdAt');
            if (afterActivity) {
                filters.createdAt = { $lt: afterActivity.createdAt }; // Retrieve older items
            }
        }

        const activities = await ActivityModel.find(filters)
            .sort({ createdAt: -1 }) // Newest first
            .limit(limit)
            .select('-__v -_id')
            .lean() as IActivity[];

        // Map to DTO (convert IDs to strings)
        const data = activities.map(act => ({
            ...act,
            actorId: act.actorId?.toString(),
            createdAt: act.createdAt!.toISOString(),
        }));

        return { data, meta: { limit, returned: data.length, after } };
    }
}
```

#### **18.3. `src/controllers/collaboration.controller.ts` (Updates)**

```typescript
// src/controllers/collaboration.controller.ts (partial update)
// ... (Imports, collaborationService initialization, Task 17 controllers) ...

// --- Validation Middleware ---

export const logActivityValidation = [
    body('type').isString().isLength({ min: 5 }).withMessage('Activity type is required.'),
    body('summary').isString().isLength({ min: 5, max: 500 }).withMessage('Activity summary is required (5-500 chars).'),
    body('actorId').optional().isMongoId().withMessage('Actor ID must be a valid Mongo ID if provided.'),
    body('payload').optional().isObject().withMessage('Payload must be a JSON object.'),
];

export const getActivityValidation = [
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Limit must be between 1 and 100.'),
    query('after').optional().isString().withMessage('After must be a valid activity ID cursor.'),
];


// --- Activity Controllers ---

/** Logs an immutable activity event. POST /projects/:id/activity */
export const logActivityController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { projectId } = req.params;
        
        // NOTE: Requester is an Admin/Service account for this internal endpoint
        const actorId = req.user?.sub || req.body.actorId; 

        // 2. Service Call
        const savedActivity = await collaborationService.logActivity(projectId, actorId, req.body);

        // 3. Success (201 Created)
        return res.status(201).json({
            activityId: savedActivity.activityId,
            type: savedActivity.type,
            createdAt: savedActivity.createdAt!.toISOString(),
        });

    } catch (error: any) {
        if (error.message === 'ProjectNotFound') { return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error logging activity.' } });
    }
};

/** Retrieves the activity feed. GET /projects/:id/activity */
export const getActivityFeedController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { projectId } = req.params;
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
        const after = req.query.after as string | undefined;

        const result = await collaborationService.getActivityFeed(projectId, req.user!.sub, req.user!.role, limit, after);

        return res.status(200).json(result);
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_member', message: 'You must be a project member to view the activity feed.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving activity feed.' } });
    }
};
```

#### **18.4. `src/routes/collaboration.routes.ts` (Updates)**

```typescript
// src/routes/collaboration.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 17) ...
import { 
    logActivityController, getActivityFeedController, 
    logActivityValidation, getActivityValidation 
} from '../controllers/collaboration.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';
import { param } from 'express-validator';

const router = Router();
const projectIdValidation = [param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail()];


// --- Activity Feed Endpoints (Task 18) ---

// POST /projects/:projectId/activity - Log new activity event (Internal/Admin only)
router.post(
    '/:projectId/activity',
    authenticate,
    authorize([PERMISSIONS.ADMIN_DASHBOARD]), // Simulating Internal Service Token access
    projectIdValidation,
    logActivityValidation,
    logActivityController
);

// GET /projects/:projectId/activity - Retrieve activity feed (Member only)
router.get(
    '/:projectId/activity',
    authenticate,
    projectIdValidation,
    getActivityValidation,
    // NOTE: Membership check is handled in the service for granular control
    getActivityFeedController
);

// ... (All other Task 17 message endpoints) ...

export default router;
```

#### **18.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T18.1** | `POST /:id/activity` | Happy Path: Log Event | Admin/Service Token | **201 Created** | N/A |
| **T18.2** | `POST /:id/activity` | Fail: Non-Admin Access | Authenticated Member | **403 Forbidden** | `permission_denied` |
| **T18.3** | `POST /:id/activity` | Fail: Validation Missing Summary | Admin/Service Token | **422 Unprocessable** | `validation_error` |
| **T18.4** | `GET /:id/activity` | Happy Path: Member Read | Authenticated Member | **200 OK** | Returns activities descending by `createdAt`. |
| **T18.5** | `GET /:id/activity` | Fail: Non-Member Read | Authenticated Non-Member | **403 Forbidden** | `not_member` |
| **T18.6** | `GET /:id/activity` | Cursor Check | Member, `query: { after: 'act_xyz' }` | **200 OK** | Returns activities logged before the cursor item. |

---

