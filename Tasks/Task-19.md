Following the project plan, we proceed with **Task 19: File/Asset Signed Upload URL & Register**.

This task is critical as it establishes the secure and scalable mechanism for handling large file uploads: the **two-step signed URL process**. This method ensures the backend remains decoupled from heavy binary transfer and enforces security via temporary, client-direct cloud storage access.

***

## **Task 19: File/Asset Signed Upload URL & Register**

**Goal:** Implement the primary asset upload workflow: the server issues a time-limited signed S3 upload URL (`POST /assets/signed-upload-url`), and the client calls back (`POST /assets/register`) after a successful cloud upload to register the asset metadata.

**Service:** `File / Assets Service`
**Phase:** B - Core Platform Primitives
**Dependencies:** Task 1 (User Model), Task 2 (RBAC Middleware), Task 12 (Project Model - for asset linkage).

**Output Files:**
1.  `src/models/asset.model.ts` (New file: IAsset and sub-schemas)
2.  `src/models/assetUploadSession.model.ts` (New file: IAssetUploadSession)
3.  `src/services/asset.service.ts` (New file: `getSignedUploadUrl`, `registerAsset`)
4.  `src/controllers/asset.controller.ts` (New file: asset controllers)
5.  `src/routes/asset.routes.ts` (New file: router for `/assets`)
6.  `test/integration/asset_upload.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Query) | Response (201 Created) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /assets/signed-upload-url** | `{ filename, mimeType, projectId?, expectedSha256? }` | `{ assetUploadId, uploadUrl, uploadMethod, expiresAt }` | Auth (Any) |
| **POST /assets/register** | `{ assetUploadId, storageKey, size, sha256 }` | `{ assetId, versionNumber: 1, processed: false, createdAt }` | Auth (Uploader) |

**SignedUploadResponse (Excerpt):**
```json
{
  "assetUploadId": "upl_abcdef123",
  "uploadUrl": "https://s3.aws.com/mybucket/temp/...",
  "uploadMethod": "PUT",
  "expiresAt": "2025-11-01T12:30:00Z"
}
```

**Runtime & Env Constraints:**
*   **Security:** Requires an AWS SDK or cloud storage client library (mocked here) to generate the pre-signed URL.
*   The `assetUploadId` must link the initial request metadata to the final registration step.
*   TTL for pre-signed URL is short (e.g., 15 minutes).

**Acceptance Criteria:**
*   `POST /signed-upload-url` returns a unique `assetUploadId` and a placeholder `uploadUrl`.
*   `POST /register` successfully finds the `assetUploadId`, creates the permanent `AssetModel` record, and returns the final `assetId`.
*   The registration step must validate that the `assetUploadId` is not expired or already used.
*   The final registered asset record must contain the `storageKey` and mark `processed=false`.

**Tests to Generate:**
*   **Integration Test (Two-Step Flow):** Test full sequence: request $\rightarrow$ mock S3 upload $\rightarrow$ register.
*   **Integration Test (Security):** Test failed registration due to expired `assetUploadId` (404/400).
*   **Unit Test (Validation):** Test missing `mimeType` or missing `storageKey` on register (422).

**Non-Goals / Out-of-Scope (for Task 19):**
*   Actual S3 interaction (mocked by returning a placeholder URL).
*   Thumbnail/Transcode worker job execution (only the event emission/job enqueue is required).

***

### **Task 19 Code Implementation**

#### **19.1. `src/models/asset.model.ts` (New Model)**

```typescript
// src/models/asset.model.ts
import { Schema, model, Types } from 'mongoose';

// SENSITIVE: Internal-only metadata for a specific version/file in storage
export interface IAssetVersion {
  versionNumber: number;
  storageKey: string; // S3 Key (internal)
  sha256: string; // Hash for integrity check
  size: number;
  uploaderId: Types.ObjectId;
  createdAt: Date;
}

export interface IAsset {
  _id?: Types.ObjectId;
  projectId?: Types.ObjectId;
  uploaderId: Types.ObjectId;
  filename: string;
  mimeType: string;
  isSensitive: boolean; // PII flag
  processed: boolean; // Flag for thumbnail/transcode completion
  thumbnailAssetId?: Types.ObjectId; // Reference to a derived asset (thumbnail)
  versions: IAssetVersion[]; // All versions of this asset
  createdAt?: Date;
  updatedAt?: Date;
}

const AssetVersionSchema = new Schema<IAssetVersion>({
  versionNumber: { type: Number, required: true },
  storageKey: { type: String, required: true, index: true },
  sha256: { type: String, required: true },
  size: { type: Number, required: true },
  uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const AssetSchema = new Schema<IAsset>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
  uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  filename: { type: String, required: true, maxlength: 1024 },
  mimeType: { type: String, required: true },
  isSensitive: { type: Boolean, default: false },
  processed: { type: Boolean, default: false },
  thumbnailAssetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
  versions: { type: [AssetVersionSchema], default: [], required: true },
}, { timestamps: true });

export const AssetModel = model<IAsset>('Asset', AssetSchema);
```

#### **19.2. `src/models/assetUploadSession.model.ts` (New Model)**

```typescript
// src/models/assetUploadSession.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IAssetUploadSession {
  _id?: Types.ObjectId;
  assetUploadId: string; // Unique short ID for client callback reference
  uploaderId: Types.ObjectId;
  projectId?: Types.ObjectId;
  filename: string;
  mimeType: string;
  expectedSha256?: string;
  isUsed: boolean; // Flag to prevent double-registration
  expiresAt: Date;
  createdAt?: Date;
}

const AssetUploadSessionSchema = new Schema<IAssetUploadSession>({
  assetUploadId: { type: String, required: true, unique: true },
  uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  filename: { type: String, required: true },
  mimeType: { type: String, required: true },
  expectedSha256: { type: String },
  isUsed: { type: Boolean, default: false, index: true },
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true });

// SECURITY: TTL Index for auto-cleanup of abandoned uploads (e.g., after 24 hours)
AssetUploadSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AssetUploadSessionModel = model<IAssetUploadSession>('AssetUploadSession', AssetUploadSessionSchema);
```

#### **19.3. `src/services/asset.service.ts` (New File)**

```typescript
// src/services/asset.service.ts
import { AssetModel, IAssetVersion } from '../models/asset.model';
import { AssetUploadSessionModel, IAssetUploadSession } from '../models/assetUploadSession.model';
import { Types } from 'mongoose';
import crypto from 'crypto';

// --- Mocks/Constants ---
const SIGNED_URL_TTL_S = 900; // 15 minutes
const SIGNED_URL_MOCK = 'https://s3.amazonaws.com/mock-bucket/temp/'; 

// Mock AWS SDK/Cloud Client for Pre-signing
class CloudStorageService {
    public getPutSignedUrl(key: string, mimeType: string, ttl: number): string {
        // PRODUCTION: Use AWS.S3.getSignedUrl() or equivalent
        return `${SIGNED_URL_MOCK}${key}?X-Amz-Signature=...`;
    }
    public generateStorageKey(projectId: string, uploaderId: string, filename: string): string {
        // Deterministic key generation
        const safeFilename = filename.replace(/\s/g, '_').toLowerCase();
        return `uploads/${projectId}/${uploaderId}/${Date.now()}-${safeFilename}`;
    }
}
const cloudStorageService = new CloudStorageService();

// Mock Job/Event Emitter
class MockJobQueue {
    public enqueueThumbnailJob(assetId: string): void {
        console.log(`[Job Enqueued] Thumbnail creation for Asset ${assetId}.`);
    }
}
const jobQueue = new MockJobQueue();


export class AssetService {

    /** Issues a signed URL for a client to upload directly to cloud storage. */
    public async getSignedUploadUrl(uploaderId: string, data: any): Promise<any> {
        const { filename, mimeType, projectId, expectedSha256 } = data;
        
        // 1. Generate unique IDs and secure storage key
        const assetUploadId = `upl_${crypto.randomBytes(10).toString('hex')}`;
        const storageKey = cloudStorageService.generateStorageKey(projectId || 'profile', uploaderId, filename);
        
        // 2. Generate signed URL
        const uploadUrl = cloudStorageService.getPutSignedUrl(storageKey, mimeType, SIGNED_URL_TTL_S);
        const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_S * 1000);
        
        // 3. Create ephemeral session record (awaiting client callback)
        const session = new AssetUploadSessionModel({
            assetUploadId,
            uploaderId: new Types.ObjectId(uploaderId),
            projectId: projectId ? new Types.ObjectId(projectId) : undefined,
            filename,
            mimeType,
            expectedSha256,
            expiresAt,
            isUsed: false,
        });
        await session.save();

        return {
            assetUploadId,
            uploadUrl,
            uploadMethod: 'PUT',
            expiresAt: expiresAt.toISOString(),
            storageKeyHint: storageKey.split('/').slice(-3).join('/'), // Don't expose full key
        };
    }

    /** Registers the asset metadata after the client's successful cloud upload. */
    public async registerAsset(uploaderId: string, data: any): Promise<any> {
        const { assetUploadId, storageKey, size, sha256, expectedSha256 } = data;

        // 1. Retrieve and validate the session
        const session = await AssetUploadSessionModel.findOne({ assetUploadId, isUsed: false });

        if (!session) {
            throw new Error('SessionNotFoundOrUsed');
        }
        if (session.uploaderId.toString() !== uploaderId) {
             throw new Error('PermissionDenied'); // Uploader must match session owner
        }
        if (session.expiresAt < new Date()) {
            throw new Error('SessionExpired');
        }
        
        // 2. Invalidate session (critical for idempotency)
        session.isUsed = true;
        await session.save(); 
        
        // 3. Create the permanent Asset record
        const newVersion: IAssetVersion = {
            versionNumber: 1,
            storageKey,
            size,
            sha256: sha256 || expectedSha256 || 'not_provided',
            uploaderId: session.uploaderId,
            createdAt: new Date(),
        };

        const newAsset = new AssetModel({
            projectId: session.projectId,
            uploaderId: session.uploaderId,
            filename: session.filename,
            mimeType: session.mimeType,
            versions: [newVersion],
            processed: false,
        });
        const savedAsset = await newAsset.save();

        // 4. Trigger background jobs
        jobQueue.enqueueThumbnailJob(savedAsset._id!.toString());
        
        // PRODUCTION: Emit 'asset.uploaded' event (Collaboration, Verification services subscribe)
        console.log(`[Event] Asset ${savedAsset._id!.toString()} registered and thumbnail job queued.`);

        return {
            assetId: savedAsset._id!.toString(),
            versionNumber: 1,
            processed: false,
            createdAt: savedAsset.createdAt!.toISOString(),
        };
    }
}
```

#### **19.4. `src/controllers/asset.controller.ts` (New File)**

```typescript
// src/controllers/asset.controller.ts
import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AssetService } from '../services/asset.service';

const assetService = new AssetService();

// --- Validation Middleware ---
export const signedUploadValidation = [
    body('filename').isString().isLength({ min: 1, max: 1024 }).withMessage('Filename is required (max 1024 chars).'),
    body('mimeType').isMimeType().withMessage('Mime type is required and must be valid.'),
    body('projectId').optional().isMongoId().withMessage('Project ID must be a valid Mongo ID.'),
    body('expectedSha256').optional().isString().withMessage('SHA256 hash can be optionally provided.'),
];

export const registerAssetValidation = [
    body('assetUploadId').isString().withMessage('Asset Upload ID is required.'),
    body('storageKey').isString().withMessage('Storage key is required for registration.'),
    body('size').isInt({ min: 1 }).toInt().withMessage('File size is required and must be > 0.'),
    body('sha256').optional().isString().withMessage('SHA256 hash must be a string.'),
];


/** Handles request for a pre-signed PUT URL. POST /assets/signed-upload-url */
export const getSignedUploadUrlController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const uploaderId = req.user!.sub;

        // 2. Service Call
        const result = await assetService.getSignedUploadUrl(uploaderId, req.body);

        // 3. Success (201 Created)
        return res.status(201).json(result);

    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error generating signed URL.' } });
    }
};

/** Handles registration of asset metadata after cloud upload. POST /assets/register */
export const registerAssetController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const uploaderId = req.user!.sub;

        // 2. Service Call
        const result = await assetService.registerAsset(uploaderId, req.body);

        // 3. Success (201 Created)
        return res.status(201).json(result);

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'SessionNotFoundOrUsed' || error.message === 'SessionExpired') {
            return res.status(404).json({ error: { code: 'session_invalid', message: 'Upload session not found, expired, or already used.' } });
        }
        if (error.message === 'PermissionDenied') {
            return res.status(403).json({ error: { code: 'uploader_mismatch', message: 'Authenticated user does not own the upload session.' } });
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during asset registration.' } });
    }
};
```

#### **19.5. `src/routes/asset.routes.ts` (New File)**

```typescript
// src/routes/asset.routes.ts
import { Router } from 'express';
import { 
    getSignedUploadUrlController, registerAssetController, 
    signedUploadValidation, registerAssetValidation 
} from '../controllers/asset.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();

// POST /assets/signed-upload-url - Request signed upload URL (Task 19)
router.post(
    '/signed-upload-url',
    authenticate, // Only authenticated users can start an upload session
    signedUploadValidation,
    getSignedUploadUrlController
);

// POST /assets/register - Register asset metadata after upload (Task 19)
router.post(
    '/register',
    authenticate,
    registerAssetValidation,
    registerAssetController
);


// NOTE: Future endpoints (GET /assets/:id, POST /assets/:id/version) will be added here.

export default router;
```

#### **19.6. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T19.1** | `POST /signed-upload-url` | Happy Path | Valid Filename/MimeType | **201 Created** | N/A (returns `assetUploadId`) |
| **T19.2** | `POST /signed-upload-url` | Fail: Invalid Mime Type | Invalid `mimeType` in body | **422 Unprocessable** | `validation_error` |
| **T19.3** | `POST /register` | Happy Path | Valid `assetUploadId`, `storageKey`, `size`, `sha256` | **201 Created** | N/A (returns `assetId`) |
| **T19.4** | `POST /register` | Fail: Missing Size/Key | Missing required fields in body | **422 Unprocessable** | `validation_error` |
| **T19.5** | `POST /register` | Fail: Used/Expired Session | Invalid `assetUploadId` | **404 Not Found** | `session_invalid` |

---
