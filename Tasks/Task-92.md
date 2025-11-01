Following the structured plan and moving into data segregation and architecture, we proceed with **Task 92: Multi-tenant & Tenant Isolation Support**.

This task establishes the architectural approach for handling multiple logical customers or environments within the same physical infrastructure (if required for B2B/Enterprise) and ensures that data retrieval logic enforces strict tenant boundaries.

***

## **Task 92: Multi-tenant & Tenant Isolation Support**

**Goal:** Implement the conceptual structure (models and query logic) necessary to support multi-tenancy, including adding a `tenantId` to core models and creating middleware to automatically enforce tenant segregation on all authenticated database queries.

**Service:** `Auth & Identity Service` / `Database / Infrastructure`
**Phase:** A - Foundations
**Dependencies:** Task 2 (RBAC Middleware - to enforce tenant check), Task 78 (Migration - to add `tenantId`).

**Output Files:**
1.  `src/models/tenant.model.ts` (New file: Conceptual `ITenant` model)
2.  `src/middlewares/tenant.middleware.ts` (New file: Automatic query-scoping logic)
3.  `src/services/auth.service.ts` (Updated: Login logic to retrieve `tenantId`)
4.  `src/app.ts` (Mocked file: Application of middleware)
5.  `test/unit/tenant_isolation.test.ts` (Test specification)

**Input/Output Shapes:**

| Middleware Action | Condition | Database Query | Security Principle |
| :--- | :--- | :--- | :--- |
| **Query Scoping** | Authenticated request with `req.user.tenantId='T1'` | Mongoose query automatically transforms to `find({ tenantId: 'T1', ... })` | Data Segregation (Row-Level Security). |

**Runtime & Env Constraints:**
*   **Security (CRITICAL):** Tenant ID must be pulled from the authenticated user's JWT/DB profile and applied implicitly to every query.
*   **Performance:** Middleware must avoid excessive overhead; it should attach a property to the request for services to use, or use a Mongoose plugin/hook (preferred for reliability).

**Acceptance Criteria:**
*   The `tenant.middleware` successfully identifies the `tenantId` and makes it available (simulated in `req.user.tenantId`).
*   A test of `Tenant A` attempting to query data belonging to `Tenant B` must fail (zero results).
*   The `UserModel` is updated to include a `tenantId`.

**Tests to Generate:**
*   **Unit Test (Middleware Logic):** Test a mock Mongoose query being automatically appended with the required `tenantId` filter.
*   **Unit Test (Isolation):** Test a mock service method returning data only scoped to the mock user's tenant ID.

***

### **Task 92 Code Implementation**

#### **92.1. `src/models/tenant.model.ts` (New Conceptual Model)**

```typescript
// src/models/tenant.model.ts
import { Schema, model, Types } from 'mongoose';

export interface ITenant {
    _id?: Types.ObjectId;
    tenantId: string; // Unique, short identifier (e.g., 'T-Enterprise', 'T-Free')
    name: string;
    isActive: boolean;
    // Configuration fields (e.g., custom domain, custom fee model)
    config: any; 
    createdAt?: Date;
}

const TenantSchema = new Schema<ITenant>({
    tenantId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    config: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });

export const TenantModel = model<ITenant>('Tenant', TenantSchema);```

#### **92.2. `src/models/user.model.ts` (Update - Tenant ID)**

```typescript
// src/models/user.model.ts (Update - Add tenantId to IAuthUser and IUser)
// ... (IUser interface definition) ...

export interface IUser {
    // ... existing fields ...
    tenantId: string; // New: Unique ID for the user's organization/tenant
}

// Global declaration merge (from Task 2) to include tenantId in JWT payload
declare module 'express-serve-static-core' {
    interface Request {
        user?: IAuthUser & { tenantId: string }; // Update IAuthUser structure
    }
}

// Update the Mongoose Schema
const UserSchema = new Schema<IUser>({
    // ... existing fields ...
    tenantId: { type: String, required: true, index: true, default: 'T-DEFAULT' }, // CRITICAL: Indexed for query scoping
}, { timestamps: true });
// ... (Model export) ...
```

#### **92.3. `src/middlewares/tenant.middleware.ts` (New Scoping Middleware)**

```typescript
// src/middlewares/tenant.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { Schema, Model, Document, FilterQuery, ClientSession } from 'mongoose';
import { IAuthUser } from './auth.middleware';

/**
 * Middleware that extracts tenantId from JWT/session and attaches it to the request.
 * CRITICAL: This MUST run after 'authenticate'.
 */
export const extractTenant = (req: Request, res: Response, next: NextFunction) => {
    if (req.user && req.user.sub) {
        // MOCK: In production, we'd fetch/verify this from the DB/cache.
        // For now, we assume the JWT (or a preceding DB call) populated req.user with the tenantId.
        (req.user as any).tenantId = req.user.tenantId || 'T-DEFAULT'; 
    }
    next();
};

/**
 * Mongoose Query Scoping Plugin (Row-Level Security)
 * Automatically filters all find/update/delete operations by the tenantId.
 */
export const TenantPlugin = (schema: Schema, options: { excludeModels: string[] } = { excludeModels: [] }) => {
    
    // Set a flag on the schema to indicate it should be scoped
    (schema as any).tenantScoped = true;

    schema.pre(['find', 'findOne', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'], function (next) {
        const query = this as any;
        const modelName = query.model.modelName;

        // Bypass check if model is explicitly excluded (e.g., AuditLog, Tenant itself, User)
        if (options.excludeModels.includes(modelName)) {
             return next();
        }

        // 1. Get Tenant ID from Request Context
        const req = query.options.req as Request;
        const tenantId = req?.user?.tenantId;
        
        if (tenantId && tenantId !== 'T-GLOBAL') { // 'T-GLOBAL' is for Admin/Superuser access
             // 2. Apply the Scoping Filter
             query.setQuery({ 
                 ...query.getQuery(), 
                 tenantId: tenantId 
             });
        }
        
        next();
    });
};
```

#### **92.4. `src/app.ts` (Mocked Placement - Illustrative)**

```typescript
// src/app.ts (Mock - Demonstrating how Mongoose models and Express use the plugin)
// ...
import { TenantPlugin } from './middlewares/tenant.middleware';
// ...

// Mongoose Setup (Must be done before defining/using any models)
mongoose.plugin(TenantPlugin, { excludeModels: ['User', 'Tenant', 'AuditLog'] }); 
// User model is excluded because it's the source of truth for the tenantId.
// AuditLog is excluded because it's global/cross-tenant.

// Express Setup
app.use(tracingMiddleware);
app.use(authenticate); // Sets req.user
app.use(extractTenant); // Sets req.user.tenantId

// app.use('/projects', projectRoutes); // All Project queries are now tenant-scoped!
```

#### **92.5. Test Specification**

| Test ID | Method | Description | Command | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **T92.1** | `Unit Test` | Tenant Scoping Check | Mock `ProjectModel.find({})` with `req.user.tenantId='T1'` | Mongoose query must be `{ tenantId: 'T1' }`. |
| **T92.2** | `Unit Test` | Isolation Check | User A (`T1`) attempts to update a Project B (`T2`) | Query must be `{ _id: idB, tenantId: 'T1' }` (Will fail to find Project B). |
| **T92.3** | `Unit Test` | Exclusion Check | Query on `AuditLogModel` | Query must NOT be automatically filtered by `tenantId`. |

---

