import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { AssetModel } from '../../src/models/asset.model';
import { AssetUploadSessionModel } from '../../src/models/assetUploadSession.model';

describe('Asset Upload (Signed URL & Register) Integration Tests', () => {
  let uploaderToken: string;
  let uploaderId: string;
  let otherUserToken: string;
  let projectId: string;

  beforeAll(async () => {
    const testDbUri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/openshow-test';
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    await mongoose.connect(testDbUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Clean up database
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await AssetModel.deleteMany({});
    await AssetUploadSessionModel.deleteMany({});

    // Create uploader user
    const uploaderSignup = await request(app).post('/auth/signup').send({
      email: 'uploader@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'File Uploader',
    });
    uploaderToken = uploaderSignup.body.accessToken;
    uploaderId = uploaderSignup.body.user.id;

    // Create other user
    const otherSignup = await request(app).post('/auth/signup').send({
      email: 'other@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Other User',
    });
    otherUserToken = otherSignup.body.accessToken;

    // Create project
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${uploaderToken}`)
      .send({
        title: 'Asset Test Project',
        category: 'Film Production',
        visibility: 'private',
        roles: [{ title: 'Director', slots: 1 }],
        revenueModel: { splits: [{ placeholder: 'Director', percentage: 100 }] },
      });
    projectId = projectResponse.body.projectId;
  });

  describe('POST /assets/signed-upload-url', () => {
    it('T19.1 - should return signed upload URL with assetUploadId (happy path)', async () => {
      // Act
      const response = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'test-video.mp4',
          mimeType: 'video/mp4',
          projectId: projectId,
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('assetUploadId');
      expect(response.body).toHaveProperty('uploadUrl');
      expect(response.body).toHaveProperty('uploadMethod', 'PUT');
      expect(response.body).toHaveProperty('expiresAt');
      expect(response.body.assetUploadId).toMatch(/^upl_/);

      // Verify session record created
      const session = await AssetUploadSessionModel.findOne({ assetUploadId: response.body.assetUploadId });
      expect(session).toBeDefined();
      expect(session?.filename).toBe('test-video.mp4');
      expect(session?.mimeType).toBe('video/mp4');
      expect(session?.isUsed).toBe(false);
      expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('T19.2 - should return 422 for invalid mime type', async () => {
      // Act
      const response = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'test-file.txt',
          mimeType: 'invalid/mime/type',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate filename length (max 1024 chars)', async () => {
      // Arrange - Create filename > 1024 chars
      const longFilename = 'a'.repeat(1025) + '.jpg';

      // Act
      const response = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: longFilename,
          mimeType: 'image/jpeg',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate filename is required', async () => {
      // Act
      const response = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          mimeType: 'image/jpeg',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should support optional projectId', async () => {
      // Act - Without projectId (profile upload)
      const response = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'profile.jpg',
          mimeType: 'image/jpeg',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('assetUploadId');

      const session = await AssetUploadSessionModel.findOne({ assetUploadId: response.body.assetUploadId });
      expect(session?.projectId).toBeUndefined();
    });

    it('should support optional expectedSha256', async () => {
      // Act
      const response = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'test-file.pdf',
          mimeType: 'application/pdf',
          expectedSha256: 'abc123def456',
        });

      // Assert
      expect(response.status).toBe(201);
      const session = await AssetUploadSessionModel.findOne({ assetUploadId: response.body.assetUploadId });
      expect(session?.expectedSha256).toBe('abc123def456');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post('/assets/signed-upload-url')
        .send({
          filename: 'test.jpg',
          mimeType: 'image/jpeg',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /assets/register', () => {
    let assetUploadId: string;
    let storageKey: string;

    beforeEach(async () => {
      // Create an upload session
      const sessionResponse = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'test-video.mp4',
          mimeType: 'video/mp4',
          projectId: projectId,
        });

      assetUploadId = sessionResponse.body.assetUploadId;
      // Extract storage key from hint (in production, client would know this from S3 response)
      storageKey = `uploads/${projectId}/${uploaderId}/${Date.now()}-test-video.mp4`;
    });

    it('T19.3 - should successfully register asset after upload (happy path)', async () => {
      // Act
      const response = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId,
          storageKey,
          size: 1024000, // 1MB in bytes
          sha256: 'abc123def456hash',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('assetId');
      expect(response.body).toHaveProperty('versionNumber', 1);
      expect(response.body).toHaveProperty('processed', false);
      expect(response.body).toHaveProperty('createdAt');

      // Verify asset record created
      const asset = await AssetModel.findById(response.body.assetId);
      expect(asset).toBeDefined();
      expect(asset?.filename).toBe('test-video.mp4');
      expect(asset?.mimeType).toBe('video/mp4');
      expect(asset?.versions).toHaveLength(1);
      expect(asset?.versions[0]?.versionNumber).toBe(1);
      expect(asset?.versions[0]?.storageKey).toBe(storageKey);
      expect(asset?.versions[0]?.size).toBe(1024000);
      expect(asset?.processed).toBe(false);

      // Verify session marked as used
      const session = await AssetUploadSessionModel.findOne({ assetUploadId });
      expect(session?.isUsed).toBe(true);
    });

    it('T19.4 - should return 422 for missing required fields', async () => {
      // Act - Missing size
      const response = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId,
          storageKey,
          // Missing size
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('T19.5 - should return 404 for invalid/expired/used session', async () => {
      // Arrange - Use the session once
      await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId,
          storageKey,
          size: 1024000,
          sha256: 'hash1',
        });

      // Act - Try to use it again
      const response = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId,
          storageKey: 'different-key',
          size: 2048000,
          sha256: 'hash2',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should return 404 for non-existent assetUploadId', async () => {
      // Act
      const response = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId: 'upl_nonexistent',
          storageKey,
          size: 1024000,
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should return 403 when other user tries to register', async () => {
      // Act
      const response = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${otherUserToken}`)
        .send({
          assetUploadId,
          storageKey,
          size: 1024000,
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should validate size > 0', async () => {
      // Act
      const response = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId,
          storageKey,
          size: 0, // Invalid size
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post('/assets/register')
        .send({
          assetUploadId,
          storageKey,
          size: 1024000,
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should use expectedSha256 if sha256 not provided', async () => {
      // Arrange - Create session with expectedSha256
      const sessionResponse = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'test-file.pdf',
          mimeType: 'application/pdf',
          expectedSha256: 'expected-hash-123',
        });

      const newAssetUploadId = sessionResponse.body.assetUploadId;
      const newStorageKey = `uploads/profile/${uploaderId}/${Date.now()}-test-file.pdf`;

      // Act - Register without sha256
      const response = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId: newAssetUploadId,
          storageKey: newStorageKey,
          size: 512000,
          // sha256 not provided
        });

      // Assert
      expect(response.status).toBe(201);
      const asset = await AssetModel.findById(response.body.assetId);
      expect(asset?.versions[0]?.sha256).toBe('expected-hash-123');
    });
  });

  describe('Two-Step Upload Flow', () => {
    it('should complete full two-step flow successfully', async () => {
      // Step 1: Request signed URL
      const urlResponse = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'final-video.mp4',
          mimeType: 'video/mp4',
          projectId: projectId,
        });

      expect(urlResponse.status).toBe(201);
      const { assetUploadId, uploadUrl } = urlResponse.body;
      expect(uploadUrl).toContain('mock-bucket'); // Verify mock URL

      // Step 2: Simulate client upload to S3 (mocked)
      // In production, client would PUT to uploadUrl

      // Step 3: Register asset
      const registerResponse = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId,
          storageKey: `uploads/${projectId}/${uploaderId}/${Date.now()}-final-video.mp4`,
          size: 2048000,
          sha256: 'final-hash-abc123',
        });

      expect(registerResponse.status).toBe(201);
      expect(registerResponse.body).toHaveProperty('assetId');

      // Verify final state
      const asset = await AssetModel.findById(registerResponse.body.assetId);
      expect(asset).toBeDefined();
      expect(asset?.filename).toBe('final-video.mp4');
      expect(asset?.projectId?.toString()).toBe(projectId);

      const session = await AssetUploadSessionModel.findOne({ assetUploadId });
      expect(session?.isUsed).toBe(true);
    });

    it('should handle expired session gracefully', async () => {
      // Arrange - Create session and manually expire it
      const urlResponse = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'expired-test.jpg',
          mimeType: 'image/jpeg',
        });

      const assetUploadId = urlResponse.body.assetUploadId;

      // Manually expire the session
      await AssetUploadSessionModel.updateOne(
        { assetUploadId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } } // Expired 1 second ago
      );

      // Act - Try to register
      const response = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId,
          storageKey: 'uploads/test.jpg',
          size: 1024000,
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });
  });
});

