import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { AssetModel } from '../../src/models/asset.model';
import { AssetUploadSessionModel } from '../../src/models/assetUploadSession.model';

describe('Asset Management (Update/Delete/List) Integration Tests', () => {
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
        size: 1024000,
        sha256: 'abc123hash',
      });

    assetId = registerResponse.body.assetId;
  });

  describe('PUT /assets/:assetId', () => {
    it('T22.1 - should successfully update asset metadata (uploader)', async () => {
      // Act
      const response = await request(app)
        .put(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'updated-video.mp4',
          isSensitive: true,
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('assetId', assetId);
      expect(response.body).toHaveProperty('filename', 'updated-video.mp4');
      expect(response.body).toHaveProperty('isSensitive', true);
      expect(response.body).toHaveProperty('updatedAt');

      // Verify asset updated in database
      const asset = await AssetModel.findById(assetId);
      expect(asset?.filename).toBe('updated-video.mp4');
      expect(asset?.isSensitive).toBe(true);
    });

    it('should fail when non-uploader tries to update (403)', async () => {
      // Act
      const response = await request(app)
        .put(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${memberToken}`) // Member, but not uploader
        .send({
          filename: 'unauthorized-update.mp4',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');

      // Verify asset not changed
      const asset = await AssetModel.findById(assetId);
      expect(asset?.filename).toBe('test-video.mp4');
    });

    it('should allow admin to update any asset', async () => {
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
        .put(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          filename: 'admin-updated.mp4',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.filename).toBe('admin-updated.mp4');
    });

    it('should validate filename length (max 1024 chars)', async () => {
      // Act
      const longFilename = 'a'.repeat(1025) + '.mp4';
      const response = await request(app)
        .put(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: longFilename,
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate isSensitive is boolean', async () => {
      // Act
      const response = await request(app)
        .put(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          isSensitive: 'not-boolean',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 404 for non-existent asset', async () => {
      // Act
      const response = await request(app)
        .put(`/assets/${new mongoose.Types.ObjectId()}`)
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'new-name.mp4',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).put(`/assets/${assetId}`).send({
        filename: 'test.mp4',
      });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('DELETE /assets/:assetId', () => {
    it('T22.2 - should successfully soft-delete asset (uploader)', async () => {
      // Act
      const response = await request(app)
        .delete(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${uploaderToken}`);

      // Assert
      expect(response.status).toBe(204);

      // Verify soft delete
      const asset = await AssetModel.findById(assetId);
      expect(asset?.isDeleted).toBe(true);
      expect(asset?.deletedAt).toBeDefined();
    });

    it('T22.3 - should fail when non-uploader tries to delete (403)', async () => {
      // Arrange - Create new asset
      const urlResponse = await request(app)
        .post('/assets/signed-upload-url')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          filename: 'another-video.mp4',
          mimeType: 'video/mp4',
          projectId: projectId,
        });

      const assetUploadId = urlResponse.body.assetUploadId;
      const storageKey = `uploads/${projectId}/${uploaderId}/${Date.now()}-another-video.mp4`;

      const registerResponse = await request(app)
        .post('/assets/register')
        .set('Authorization', `Bearer ${uploaderToken}`)
        .send({
          assetUploadId,
          storageKey,
          size: 512000,
          sha256: 'hash123',
        });

      const newAssetId = registerResponse.body.assetId;

      // Act
      const response = await request(app)
        .delete(`/assets/${newAssetId}`)
        .set('Authorization', `Bearer ${memberToken}`); // Member, but not uploader

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');

      // Verify asset not deleted
      const asset = await AssetModel.findById(newAssetId);
      expect(asset?.isDeleted).toBe(false);
    });

    it('should prevent deleted asset from being retrieved', async () => {
      // Arrange - Soft delete asset
      await request(app)
        .delete(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${uploaderToken}`);

      // Act - Try to retrieve deleted asset
      const response = await request(app)
        .get(`/assets/${assetId}`)
        .set('Authorization', `Bearer ${uploaderToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should return 404 for non-existent asset', async () => {
      // Act
      const response = await request(app)
        .delete(`/assets/${new mongoose.Types.ObjectId()}`)
        .set('Authorization', `Bearer ${uploaderToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).delete(`/assets/${assetId}`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('GET /projects/:projectId/assets', () => {
    beforeEach(async () => {
      // Create multiple assets for listing tests
      for (let i = 0; i < 5; i++) {
        const urlResponse = await request(app)
          .post('/assets/signed-upload-url')
          .set('Authorization', `Bearer ${uploaderToken}`)
          .send({
            filename: `asset-${i}.mp4`,
            mimeType: 'video/mp4',
            projectId: projectId,
          });

        const assetUploadId = urlResponse.body.assetUploadId;
        const storageKey = `uploads/${projectId}/${uploaderId}/${Date.now()}-asset-${i}.mp4`;

        await request(app)
          .post('/assets/register')
          .set('Authorization', `Bearer ${uploaderToken}`)
          .send({
            assetUploadId,
            storageKey,
            size: 1024000 * (i + 1),
            sha256: `hash${i}`,
          });
      }
    });

    it('T22.4 - should successfully list project assets (member)', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/assets`)
        .set('Authorization', `Bearer ${memberToken}`)
        .query({ page: 1, per_page: 10 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.meta).toHaveProperty('page', 1);
      expect(response.body.meta).toHaveProperty('per_page');
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta).toHaveProperty('total_pages');

      // Verify all assets are non-deleted
      response.body.data.forEach((asset: any) => {
        expect(asset).toHaveProperty('assetId');
        expect(asset).toHaveProperty('filename');
        expect(asset).toHaveProperty('mimeType');
        expect(asset).toHaveProperty('uploaderId');
        expect(asset).toHaveProperty('createdAt');
      });
    });

    it('T22.5 - should fail when non-member tries to list (403)', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/assets`)
        .set('Authorization', `Bearer ${nonMemberToken}`)
        .query({ page: 1, per_page: 10 });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should support pagination', async () => {
      // Act - First page
      const firstPage = await request(app)
        .get(`/projects/${projectId}/assets`)
        .set('Authorization', `Bearer ${memberToken}`)
        .query({ page: 1, per_page: 3 });

      expect(firstPage.status).toBe(200);
      expect(firstPage.body.data.length).toBe(3);
      expect(firstPage.body.meta.page).toBe(1);

      // Act - Second page
      const secondPage = await request(app)
        .get(`/projects/${projectId}/assets`)
        .set('Authorization', `Bearer ${memberToken}`)
        .query({ page: 2, per_page: 3 });

      expect(secondPage.status).toBe(200);
      expect(secondPage.body.data.length).toBeGreaterThan(0);
      expect(secondPage.body.meta.page).toBe(2);
    });

    it('should support mimeType filtering', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/assets`)
        .set('Authorization', `Bearer ${memberToken}`)
        .query({ mimeType: 'video/mp4' });

      // Assert
      expect(response.status).toBe(200);
      response.body.data.forEach((asset: any) => {
        expect(asset.mimeType).toBe('video/mp4');
      });
    });

    it('should exclude soft-deleted assets', async () => {
      // Arrange - Delete one asset
      const assets = await AssetModel.find({ projectId: new mongoose.Types.ObjectId(projectId), isDeleted: false });
      const firstAsset = assets[0];
      if (assets.length > 0 && firstAsset && firstAsset._id) {
        const deletedAssetId = firstAsset._id.toString();
        await AssetModel.updateOne(
          { _id: firstAsset._id },
          { $set: { isDeleted: true, deletedAt: new Date() } }
        );

        // Act
        const response = await request(app)
          .get(`/projects/${projectId}/assets`)
          .set('Authorization', `Bearer ${memberToken}`)
          .query({ page: 1, per_page: 100 });

        // Assert
        expect(response.status).toBe(200);
        // Verify deleted asset is not in results
        response.body.data.forEach((asset: any) => {
          expect(asset.assetId).not.toBe(deletedAssetId);
        });
      }
    });

    it('should return 404 for non-existent project', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${new mongoose.Types.ObjectId()}/assets`)
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).get(`/projects/${projectId}/assets`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });
});

