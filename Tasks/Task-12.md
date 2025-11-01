Following the plan, we proceed with **Task 12: Project Management Core Domain**.

This task establishes the central data structure for the Project domain, implementing the project creation wizard flow and core domain logic, which is critical for all collaboration and financial features.

***

## **Task 12: Project Management Core Domain**

**Goal:** Implement the primary Project Model (`IProject`) with embedded role, revenue split, and milestone sub-documents, and expose the project creation endpoint (`POST /projects`) that accepts the consolidated 6-step wizard payload.

**Service:** `Project Management Service`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 1 (User Model, ID types), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/project.model.ts` (IProject and all nested schemas)
2.  `src/services/project.service.ts` (New file: `createProject`)
3.  `src/controllers/project.controller.ts` (New file: `createProjectController`)
4.  `src/routes/project.routes.ts` (New file: router for `/projects`)
5.  `test/integration/project_create.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (201 Created) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /projects** | `CreateProjectRequest` (6-step wizard payload) | `{ projectId: string, ownerId: string, status: 'draft', createdAt: string }` | Auth (`PROJECT_CREATE` Perm) |

**CreateProjectRequest (Excerpt):**
```json
{
  "title": "Echoes — AI Short Film",
  "category": "AI Short Film",
  "roles": [ { "title": "Prompt Engineer", "slots": 2 } ],
  "revenueModel": {
    "splits": [ { "placeholder": "Director", "percentage": 50 } ]
  },
  "collaborationType": "invite"
}
```

**Runtime & Env Constraints:**
*   Mongoose sub-documents must be correctly defined to capture `roles`, `revenueSplits`, and `milestones`.
*   Validation must enforce business logic, especially that **percentages in `revenueSplits` sum to 100** if provided.

**Acceptance Criteria:**
*   Successful creation returns **201 Created**.
*   The system assigns the authenticated user as the project `ownerId`.
*   A `revenueSplits` array with percentages must fail validation if the total sum $\neq 100$ (returns **422 Unprocessable**).
*   The embedded sub-documents (roles, splits, milestones) must be created with Mongoose-generated `_id` fields for reference in later tasks.

**Tests to Generate:**
*   **Integration Test (Happy Path):** Test successful project creation with all required fields.
*   **Integration Test (Validation):** Test failure cases for missing title and incorrect revenue split sums (e.g., 90% total).

**Non-Goals / Out-of-Scope (for Task 12):**
*   Project editing/updating (Task 15).
*   Milestone update/approval flows (Task 14).
*   Full Project Listing (Task 16).

***

### **Task 12 Code Implementation**

#### **12.1. `src/models/project.model.ts`**

```typescript
// src/models/project.model.ts
import { Schema, model, Types } from 'mongoose';
import { ValidatorError } from 'mongoose';

// --- Nested Interfaces ---

export interface IProjectRole {
  _id?: Types.ObjectId;
  title: string; // 'Prompt Engineer'
  description?: string;
  slots: number;
  assignedUserIds: Types.ObjectId[]; // Links to User
}

export interface IRevenueSplit {
  _id?: Types.ObjectId;
  userId?: Types.ObjectId; // User ID if assigned, or null if placeholder
  placeholder?: string; // e.g., 'Team Pool' or 'Director'
  percentage?: number; // 0..100
  fixedAmount?: number; // In smallest currency units (if using fixed-rate model)
  conditions?: any; // Structured or mixed JSON
}

export interface IMilestone {
  _id?: Types.ObjectId;
  title: string;
  description?: string;
  dueDate?: Date;
  amount?: number; // In smallest currency unit (cents/paise)
  currency?: string;
  escrowId?: Types.ObjectId; // Reference to Escrow (Task 8)
  status: 'pending' | 'funded' | 'completed' | 'approved' | 'disputed' | 'rejected';
}

// --- Main Project Interface ---

export interface IProject {
  _id?: Types.ObjectId;
  ownerId: Types.ObjectId;
  title: string;
  description?: string;
  category: string;
  coverAssetId?: Types.ObjectId; // Reference to Asset (Task 19)
  visibility: 'public' | 'private';
  collaborationType: 'open' | 'invite';
  roles: IProjectRole[];
  revenueSplits: IRevenueSplit[];
  milestones: IMilestone[];
  teamMemberIds: Types.ObjectId[]; // Denormalized list of all member IDs
  status: 'draft'|'active'|'paused'|'completed'|'archived';
  createdAt?: Date;
  updatedAt?: Date;
}

// --- Nested Schemas ---

const ProjectRoleSchema = new Schema<IProjectRole>({
  title: { type: String, required: true },
  slots: { type: Number, required: true, min: 1 },
  assignedUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
}, { _id: true }); // Important: sub-documents need _id for later reference/updates

const RevenueSplitSchema = new Schema<IRevenueSplit>({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  placeholder: { type: String },
  percentage: { type: Number, min: 0, max: 100 },
  fixedAmount: { type: Number, min: 0 },
  conditions: { type: Schema.Types.Mixed },
}, { _id: true });

const MilestoneSchema = new Schema<IMilestone>({
  title: { type: String, required: true },
  dueDate: { type: Date },
  amount: { type: Number, min: 0 },
  currency: { type: String, default: 'USD' },
  escrowId: { type: Schema.Types.ObjectId, ref: 'Escrow' },
  status: { type: String, enum: ['pending', 'funded', 'completed', 'approved', 'disputed', 'rejected'], default: 'pending' },
}, { _id: true, timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } });

// --- Main Schema and Custom Validation ---

const ProjectSchema = new Schema<IProject>({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, index: true, maxlength: 200 },
  description: { type: String, maxlength: 2000 },
  category: { type: String, required: true, index: true },
  visibility: { type: String, enum: ['public', 'private'], default: 'private' },
  collaborationType: { type: String, enum: ['open', 'invite'], default: 'invite' },
  roles: { type: [ProjectRoleSchema], default: [] },
  revenueSplits: { type: [RevenueSplitSchema], default: [] },
  milestones: { type: [MilestoneSchema], default: [] },
  teamMemberIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['draft', 'active', 'paused', 'completed', 'archived'], default: 'draft', index: true },
}, { timestamps: true });

/** Custom Pre-Save Hook for Business Rule Validation */
ProjectSchema.pre('save', function (next) {
    const project = this as IProject;
    
    // Validate Revenue Split Sum = 100% (only if percentages are present)
    const percentageSplits = project.revenueSplits
        .filter(split => split.percentage !== undefined && split.percentage !== null);

    if (percentageSplits.length > 0) {
        const totalPercentage = percentageSplits.reduce((sum, split) => sum + (split.percentage || 0), 0);
        if (totalPercentage !== 100) {
            // Throw a Mongoose validation error to be caught by the service layer
            const error = new ValidatorError({ message: 'Revenue splits must sum to 100%.' });
            return next(error);
        }
    }

    // Set initial team members: only owner is assigned initially
    if (project.isNew && project.teamMemberIds.length === 0) {
        project.teamMemberIds = [project.ownerId];
    }

    next();
});

export const ProjectModel = model<IProject>('Project', ProjectSchema);
```

#### **12.2. `src/services/project.service.ts` (New File)**

```typescript
// src/services/project.service.ts
import { ProjectModel, IProject, IRevenueSplit } from '../models/project.model';
import { Types } from 'mongoose';
import crypto from 'crypto';

interface ICreateProjectRequestDTO {
    title: string;
    description?: string;
    category: string;
    visibility?: IProject['visibility'];
    collaborationType?: IProject['collaborationType'];
    roles: { title: string, slots: number, requiredSkills?: string[] }[];
    revenueModel: { splits: Omit<IRevenueSplit, '_id'>[] };
    // Other fields condensed for simplicity
}

export class ProjectService {
    /**
     * Creates a new project from the 6-step wizard payload.
     * @param ownerId - The ID of the authenticated user creating the project.
     * @param data - The full project payload.
     * @returns The created project DTO.
     * @throws {Error} - 'RevenueSplitInvalid' (caught from Mongoose hook).
     */
    public async createProject(ownerId: string, data: ICreateProjectRequestDTO): Promise<IProject> {
        const ownerObjectId = new Types.ObjectId(ownerId);
        
        // 1. Map incoming DTO to Mongoose structure
        const newProject = new ProjectModel({
            ownerId: ownerObjectId,
            title: data.title,
            description: data.description,
            category: data.category,
            visibility: data.visibility || 'private',
            collaborationType: data.collaborationType || 'invite',
            status: 'draft',
            
            // Map roles, adding owner to the first role slot if defined (or creating a default owner role)
            roles: data.roles.map(role => ({
                ...role,
                _id: new Types.ObjectId(), // Manual ID for sub-doc reference
                assignedUserIds: [], // Empty initially
            })),

            // Map revenue splits
            revenueSplits: data.revenueModel.splits.map(split => ({
                ...split,
                _id: new Types.ObjectId(),
            })),
            
            // Initialize other fields
            milestones: [],
            teamMemberIds: [ownerObjectId], // Initialize team with owner
        });

        // 2. Save (Mongoose 'pre' hook validates revenue splits)
        const savedProject = await newProject.save();
        
        // 3. Handle Initial Assignment (Assign owner to a default/first role if logic requires)
        if (savedProject.roles.length > 0) {
            const firstRole = savedProject.roles[0];
            if (firstRole.assignedUserIds.length === 0) {
                 await ProjectModel.updateOne(
                    { _id: savedProject._id, 'roles._id': firstRole._id },
                    { $push: { 'roles.$.assignedUserIds': ownerObjectId } }
                );
            }
        }
        
        // 4. Trigger Events
        // PRODUCTION: Emit 'project.created' event (Task 16 subscribes for indexing)
        console.log(`[Event] Project ${savedProject._id.toString()} created by ${ownerId}.`);

        return savedProject.toObject() as IProject;
    }
}
```

#### **12.3. `src/controllers/project.controller.ts` (New File)**

```typescript
// src/controllers/project.controller.ts
import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { ProjectService } from '../services/project.service';
import { Types } from 'mongoose';

const projectService = new ProjectService();

// --- Validation Middleware ---

export const createProjectValidation = [
    body('title').isString().isLength({ min: 5, max: 200 }).withMessage('Title required (5-200 chars).').bail(),
    body('category').isString().withMessage('Category is required.'),
    body('roles').isArray({ min: 1 }).withMessage('At least one role must be defined.'),
    body('roles.*.title').isString().withMessage('Role title is required.'),
    body('revenueModel.splits').isArray({ min: 1 }).withMessage('At least one revenue split is required.'),
    // Custom validation for 100% split enforced in Mongoose 'pre' hook (Task 12.1)
];

/** Handles project creation from the 6-step wizard payload. POST /projects */
export const createProjectController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: errors.array() }});
    }

    try {
        const ownerId = req.user!.sub; // Authenticated user ID

        // 2. Service Call
        const createdProject = await projectService.createProject(ownerId, req.body);

        // 3. Success (201 Created)
        return res.status(201).json({
            projectId: createdProject._id!.toString(),
            ownerId: createdProject.ownerId.toString(),
            status: createdProject.status,
            createdAt: createdProject.createdAt!.toISOString(),
            message: 'Project created successfully in draft mode.',
        });

    } catch (error: any) {
        // 4. Error Handling: Catch Mongoose custom validation error from pre-save hook
        if (error.name === 'ValidatorError' && error.message.includes('Revenue splits must sum to 100%')) {
             return res.status(422).json({ error: { code: 'revenue_split_invalid', message: error.message } });
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during project creation.' } });
    }
};
```

#### **12.4. `src/routes/project.routes.ts` (New File)**

```typescript
// src/routes/project.routes.ts
import { Router } from 'express';
import { createProjectController, createProjectValidation } from '../controllers/project.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Protected Project Creation ---

// POST /projects - Create project (6-step wizard payload) (Task 12)
router.post(
    '/',
    authenticate,
    authorize([PERMISSIONS.PROJECT_CREATE]), // RBAC check
    createProjectValidation,
    createProjectController
);


// ... (Future Task 13, 14, 15 endpoints go here) ...

export default router;
```

#### **12.5. Test Specification**

| Test ID | Endpoint | Description | Input (Revenue Split) | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T12.1** | `POST /projects` | Happy Path: 100% Split | `[{ percentage: 100 }]` | **201 Created** | N/A |
| **T12.2** | `POST /projects` | Happy Path: Multi-Split | `[{ percentage: 50 }, { percentage: 50 }]` | **201 Created** | N/A |
| **T12.3** | `POST /projects` | Fail: Split Sum $\neq 100$ | `[{ percentage: 90 }]` | **422 Unprocessable** | `revenue_split_invalid` |
| **T12.4** | `POST /projects` | Fail: Missing Title | `{ roles: [...] }` | **422 Unprocessable** | `validation_error` |
| **T12.5** | `POST /projects` | Fail: Unauthorized Role | Valid Creator Token (missing perm) | **403 Forbidden** | `permission_denied` |

---

