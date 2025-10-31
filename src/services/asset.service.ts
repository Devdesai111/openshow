import { AssetModel, IAsset, IAssetVersion } from '../models/asset.model';
import { AssetUploadSessionModel } from '../models/assetUploadSession.model';
import { ProjectModel, IProject } from '../models/project.model';
import { IAuthUser } from '../middleware/auth.middleware';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

// --- Mocks/Constants ---
const SIGNED_URL_TTL_S = 900; // 15 minutes (upload)
const DOWNLOAD_URL_TTL_S = 300; // 5 minutes (download)
const SIGNED_URL_MOCK = 'https://s3.amazonaws.com/mock-bucket/temp/';

// Mock AWS SDK/Cloud Client for Pre-signing
class CloudStorageService {
  public getPutSignedUrl(key: string, _mimeType: string, ttl: number): string {
    // PRODUCTION: Use AWS.S3.getSignedUrl() or equivalent
    return `${SIGNED_URL_MOCK}${key}?X-Amz-Signature=mock_signature&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=${ttl}`;
  }

  public getGetSignedUrl(key: string, _mimeType: string, ttl: number): string {
    // PRODUCTION: Use AWS.S3.getSignedUrl() for GET operations
    return `${SIGNED_URL_MOCK}${key}?X-Amz-Signature=mock_signature&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=${ttl}`;
  }

  public generateStorageKey(projectId: string | undefined, uploaderId: string, filename: string): string {
    // Deterministic key generation
    const safeFilename = filename.replace(/\s/g, '_').toLowerCase();
    const prefix = projectId || 'profile';
    return `uploads/${prefix}/${uploaderId}/${Date.now()}-${safeFilename}`;
  }
}
const cloudStorageService = new CloudStorageService();

// Mock Job/Event Emitter
class MockJobQueue {
  public enqueueThumbnailJob(assetId: string): void {
    console.warn(`[Job Enqueued] Thumbnail creation for Asset ${assetId}.`);
  }
}
const jobQueue = new MockJobQueue();

export class AssetService {
  /**
   * Issues a signed URL for a client to upload directly to cloud storage.
   * @param uploaderId - User ID initiating the upload
   * @param data - Upload request data
   * @returns Signed upload URL response
   */
  public async getSignedUploadUrl(uploaderId: string, data: {
    filename: string;
    mimeType: string;
    projectId?: string;
    expectedSha256?: string;
  }): Promise<{
    assetUploadId: string;
    uploadUrl: string;
    uploadMethod: string;
    expiresAt: string;
    storageKeyHint?: string;
  }> {
    const { filename, mimeType, projectId, expectedSha256 } = data;

    // 1. Generate unique IDs and secure storage key
    const assetUploadId = `upl_${crypto.randomBytes(10).toString('hex')}`;
    const storageKey = cloudStorageService.generateStorageKey(projectId, uploaderId, filename);

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

  /**
   * Registers the asset metadata after the client's successful cloud upload.
   * @param uploaderId - User ID registering the asset
   * @param data - Registration data
   * @returns Registered asset response
   * @throws {Error} - 'SessionNotFoundOrUsed', 'SessionExpired', 'PermissionDenied'
   */
  public async registerAsset(uploaderId: string, data: {
    assetUploadId: string;
    storageKey: string;
    size: number;
    sha256?: string;
  }): Promise<{
    assetId: string;
    versionNumber: number;
    processed: boolean;
    createdAt: string;
  }> {
    const { assetUploadId, storageKey, size, sha256 } = data;

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
      sha256: sha256 || session.expectedSha256 || 'not_provided',
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
    console.warn(`[Event] Asset ${savedAsset._id!.toString()} registered and thumbnail job queued.`);

    return {
      assetId: savedAsset._id!.toString(),
      versionNumber: 1,
      processed: false,
      createdAt: savedAsset.createdAt!.toISOString(),
    };
  }

  /**
   * Checks permission for viewing and downloading an asset.
   * @returns The Asset document.
   * @throws {Error} 'AssetNotFound', 'PermissionDenied'.
   */
  private async checkAssetAccess(
    assetId: string,
    requesterId: string,
    requesterRole: IAuthUser['role']
  ): Promise<IAsset> {
    const asset = await AssetModel.findById(new Types.ObjectId(assetId)).lean() as IAsset | null;
    if (!asset) {
      throw new Error('AssetNotFound');
    }

    const isUploader = asset.uploaderId.toString() === requesterId;
    const isAdmin = requesterRole === 'admin';
    let isMember = false;

    // Check project membership if asset is linked to a project
    if (asset.projectId) {
      const project = (await ProjectModel.findById(asset.projectId)
        .select('teamMemberIds visibility')
        .lean()) as IProject | null;
      
      if (project) {
        isMember = project.teamMemberIds.some(id => id.toString() === requesterId);

        // For private projects, only members, uploader, or admin can access
        if (project.visibility === 'private' && !isMember && !isUploader && !isAdmin) {
          throw new Error('PermissionDenied');
        }
        // For public projects, anyone can access (fall through to final check)
      }
    }

    // Final check: if not uploader, not member (of project), and not admin, then access denied
    // This handles profile assets (no projectId) and public projects
    if (!isUploader && !isMember && !isAdmin) {
      // NOTE: In a full implementation, public access rules (e.g. public portfolio) would be checked here
      throw new Error('PermissionDenied');
    }

    return asset;
  }

  /**
   * Appends a new version entry to an existing asset.
   * @param assetId - Asset ID to add version to
   * @param uploaderId - User ID adding the version (must be uploader or admin)
   * @param data - Version data
   * @returns New version response
   * @throws {Error} - 'AssetNotFound', 'PermissionDenied', 'UpdateFailed'
   */
  public async addNewVersion(
    assetId: string,
    uploaderId: string,
    uploaderRole: IAuthUser['role'],
    data: {
      storageKey: string;
      size: number;
      sha256: string;
    }
  ): Promise<{
    assetId: string;
    versionNumber: number;
    createdAt: string;
  }> {
    const { storageKey, size, sha256 } = data;
    const assetObjectId = new Types.ObjectId(assetId);

    // 1. Check uploader ownership (or Admin)
    const asset = await AssetModel.findById(assetObjectId);
    if (!asset) {
      throw new Error('AssetNotFound');
    }
    if (asset.uploaderId.toString() !== uploaderId && uploaderRole !== 'admin') {
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
        $set: { processed: false }, // Reset processing flag for new version
      },
      { new: true }
    );

    if (!updatedAsset) {
      throw new Error('UpdateFailed');
    }

    // 4. Trigger thumbnail job for the new version
    jobQueue.enqueueThumbnailJob(updatedAsset._id!.toString());

    // PRODUCTION: Emit 'asset.version.added' event
    console.warn(`[Event] Asset ${assetId} new version ${newVersion.versionNumber} registered.`);

    return {
      assetId: updatedAsset._id!.toString(),
      versionNumber: newVersion.versionNumber,
      createdAt: newVersion.createdAt.toISOString(),
    };
  }

  /**
   * Retrieves asset metadata and a secure download URL if authorized.
   * @param assetId - Asset ID to retrieve
   * @param requesterId - User ID requesting the asset
   * @param requesterRole - User role for permission check
   * @param presign - Whether to generate a signed download URL
   * @returns Asset metadata with optional download URL
   * @throws {Error} - 'AssetNotFound', 'PermissionDenied', 'NoVersionData'
   */
  public async getAssetAndSignedDownloadUrl(
    assetId: string,
    requesterId: string,
    requesterRole: IAuthUser['role'],
    presign: boolean = true
  ): Promise<{
    assetId: string;
    filename: string;
    mimeType: string;
    uploaderId: string;
    size: number;
    sha256: string;
    processed: boolean;
    versionsCount: number;
    downloadUrl?: string | null;
    downloadUrlExpiresAt?: string | null;
    createdAt: string;
  }> {
    // 1. Check Access (throws 404/403 if unauthorized)
    const asset = await this.checkAssetAccess(assetId, requesterId, requesterRole);

    // 2. Get the latest version's metadata
    const latestVersion = asset.versions[asset.versions.length - 1];
    if (!latestVersion) {
      throw new Error('NoVersionData');
    }

    let downloadUrl: string | null = null;
    let expiresAt: string | null = null;

    // 3. Generate Signed URL if requested
    if (presign) {
      downloadUrl = cloudStorageService.getGetSignedUrl(
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

