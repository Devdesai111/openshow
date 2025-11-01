You are absolutely correct. **Task 64: Admin User Management (Roles, Suspension/Ban)** was partially covered by Task 6 (which implemented `/suspend` and `/unsuspend`).

To complete the full scope of user management as required by the Admin & Audit Service, Task 64 must implement the general user list query and the ability to view/edit user roles.

***

## **Task 64: Admin User Management (Roles, Suspension/Ban)**

**Goal:** Implement the centralized Admin-only endpoints for user account oversight: list all users (`GET /admin/users`), search/filter for management, and provide the ability to update a user's role (`PUT /admin/users/:id/role`).

**Service:** `Admin & Audit / Reporting Service`
**Phase:** H - Admin, Moderation, Disputes & Refunds
**Dependencies:** Task 6 (Auth Service - Suspension), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/admin.service.ts` (New file: `listAllUsers`, `updateUserRole`)
2.  `src/controllers/admin.controller.ts` (Updated: new controllers)
3.  `src/routes/admin.routes.ts` (Updated: new protected routes)
4.  `test/integration/admin_user_manage.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /admin/users** | `query: { status?, role?, q?, page? }` | `UserListResponse` (Paginated, Full DTO) | Auth (Admin) |
| **PUT /admin/users/:id/role** | `Body: { newRole: 'creator'|'owner'|'admin' }` | `{ userId, newRole }` | Auth (Admin) |

**UserListResponse (Admin DTO - Excerpt):**
```json
{
  "meta": { "total": 120 },
  "data": [
    { "id": "user_1", "email": "full@data.com", "role": "creator", "status": "suspended" }
  ]
}
```

**Runtime & Env Constraints:**
*   **Security:** All endpoints must be strictly restricted to Admin roles (`USER_MANAGE_ALL`).
*   **Audit:** All role changes **must** be recorded via the `AuditService` (Task 60).
*   **Role Logic:** Role modification requires validating the new role against the allowed set (`creator`, `owner`, `admin`).

**Acceptance Criteria:**
*   `GET /admin/users` returns a paginated list of **all** users, including private fields like `email` and `status`.
*   `PUT /admin/users/:id/role` successfully updates the `UserModel.role` field and returns **200 OK**.
*   The role update triggers an `audit.created` event with details of the role change.
*   The system must prevent a non-Admin from accessing the endpoints (403 Forbidden).

**Tests to Generate:**
*   **Integration Test (List):** Test Admin querying the list and confirming non-Admin users are excluded (403).
*   **Integration Test (Role Change):** Test Admin changing a `creator` role to an `owner` role, verifying the database and the audit log.

***

### **Task 64 Code Implementation**

#### **64.1. `src/services/admin.service.ts` (New File)**

```typescript
// src/services/admin.service.ts
import { UserModel, IUser } from '../models/user.model';
import { AuditService } from './audit.service'; // Task 60 Dependency
import { Types } from 'mongoose';

const auditService = new AuditService();

interface IAdminQueryFilters {
    status?: string;
    role?: string;
    q?: string;
    page?: number;
    per_page?: number;
}

export class AdminService {

    /** Admin function to list and search all users (Full DTO). */
    public async listAllUsers(filters: IAdminQueryFilters): Promise<any> {
        const { status, role, q, page = 1, per_page = 20 } = filters;
        const limit = parseInt(per_page.toString());
        const skip = (parseInt(page.toString()) - 1) * limit;

        const query: any = {};
        if (status) query.status = status;
        if (role) query.role = role;
        
        // Simple search simulation on email/name (real search engine would use Task 41)
        if (q) {
             query.$or = [
                 { email: { $regex: q, $options: 'i' } },
                 { fullName: { $regex: q, $options: 'i' } },
             ];
        }

        // 1. Execution (Include all fields for admin view, excluding password hash)
        const [totalResults, users] = await Promise.all([
            UserModel.countDocuments(query),
            UserModel.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IUser[]>
        ]);

        // 2. Map to Admin Full DTO
        const data = users.map(user => ({
            ...user,
            id: user._id!.toString(),
            // All PII included for admin view
            email: user.email, 
            status: user.status,
        }));

        return {
            meta: { page: parseInt(page.toString()), per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data,
        };
    }

    /** Admin function to update a user's role. */
    public async updateUserRole(targetUserId: string, newRole: IUser['role'], adminId: string): Promise<IUser> {
        const targetObjectId = new Types.ObjectId(targetUserId);
        
        const user = await UserModel.findById(targetObjectId).lean() as IUser;
        if (!user) { throw new Error('UserNotFound'); }

        const oldRole = user.role;
        
        // Prevent admin from demoting themselves (a common high-level security rule)
        if (targetUserId === adminId && newRole !== oldRole) {
            if (oldRole === 'admin' && newRole !== 'admin') {
                throw new Error('SelfDemotionForbidden');
            }
        }
        
        // 1. Update Role
        const updatedUser = await UserModel.findOneAndUpdate(
            { _id: targetObjectId },
            { $set: { role: newRole } },
            { new: true }
        ).lean() as IUser;
        
        if (!updatedUser) { throw new Error('UpdateFailed'); }

        // 2. Audit Log (CRITICAL)
        await auditService.logAuditEntry({
            resourceType: 'user',
            resourceId: targetUserId,
            action: 'user.role.updated',
            actorId: adminId,
            details: { oldRole, newRole },
        });

        // 3. Return updated DTO (sanitized)
        return updatedUser;
    }
}
```

#### **64.2. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { AdminService } from '../services/admin.service'; // New Import
import { body, query, param, validationResult } from 'express-validator';
import { IUser } from '../models/user.model';

const adminService = new AdminService();

// --- Validation Middleware ---

export const adminUserListValidation = [
    query('status').optional().isIn(['active', 'pending', 'suspended']).withMessage('Invalid status filter.'),
    query('role').optional().isIn(['creator', 'owner', 'admin']).withMessage('Invalid role filter.'),
    query('q').optional().isString().withMessage('Search query must be a string.'),
    // ... (page/per_page validation reused)
];

export const updateRoleValidation = [
    param('userId').isMongoId().withMessage('Invalid User ID format.').bail()),
    body('newRole').isIn(['creator', 'owner', 'admin']).withMessage('Invalid role provided.'),
];


// --- Admin User Management Controllers ---

/** Lists all users. GET /admin/users */
export const listAdminUsersController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const list = await adminService.listAllUsers(req.query);
        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing users.' } });
    }
};

/** Updates a user's role. PUT /admin/users/:id/role */
export const updateAdminUserRoleController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { userId } = req.params;
        const { newRole } = req.body;
        const adminId = req.user!.sub;

        const updatedUser = await adminService.updateUserRole(userId, newRole as IUser['role'], adminId);

        return res.status(200).json({
            userId: updatedUser._id!.toString(),
            oldRole: updatedUser.role, // NOTE: In this DTO, 'role' will be the old role since the service returns the pre-update object if using lean().
            newRole: newRole,
            message: 'User role updated successfully.',
        });
    } catch (error: any) {
        if (error.message === 'UserNotFound') { return res.status(404).json({ error: { code: 'user_not_found', message: 'Target user account not found.' } }); }
        if (error.message === 'SelfDemotionForbidden') { return res.status(403).json({ error: { code: 'self_demotion', message: 'Admin cannot demote themselves from the admin role.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating user role.' } });
    }
};
```

#### **64.3. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 39/42/60) ...
import { 
    listAdminUsersController, updateAdminUserRoleController,
    adminUserListValidation, updateRoleValidation
} from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const userManageAccess = [PERMISSIONS.USER_MANAGE_ALL];


// ... (Admin Financial/Monitoring/Audit Endpoints) ...


// --- Admin User Management Endpoints (Task 64) ---

// GET /admin/users - List all users (Full DTO)
router.get(
    '/users',
    authenticate,
    authorize(userManageAccess), // RBAC check
    adminUserListValidation,
    listAdminUsersController
);

// PUT /admin/users/:userId/role - Update user's role
router.put(
    '/users/:userId/role',
    authenticate,
    authorize(userManageAccess), // RBAC check
    updateRoleValidation,
    updateAdminUserRoleController
);


export default router;
```

#### **64.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T64.1** | `GET /users` | Happy Path: Full List | Auth Admin | **200 OK** | Returns all users, including emails/status. |
| **T64.2** | `GET /users` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T64.3** | `PUT /users/:id/role` | Happy Path: Change Role | Auth Admin, Change `creator` to `owner` | **200 OK** | DB role updated, Audit Log written. |
| **T64.4** | `PUT /users/:id/role` | Fail: Self Demotion | Auth Admin, Change self-role to `owner` | **403 Forbidden** | `self_demotion` |

---