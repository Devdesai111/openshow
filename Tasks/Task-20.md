Following the structured plan and ensuring full data consistency with previous tasks (especially Task 19), here is the detailed implementation for **Task 20: Asset Versioning & Download Access**.

This task completes the core `File / Assets Service` by adding functionality for versioning existing assets and implementing the crucial, permission-aware pre-signed download endpoint.

***

## **Task 20: Asset Versioning & Download Access**

**Goal:** Implement the logic for uploading a new version of an existing asset (`POST /assets/:id/version`) and provide the secure, permission-checked download endpoint (`GET /assets/:id`) which returns a time-limited, pre-signed URL.

**Service:** `File / Assets Service`
**Phase:** B - Core Platform Primitives
**Dependencies:** Task 19 (Asset Model/Service), Task 2 (RBAC Middleware), Task 12 (Project Model - for membership check).

**Output Files:**
1.  `src/services/asset.service.ts` (Updated: `addNewVersion`, `getAssetAndSignedDownloadUrl`)
2.  `src/controllers/asset.controller.ts` (Updated: new version/download controllers)
3.  `src/routes/asset.routes.ts` (Updated: new protected routes)
4.  `test/integration/asset_version_download.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /assets/:id/version** | `Params: { assetId }`, Body: `{ storageKey, size, sha256 }` | `{ assetId, versionNumber: 2, createdAt }` | Auth (Uploader/Project Owner) |
| **GET /assets/:id** | `Params: { assetId }`, Query: `{ presign?: boolean }` | `{ assetId, filename, mimeType, downloadUrl?: string }` | Auth (Member/Owner/Admin) |

**AssetDownloadDTO (Excerpt):**
```json
{
  "assetId": "60f1a2b3...", 
  "filename": "video.mp4", 
  "mimeType": "video/mp4",
  "downloadUrl": "https://s3.aws.com/mybucket/file.mp4?X-Amz-Signature=...",
  "downloadUrlExpiresAt": "2025-11-01T12:30:00Z"
}
```

**Runtime & Env Constraints:**
*   **Security:** `GET /assets/:id` must verify the requester is either the original uploader, an Admin, or a member of the linked Project. If unauthorized, the `downloadUrl` must be omitted or access denied (403).
*   **Immutability:** Adding a new version does **not** overwrite the old version's metadata; it appends a new entry to the `versions` array.
*   The `storageKey` on `POST /version` is assumed to be a new key pointing to the updated file upload (similar to Task 19's `register` step).

**Acceptance Criteria:**
*   `POST /version` must increment the version number and successfully append the new data to the `versions` array.
*   The versioning endpoint must be restricted to the original uploader or Admin (403).
*   `GET /assets/:id` with a valid member token returns the full asset metadata *and* a non-null `downloadUrl`.
*   `GET /assets/:id` with a non-member token (for a private project asset) returns **403 Forbidden**.

**Tests to Generate:**
*   **Integration Test (Versioning):** Test happy path version increment and failure on non-uploader attempt.
*   **Integration Test (Download):** Test success path for project member, and failure path for non-member/unauthorized access.

***

### **Task 20 Code Implementation**

#### **20.1. `src/services/asset.service.ts` (Updates)**

```typescript
// src/services/asset.service.ts (partial update)
// ... (Imports from Task 19, AssetModel, AssetUploadSessionModel, CloudStorageService mock) ...

import { ProjectModel, IProject } from '../models/project.model';
import { IAuthUser } from '../middlewares/auth.middleware';

// Constants for Download URL
const DOWNLOAD_URL_TTL_S = 300; // 5 minutes

export class AssetService {
    // ... (getSignedUploadUrl, registerAsset methods from Task 19) ...
    
    /**
     * Checks permission for viewing and downloading an asset.
     * @returns The Asset document.
     * @throws {Error} 'AssetNotFound', 'PermissionDenied'.
     */
    private async checkAssetAccess(assetId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<IAsset> {
        const asset = await AssetModel.findById(new Types.ObjectId(assetId)).lean() as IAsset;
        if (!asset) {
            throw new Error('AssetNotFound');
        }

        const isUploader = asset.uploaderId.toString() === requesterId;
        const isAdmin = requesterRole === 'admin';

        // Check project membership if asset is linked to a private project
        if (asset.projectId) {
            const project = await ProjectModel.findById(asset.projectId).select('teamMemberIds visibility').lean() as IProject;
            const isMember = project.teamMemberIds.some(id => id.toString() === requesterId);

            if (project.visibility === 'private' && !isMember && !isAdmin) {
                if (!isUploader) { // Uploader can always see their own uploaded files
                    throw new Error('PermissionDenied'); 
                }
            }
        }
        
        // Final check: if not uploader, not member, and not admin, then access denied (e.g. for sensitive files/private profiles)
        if (!isUploader && !isAdmin) {
            // NOTE: In a full implementation, public access rules (e.g. public portfolio) would be checked here
            throw new Error('PermissionDenied');
        }

        return asset;
    }

    /** Appends a new version entry to an existing asset. */
    public async addNewVersion(assetId: string, uploaderId: string, data: any): Promise<any> {
        const { storageKey, size, sha256 } = data;
        const assetObjectId = new Types.ObjectId(assetId);

        // 1. Check uploader ownership (or Admin)
        const asset = await AssetModel.findById(assetObjectId);
        if (!asset) { throw new Error('AssetNotFound'); }
        if (asset.uploaderId.toString() !== uploaderId) {
             throw new Error('PermissionDenied');
        }
        
        // 2. Build new version sub-document
        const newVersion: IAssetVersion = {
            versionNumber: asset.versions.length + 1, // Increment version
            storageKey,
            size,
            sha256,
            uploaderId: new Types.ObjectId(uploaderId),
            createdAt: new Date(),
        };

        // 3. Execute atomic push operation
        const updatedAsset = await AssetModel.findOneAndUpdate(
            { _id: assetObjectId },
            { 
                $push: { versions: newVersion }, 
                $set: { processed: false } // Reset processing flag for new version
            },
            { new: true }
        );

        if (!updatedAsset) { throw new Error('UpdateFailed'); }

        // 4. Trigger thumbnail job for the new version
        jobQueue.enqueueThumbnailJob(updatedAsset._id!.toString());

        // PRODUCTION: Emit 'asset.version.added' event
        console.log(`[Event] Asset ${assetId} new version ${newVersion.versionNumber} registered.`);

        return {
            assetId: updatedAsset._id!.toString(),
            versionNumber: newVersion.versionNumber,
            createdAt: newVersion.createdAt.toISOString(),
        };
    }

    /** Retrieves asset metadata and a secure download URL if authorized. */
    public async getAssetAndSignedDownloadUrl(assetId: string, requesterId: string, requesterRole: IAuthUser['role'], presign: boolean = true): Promise<any> {
        // 1. Check Access (throws 404/403 if unauthorized)
        const asset = await this.checkAssetAccess(assetId, requesterId, requesterRole);

        // 2. Get the latest version's metadata
        const latestVersion = asset.versions[asset.versions.length - 1];
        if (!latestVersion) { throw new Error('NoVersionData'); }
        
        let downloadUrl = null;
        let expiresAt = null;

        // 3. Generate Signed URL if requested
        if (presign) {
            downloadUrl = cloudStorageService.getPutSignedUrl(
                latestVersion.storageKey, 
                asset.mimeType, 
                DOWNLOAD_URL_TTL_S
            );
            expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_S * 1000).toISOString();
        }

        // 4. Map to Download DTO (consistent with Task 19 outputs)
        return {
            assetId: asset._id!.toString(),
            filename: asset.filename,
            mimeType: asset.mimeType,
            uploaderId: asset.uploaderId.toString(),
            size: latestVersion.size,
            sha256: latestVersion.sha256,
            processed: asset.processed,
            versionsCount: asset.versions.length,
            downloadUrl,
            downloadUrlExpiresAt: expiresAt,
            createdAt: asset.createdAt!.toISOString(),
        };
    }
}
```

#### **20.2. `src/controllers/asset.controller.ts` (Updates)**

```typescript
// src/controllers/asset.controller.ts (partial update)
// ... (Imports, assetService initialization, Task 19 controllers) ...

// Reusable validation for the body of a version submission
export const versionSubmissionValidation = [
    body('storageKey').isString().withMessage('Storage key is required for registration.'),
    body('size').isInt({ min: 1 }).toInt().withMessage('File size is required and must be > 0.'),
    body('sha256').isString().withMessage('SHA256 hash is required for integrity check.'),
];

// Reusable validation for assetId in params
export const assetIdParamValidation = [
    param('assetId').isMongoId().withMessage('Invalid Asset ID format.').bail(),
];


/** Appends a new version to an existing asset. POST /assets/:id/version */
export const addNewVersionController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { assetId } = req.params;
        const uploaderId = req.user!.sub;

        // 2. Service Call
        const result = await assetService.addNewVersion(assetId, uploaderId, req.body);

        // 3. Success (201 Created)
        return res.status(201).json(result);

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_uploader', message: 'You can only add versions to assets you uploaded.' } }); }
        if (error.message === 'AssetNotFound') { return res.status(404).json({ error: { code: 'asset_not_found', message: 'Asset not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error adding new version.' } });
    }
};

/** Retrieves asset metadata and a signed download URL. GET /assets/:id */
export const getAssetController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.' }}); }
    
    try {
        const { assetId } = req.params;
        const requesterId = req.user!.sub;
        const requesterRole = req.user!.role;
        // Determine if presign is requested (default true)
        const presign = req.query.presign !== 'false'; 

        // 2. Service Call (handles all permission checks)
        const assetDetails = await assetService.getAssetAndSignedDownloadUrl(assetId, requesterId, requesterRole, presign);

        // 3. Success (200 OK)
        return res.status(200).json(assetDetails);

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'access_denied', message: 'You do not have permission to view or download this asset.' } }); }
        if (error.message === 'AssetNotFound') { return res.status(404).json({ error: { code: 'asset_not_found', message: 'Asset not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error fetching asset details.' } });
    }
};
```

#### **20.3. `src/routes/asset.routes.ts` (Updates)**

```typescript
// src/routes/asset.routes.ts (partial update)
import { Router } from 'express';
import { 
    // ... (Task 19 Imports) ...
    addNewVersionController, getAssetController,
    assetIdParamValidation, versionSubmissionValidation
} from '../controllers/asset.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();

// ... (POST /assets/signed-upload-url and POST /assets/register from Task 19) ...


// --- Asset Read/Version Endpoints (Task 20) ---

// GET /assets/:assetId - Get asset metadata + signed download URL (Task 20)
router.get(
    '/:assetId',
    authenticate, // All access requires authentication
    assetIdParamValidation,
    getAssetController
);

// POST /assets/:assetId/version - Add new version entry (Task 20)
router.post(
    '/:assetId/version',
    authenticate,
    assetIdParamValidation,
    versionSubmissionValidation,
    addNewVersionController
);


// NOTE: Future endpoints (DELETE /assets/:id, etc.) will be added here.

export default router;
```

#### **20.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T20.1** | `POST /:id/version` | Happy Path: Version Increment | Auth Uploader, New `storageKey` | **201 Created** | N/A (`versionNumber: 2`) |
| **T20.2** | `POST /:id/version` | Fail: Non-Uploader Attempt | Auth Non-Uploader | **403 Forbidden** | `not_uploader` |
| **T20.3** | `GET /:id` | Happy Path: Project Member Download | Auth Member, Project Link | **200 OK** | `downloadUrl` is present. |
| **T20.4** | `GET /:id` | Fail: Unauthorized Private Asset | Auth Non-Member, Private Project | **403 Forbidden** | `access_denied` |
| **T20.5** | `GET /:id` | Fail: Asset Not Found | Invalid `assetId` | **404 Not Found** | `asset_not_found` |

---