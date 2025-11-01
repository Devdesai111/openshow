Following the project plan and prioritizing the completeness of the core `File / Assets Service`, here is the detailed implementation for **Task 22: Asset Update/Delete/List/Metadata**.

This task finalizes the Asset CRUD endpoints, adding the ability to manage metadata, list project assets, and implement the safe, soft-delete functionality.

***

## **Task 22: Asset Update/Delete/List/Metadata**

**Goal:** Complete the asset management API by implementing metadata update (`PUT /assets/:id`), soft-delete (`DELETE /assets/:id`), and the filtered listing endpoint for project assets (`GET /projects/:id/assets`).

**Service:** `File / Assets Service`
**Phase:** B - Core Platform Primitives
**Dependencies:** Task 19, 20 (Asset Model/Service), Task 12 (Project Model), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/asset.model.ts` (Updated: Add `isDeleted` field)
2.  `src/services/asset.service.ts` (Updated: `updateAssetMetadata`, `deleteAsset`, `listProjectAssets`)
3.  `src/controllers/asset.controller.ts` (Updated: new controllers)
4.  `src/routes/asset.routes.ts` (Updated: new protected routes)
5.  `test/integration/asset_manage.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK/204 No Content) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **PUT /assets/:id** | `Params: { assetId }`, Body: `{ filename?, tags?, isSensitive? }` | `AssetMetadataDTO` (updated) | Auth (Uploader/Admin) |
| **DELETE /assets/:id** | `Params: { assetId }` | **204 No Content** | Auth (Uploader/Admin) |
| **GET /projects/:id/assets** | `Params: { projectId }`, Query: `{ mimeType?, page? }` | `AssetListResponse` (Paginated) | Auth (Member only) |

**AssetMetadataDTO (Excerpt):**
```json
{
  "assetId": "60f1a2b3...", 
  "filename": "new_title.mp4", 
  "isSensitive": false,
  "updatedAt": "2025-11-01T12:30:00Z"
}
```

**Runtime & Env Constraints:**
*   **Soft Delete:** `DELETE` must set an `isDeleted: true` flag rather than hard-deleting the record, ensuring recoverability and audit trails.
*   **Authorization:** Asset mutation is restricted to the original uploader or Admin. Listing project assets is restricted to project members.
*   **Security:** `DELETE` should log an event and block future `downloadUrl` generation for that asset.

**Acceptance Criteria:**
*   `DELETE /assets/:id` returns **204 No Content** and sets `isDeleted=true` in the database.
*   `PUT /assets/:id` successfully updates non-version-related metadata (`filename`, `tags`) and returns **200 OK**.
*   `GET /projects/:id/assets` returns a paginated list of all *non-deleted* assets linked to the project, restricted to project members (403).

**Tests to Generate:**
*   **Integration Test (Delete):** Test successful soft-delete, and subsequent failure to retrieve the deleted asset's `downloadUrl` (if not explicitly filtered).
*   **Integration Test (Listing):** Test member successfully retrieving a list and non-member failing (403).
*   **Integration Test (Update):** Test uploader successfully updating metadata.

***

### **Task 22 Code Implementation**

#### **22.1. `src/models/asset.model.ts` (Update)**

```typescript
// src/models/asset.model.ts (partial update)
// ... (All previous imports and schemas) ...

export interface IAsset {
  // ... (Existing fields) ...
  isDeleted: boolean; // New Soft Delete Flag
  deletedAt?: Date; // Timestamp of deletion
}

const AssetSchema = new Schema<IAsset>({
  // ... (Existing fields) ...
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date },
}, { timestamps: true });

export const AssetModel = model<IAsset>('Asset', AssetSchema);
```

#### **22.2. `src/services/asset.service.ts` (Updates)**

```typescript
// src/services/asset.service.ts (partial update)
// ... (Imports, AssetModel, AssetUploadSessionModel, MockJobQueue, etc.) ...
import { IAuthUser } from '../middlewares/auth.middleware';

// Mock Project Membership Check (re-used logic)
class MockProjectAcl {
    public async isProjectMember(projectId: string, userId: string): Promise<boolean> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).select('teamMemberIds').lean() as IProject;
        if (!project) return false;
        return project.teamMemberIds.some(id => id.toString() === userId);
    }
}
const projectAcl = new MockProjectAcl();


export class AssetService {
    // ... (All previous methods from Task 19/20) ...
    
    /** Checks permission for mutation (Uploader or Admin). @throws {Error} 'PermissionDenied' | 'AssetNotFound' */
    private async checkAssetMutationAccess(assetId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<IAsset> {
        const asset = await AssetModel.findById(new Types.ObjectId(assetId)).lean() as IAsset;
        if (!asset) { throw new Error('AssetNotFound'); }
        if (asset.isDeleted) { throw new Error('AssetDeleted'); }

        const isUploader = asset.uploaderId.toString() === requesterId;
        const isAdmin = requesterRole === 'admin';

        if (!isUploader && !isAdmin) {
            throw new Error('PermissionDenied');
        }

        return asset;
    }


    /** Updates asset metadata. */
    public async updateAssetMetadata(assetId: string, requesterId: string, requesterRole: IAuthUser['role'], updateData: any): Promise<IAsset> {
        const asset = await this.checkAssetMutationAccess(assetId, requesterId, requesterRole);

        // 1. Filter updateable fields
        const update: any = {};
        if (updateData.filename !== undefined) update.filename = updateData.filename;
        if (updateData.tags !== undefined) update.tags = updateData.tags;
        if (updateData.isSensitive !== undefined) update.isSensitive = updateData.isSensitive;
        
        // 2. Execute update
        const updatedAsset = await AssetModel.findOneAndUpdate(
            { _id: asset._id },
            { $set: update },
            { new: true }
        );

        if (!updatedAsset) { throw new Error('UpdateFailed'); }

        // PRODUCTION: Emit 'asset.metadata.updated' event
        console.log(`[Event] Asset ${assetId} metadata updated.`);
        
        return updatedAsset.toObject() as IAsset;
    }


    /** Soft-deletes an asset. */
    public async deleteAsset(assetId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<void> {
        const asset = await this.checkAssetMutationAccess(assetId, requesterId, requesterRole);
        
        // 1. Execute soft delete
        const result = await AssetModel.updateOne(
            { _id: asset._id, isDeleted: false }, // Ensure it's not already deleted
            { $set: { isDeleted: true, deletedAt: new Date() } }
        );

        if (result.modifiedCount === 0) { throw new Error('DeleteFailed'); }

        // PRODUCTION: Emit 'asset.deleted' event (important for cleanup/audit)
        console.log(`[Event] Asset ${assetId} soft-deleted.`);
    }
    
    /** Lists paginated assets for a specific project. */
    public async listProjectAssets(projectId: string, requesterId: string, requesterRole: IAuthUser['role'], queryParams: any): Promise<any> {
        // 1. Security Check: Must be a project member or Admin
        const isMember = await projectAcl.isProjectMember(projectId, requesterId);
        if (!isMember && requesterRole !== 'admin') {
            throw new Error('PermissionDenied');
        }
        
        const limit = parseInt(queryParams.per_page || 20);
        const skip = (parseInt(queryParams.page || 1) - 1) * limit;

        const filters: any = { 
            projectId: new Types.ObjectId(projectId), 
            isDeleted: false // Exclude soft-deleted assets
        };
        if (queryParams.mimeType) filters.mimeType = queryParams.mimeType;
        
        const [totalResults, assets] = await Promise.all([
            AssetModel.countDocuments(filters),
            AssetModel.find(filters)
                .select('-versions -isSensitive') // Exclude heavy/sensitive fields for list view
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean() as Promise<IAsset[]>,
        ]);
        
        // Map to DTO (minimal list data)
        const data = assets.map(asset => ({
            assetId: asset._id!.toString(),
            filename: asset.filename,
            mimeType: asset.mimeType,
            uploaderId: asset.uploaderId.toString(),
            createdAt: asset.createdAt!.toISOString(),
        }));

        return {
            meta: { page: parseInt(queryParams.page || 1), per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data,
        };
    }
}
```

#### **22.3. `src/controllers/asset.controller.ts` (Updates)**

```typescript
// src/controllers/asset.controller.ts (partial update)
// ... (Imports, assetService initialization, Task 19/20 controllers) ...

export const updateAssetMetadataValidation = [
    // Validation for mutable fields (filename, tags, sensitivity)
    body('filename').optional().isString().isLength({ min: 1, max: 1024 }).withMessage('Filename max 1024 chars.'),
    body('isSensitive').optional().isBoolean().withMessage('IsSensitive must be a boolean.'),
    body('tags').optional().isArray().withMessage('Tags must be an array.'),
];

export const listProjectAssetsValidation = [
    param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('per_page').optional().isInt({ min: 1, max: 100 }).toInt(),
];

/** Updates asset metadata. PUT /assets/:id */
export const updateAssetMetadataController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { assetId } = req.params;
        const updatedAsset = await assetService.updateAssetMetadata(assetId, req.user!.sub, req.user!.role, req.body);

        return res.status(200).json({
            assetId: updatedAsset._id!.toString(),
            filename: updatedAsset.filename,
            isSensitive: updatedAsset.isSensitive,
            updatedAt: updatedAsset.updatedAt!.toISOString(),
        });
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_uploader', message: 'Only the uploader or admin can modify asset metadata.' } }); }
        if (error.message === 'AssetNotFound') { return res.status(404).json({ error: { code: 'asset_not_found', message: 'Asset not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating metadata.' } });
    }
};

/** Soft-deletes an asset. DELETE /assets/:id */
export const deleteAssetController = async (req: Request, res: Response) => {
    try {
        await assetService.deleteAsset(req.params.assetId, req.user!.sub, req.user!.role);
        return res.status(204).send();
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_uploader', message: 'Only the uploader or admin can delete this asset.' } }); }
        if (error.message === 'AssetNotFound') { return res.status(404).json({ error: { code: 'asset_not_found', message: 'Asset not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error deleting asset.' } });
    }
};

/** Lists paginated assets for a project. GET /projects/:id/assets */
export const listProjectAssetsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.' }}); }
    
    try {
        const result = await assetService.listProjectAssets(req.params.projectId, req.user!.sub, req.user!.role, req.query);
        return res.status(200).json(result);
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_member', message: 'You must be a project member to list assets.' } }); }
        if (error.message === 'ProjectNotFound') { return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing project assets.' } });
    }
};
```

#### **22.4. `src/routes/asset.routes.ts` (Updates)**

```typescript
// src/routes/asset.routes.ts (partial update)
import { Router } from 'express';
// ... (Task 19/20 Imports) ...
import {
    updateAssetMetadataController, deleteAssetController, listProjectAssetsController,
    updateAssetMetadataValidation, listProjectAssetsValidation
} from '../controllers/asset.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { param } from 'express-validator';

const router = Router();
const assetIdParamValidation = [param('assetId').isMongoId().withMessage('Invalid Asset ID format.').bail()];


// --- Asset Management Endpoints (Task 22) ---

// PUT /assets/:assetId - Update asset metadata (Task 22)
router.put(
    '/:assetId',
    authenticate,
    assetIdParamValidation,
    updateAssetMetadataValidation,
    updateAssetMetadataController
);

// DELETE /assets/:assetId - Soft-delete asset (Task 22)
router.delete(
    '/:assetId',
    authenticate,
    assetIdParamValidation,
    deleteAssetController
);


// --- Project Scoped Asset Listing (Task 22) ---

// GET /projects/:projectId/assets - List project assets (Member only)
router.get(
    '/projects/:projectId/assets',
    authenticate,
    listProjectAssetsValidation,
    listProjectAssetsController
);


// ... (All other Task 19/20 endpoints) ...

export default router;
```

#### **22.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T22.1** | `PUT /assets/:id` | Happy Path: Metadata Update | Auth Uploader | **200 OK** | N/A |
| **T22.2** | `DELETE /assets/:id` | Happy Path: Soft Delete | Auth Uploader | **204 No Content** | N/A |
| **T22.3** | `DELETE /assets/:id` | Fail: Unauthorized | Auth Non-Uploader | **403 Forbidden** | `not_uploader` |
| **T22.4** | `GET /projects/:id/assets` | Happy Path: Member List | Auth Member, Valid Project | **200 OK** | Paginated list of non-deleted assets. |
| **T22.5** | `GET /projects/:id/assets` | Fail: Non-Member List | Auth Non-Member | **403 Forbidden** | `not_member` |

---