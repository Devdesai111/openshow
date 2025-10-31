import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { AssetModel } from '../../src/models/asset.model';
import { AssetUploadSessionModel } from '../../src/models/assetUploadSession.model';

describe('Asset Versioning & Download Access Integration Tests', () => {
  let uploaderToken: string;
  let uploaderId: string;
  let memberToken: string;
  let memberId: string;
  let nonMemberToken: string;
  let projectId: string;
  let assetId: string;

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

    // Create member user
    const memberSignup = await request(app).post('/auth/signup').send({
      email: 'member@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Project Member',
    });
    memberToken = memberSignup.body.accessToken;
    memberId = memberSignup.body.user.id;

    // Create non-member user
    const nonMemberSignup = await request(app).post('/auth/signup').send({
      email: 'nonmember@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Non Member',
    });
    nonMemberToken = nonMemberSignup.body.accessToken;

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

    // Add member to project
    await ProjectModel.findByIdAndUpdate(projectId, {
      $push: { teamMemberIds: new mongoose.Types.ObjectId(memberId) },
    });

    // Create an asset for testing
    const urlResponse = await request(app)
      .post('/assets/signed-upload-url')
      .set('Authorization', `Bearer ${uploaderToken}`)
      .send({
        filename: 'test-video.mp4',
        mimeType: 'video/mp4',
        projectId: projectId,
      });

    const assetUploadId = urlResponse.body.assetUploadId;
    const storageKey = `uploads/${projectId}/${uploaderId}/${Date.now()}-test-video.mp4`;

    const registerResponse = await request(app)
      .post('/assets/register')
      .set('Authorization', `Bearer ${uploaderToken}`)
      .send({
        assetUploadId,
        storageKey,
        size: 1024000, // 1MB
        sha256: 'abc123hash',
      });

    assetId = registerResponse.body.assetId;
  });

  describe('POST /assets/:assetId/version', () => {
    it('T20.1 - should successfully add new version (uploader)', async () => {
      // Act
      const response = await request(app)
        .post(`/assets/${assetId}/version`)
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          storageKey: `uploads/${projectId}/${uploaderId}/${Date.now()}-updated-video.mp4`,
          size: 2048000, // 2MB
          sha256: 'def456hash',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('assetId', assetId);
      expect(response.body).toHaveProperty('versionNumber', 2);
      expect(response.body).toHaveProperty('createdAt');

      // Verify asset has 2 versions
      const asset = await AssetModel.findById(assetId);
      expect(asset?.versions).toHaveLength(2);
      expect(asset?.versions[1]?.versionNumber).toBe(2);
      expect(asset?.versions[1]?.size).toBe(2048000);
      expect(asset?.processed).toBe(false); // Should reset processing flag
    });

    it('T20.2 - should fail when non-uploader tries to add version (403)', async () => {
      // Act
      const response = await request(app)
        .post(`/assets/${assetId}/version`)
        .set('Authorization', `Bearer ${memberToken}`) // Member, but not uploader
        .send({
          storageKey: `uploads/${projectId}/${memberId}/${Date.now()}-unauthorized-version.mp4`,
          size: 512000,
          sha256: 'unauthorized-hash',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');

      // Verify asset still has 1 version
      const asset = await AssetModel.findById(assetId);
      expect(asset?.versions).toHaveLength(1);
    });

    it('should allow admin to add version', async () => {
      // Arrange - Create admin user
      await request(app).post('/auth/signup').send({
        email: 'admin@example.com',
        password: 'Password123',
        role: 'creator',
        fullName: 'Admin User',
      });
      await UserModel.updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
      const adminLogin = await request(app).post('/auth/login').send({
        email: 'admin@example.com',
        password: 'Password123',
      });
      const adminToken = adminLogin.body.accessToken;

      // Act
      const response = await request(app)
        .post(`/assets/${assetId}/version`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          storageKey: `uploads/${projectId}/${uploaderId}/${Date.now()}-admin-version.mp4`,
          size: 1536000,
          sha256: 'admin-hash',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('versionNumber', 2);
    });

    it('should validate required fields', async () => {
      // Act - Missing sha256
      const response = await request(app)
        .post(`/assets/${assetId}/version`)
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          storageKey: 'uploads/test.mp4',
          size: 1024000,
          // Missing sha256
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 404 for non-existent asset', async () => {
      // Act
      const response = await request(app)
        .post(`/assets/${new mongoose.Types.ObjectId()}/version`)
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          storageKey: 'uploads/test.mp4',
          size: 1024000,
          sha256: 'test-hash',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });
  });

  describe('GET /assets/:assetId', () => {
    it('T20.3 - should return asset metadata with download URL (project member)', async () => {
      // Act
      const response = await request(app)
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${memberToken}`)
        .query({ presign: true });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('assetId', assetId);
      expect(response.body).toHaveProperty('filename', 'test-video.mp4');
      expect(response.body).toHaveProperty('mimeType', 'video/mp4');
      expect(response.body).toHaveProperty('downloadUrl');
      expect(response.body).toHaveProperty('downloadUrlExpiresAt');
      expect(response.body).toHaveProperty('uploaderId');
      expect(response.body).toHaveProperty('size');
      expect(response.body).toHaveProperty('sha256');
      expect(response.body).toHaveProperty('versionsCount', 1);
      expect(response.body.downloadUrl).toContain('mock-bucket');
    });

    it('T20.4 - should return 403 for non-member accessing private project asset', async () => {
      // Act
      const response = await request(app)
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${nonMemberToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('T20.5 - should return 404 for non-existent asset', async () => {
      // Act
      const response = await request(app)
        .get(`/assets/${new mongoose.Types.ObjectId()}`)
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should allow uploader to access their own asset', async () => {
      // Act
      const response = await request(app)
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${uploaderToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('assetId', assetId);
      expect(response.body).toHaveProperty('downloadUrl');
    });

    it('should support presign=false query parameter', async () => {
      // Act
      const response = await request(app)
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${memberToken}`)
        .query({ presign: false });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('assetId');
      expect(response.body.downloadUrl).toBeNull();
      expect(response.body.downloadUrlExpiresAt).toBeNull();
    });

    it('should return latest version metadata', async () => {
      // Arrange - Add a new version
      await request(app)
        .post(`/assets/${assetId}/version`)
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          storageKey: `uploads/${projectId}/${uploaderId}/${Date.now()}-v2.mp4`,
          size: 3072000, // 3MB (larger than v1)
          sha256: 'v2-hash',
        });

      // Act
      const response = await request(app)
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('versionsCount', 2);
      expect(response.body.size).toBe(3072000); // Latest version size
      expect(response.body.sha256).toBe('v2-hash'); // Latest version hash
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).get(`/assets/${assetId}`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });
});

