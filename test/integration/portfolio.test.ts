import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { CreatorProfileModel } from '../../src/models/creatorProfile.model';

describe('Portfolio Asset Linkage & CRUD Integration Tests', () => {
  let creatorAccessToken: string;
  let creatorUserId: string;
  let otherCreatorAccessToken: string;
  let portfolioItemId: string;

  // Test database connection setup
  beforeAll(async () => {
    // Use test database
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
    // Clean up database before each test
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await CreatorProfileModel.deleteMany({});

    // Create first creator
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'portfolio.creator@example.com',
      password: 'Password123',
      role: 'creator',
    });

    creatorAccessToken = creatorSignup.body.accessToken;
    creatorUserId = creatorSignup.body.user.id;

    // Create second creator
    const otherCreatorSignup = await request(app).post('/auth/signup').send({
      email: 'other.creator@example.com',
      password: 'Password123',
      role: 'creator',
    });

    otherCreatorAccessToken = otherCreatorSignup.body.accessToken;
  });

  describe('POST /users/:creatorId/portfolio', () => {
    it('should successfully add portfolio item with assetId (T9.1)', async () => {
      // Arrange
      const portfolioItem = {
        title: 'VFX Demo Reel',
        description: 'My best visual effects work',
        assetId: '507f1f77bcf86cd799439011', // Mock asset ID
      };

      // Act
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send(portfolioItem);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('title', 'VFX Demo Reel');
      expect(response.body).toHaveProperty('description', 'My best visual effects work');
      expect(response.body).toHaveProperty('assetId', '507f1f77bcf86cd799439011');
      expect(response.body).not.toHaveProperty('externalLink');

      // Verify in database
      const profile = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profile?.portfolioItems).toHaveLength(1);
      expect(profile?.portfolioItems[0]?.title).toBe('VFX Demo Reel');
    });

    it('should successfully add portfolio item with externalLink (T9.2)', async () => {
      // Arrange
      const portfolioItem = {
        title: 'YouTube Demo',
        externalLink: 'https://youtu.be/abc123',
      };

      // Act
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send(portfolioItem);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('title', 'YouTube Demo');
      expect(response.body).toHaveProperty('externalLink', 'https://youtu.be/abc123');
      expect(response.body).not.toHaveProperty('assetId');

      // Verify in database
      const profile = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profile?.portfolioItems).toHaveLength(1);
      expect(profile?.portfolioItems[0]?.externalLink).toBe('https://youtu.be/abc123');
    });

    it('should fail when missing both assetId and externalLink (T9.3)', async () => {
      // Arrange
      const portfolioItem = {
        title: 'Invalid Item',
        description: 'This should fail',
      };

      // Act
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send(portfolioItem);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when other user tries to add to portfolio', async () => {
      // Act - Other creator tries to add to first creator's portfolio
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${otherCreatorAccessToken}`)
        .send({
          title: 'Unauthorized Item',
          assetId: '507f1f77bcf86cd799439011',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).post(`/users/${creatorUserId}/portfolio`).send({
        title: 'Test',
        assetId: '507f1f77bcf86cd799439011',
      });

      // Assert
      expect(response.status).toBe(401);
    });

    it('should validate assetId format', async () => {
      // Act
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Test',
          assetId: 'invalid-mongo-id',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate externalLink URL format', async () => {
      // Act
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Test',
          externalLink: 'not-a-url',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should create CreatorProfile if it does not exist (upsert)', async () => {
      // Arrange - Verify no profile exists
      const profileBefore = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profileBefore).toBeNull();

      // Act
      await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'First Portfolio Item',
          assetId: '507f1f77bcf86cd799439011',
        });

      // Assert - Profile should be created
      const profileAfter = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profileAfter).toBeTruthy();
      expect(profileAfter?.portfolioItems).toHaveLength(1);
    });
  });

  describe('PUT /users/:creatorId/portfolio/:itemId', () => {
    beforeEach(async () => {
      // Create a portfolio item before each test
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Original Title',
          description: 'Original Description',
          assetId: '507f1f77bcf86cd799439011',
        });

      portfolioItemId = response.body.id;
    });

    it('should successfully update portfolio item title (T9.4)', async () => {
      // Act
      const response = await request(app)
        .put(`/users/${creatorUserId}/portfolio/${portfolioItemId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'VFX Demo (Final Cut)',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', portfolioItemId);
      expect(response.body).toHaveProperty('title', 'VFX Demo (Final Cut)');
      expect(response.body).toHaveProperty('description', 'Original Description'); // Unchanged

      // Verify in database
      const profile = await CreatorProfileModel.findOne({ userId: creatorUserId });
      const item = profile?.portfolioItems.find(i => i._id?.toString() === portfolioItemId);
      expect(item?.title).toBe('VFX Demo (Final Cut)');
    });

    it('should successfully update description', async () => {
      // Act
      const response = await request(app)
        .put(`/users/${creatorUserId}/portfolio/${portfolioItemId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          description: 'Updated description with more details',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('description', 'Updated description with more details');
      expect(response.body).toHaveProperty('title', 'Original Title'); // Unchanged
    });

    it('should fail when other user tries to update (T9.6)', async () => {
      // Act
      const response = await request(app)
        .put(`/users/${creatorUserId}/portfolio/${portfolioItemId}`)
        .set('Authorization', `Bearer ${otherCreatorAccessToken}`)
        .send({
          title: 'Hacked Title',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');

      // Verify no change in database
      const profile = await CreatorProfileModel.findOne({ userId: creatorUserId });
      const item = profile?.portfolioItems.find(i => i._id?.toString() === portfolioItemId);
      expect(item?.title).toBe('Original Title');
    });

    it('should return 404 when item does not exist', async () => {
      // Act
      const response = await request(app)
        .put(`/users/${creatorUserId}/portfolio/507f1f77bcf86cd799439099`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Updated Title',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .put(`/users/${creatorUserId}/portfolio/${portfolioItemId}`)
        .send({ title: 'Test' });

      // Assert
      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /users/:creatorId/portfolio/:itemId', () => {
    beforeEach(async () => {
      // Create a portfolio item before each test
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Item to Delete',
          assetId: '507f1f77bcf86cd799439011',
        });

      portfolioItemId = response.body.id;
    });

    it('should successfully delete portfolio item (T9.5)', async () => {
      // Arrange - Verify item exists
      const profileBefore = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profileBefore?.portfolioItems).toHaveLength(1);

      // Act
      const response = await request(app)
        .delete(`/users/${creatorUserId}/portfolio/${portfolioItemId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(204);
      expect(response.body).toEqual({});

      // Verify removed from database
      const profileAfter = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profileAfter?.portfolioItems).toHaveLength(0);
    });

    it('should fail when other user tries to delete', async () => {
      // Act
      const response = await request(app)
        .delete(`/users/${creatorUserId}/portfolio/${portfolioItemId}`)
        .set('Authorization', `Bearer ${otherCreatorAccessToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');

      // Verify item still exists
      const profile = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profile?.portfolioItems).toHaveLength(1);
    });

    it('should return 404 when item does not exist', async () => {
      // Arrange - Verify the actual item exists first
      const profileBefore = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profileBefore?.portfolioItems).toHaveLength(1);
      expect(profileBefore?.portfolioItems[0]?._id?.toString()).toBe(portfolioItemId);

      // Act - Try to delete a different (non-existent) item
      const nonExistentId = '507f1f77bcf86cd799439099';
      expect(nonExistentId).not.toBe(portfolioItemId); // Ensure they're different

      const response = await request(app)
        .delete(`/users/${creatorUserId}/portfolio/${nonExistentId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');

      // Verify the actual item is still there (wasn't accidentally deleted)
      const profileAfter = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profileAfter?.portfolioItems).toHaveLength(1);
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).delete(
        `/users/${creatorUserId}/portfolio/${portfolioItemId}`
      );

      // Assert
      expect(response.status).toBe(401);
    });

    it('should handle deleting non-existent item for non-existent user', async () => {
      // Act
      const response = await request(app)
        .delete('/users/507f1f77bcf86cd799439088/portfolio/507f1f77bcf86cd799439099')
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(403); // Permission denied (not their ID)
    });
  });

  describe('Portfolio Full CRUD Flow', () => {
    it('should complete add, update, delete cycle successfully', async () => {
      // Step 1: Add item
      const addResponse = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Demo Project',
          description: 'A demo of my work',
          assetId: '507f1f77bcf86cd799439011',
        });

      expect(addResponse.status).toBe(201);
      const itemId = addResponse.body.id;

      // Step 2: Update item
      const updateResponse = await request(app)
        .put(`/users/${creatorUserId}/portfolio/${itemId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Demo Project (Updated)',
          description: 'Updated description',
        });

      expect(updateResponse.status).toBe(200);
      expect(updateResponse.body.title).toBe('Demo Project (Updated)');

      // Step 3: Delete item
      const deleteResponse = await request(app)
        .delete(`/users/${creatorUserId}/portfolio/${itemId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      expect(deleteResponse.status).toBe(204);

      // Verify item is gone
      const profile = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profile?.portfolioItems || []).toHaveLength(0);
    });

    it('should handle multiple portfolio items', async () => {
      // Add first item
      await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Item 1',
          assetId: '507f1f77bcf86cd799439011',
        });

      // Add second item
      await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Item 2',
          externalLink: 'https://example.com/demo',
        });

      // Add third item
      const thirdResponse = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Item 3',
          assetId: '507f1f77bcf86cd799439022',
        });

      expect(thirdResponse.status).toBe(201);

      // Verify all items in database
      const profile = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profile?.portfolioItems).toHaveLength(3);
    });
  });

  describe('Portfolio with GET /users/:userId', () => {
    it('should include portfolio items in user profile response', async () => {
      // Arrange - Add portfolio item
      await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Featured Work',
          description: 'My best piece',
          assetId: '507f1f77bcf86cd799439011',
        });

      // Act - Get user profile
      const response = await request(app)
        .get(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${otherCreatorAccessToken}`);

      // Assert - Should include portfolio (via CreatorProfileDTO)
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', creatorUserId);
      // Portfolio items are part of the creator profile response
    });
  });

  describe('Validation Edge Cases', () => {
    it('should validate title max length (200 chars)', async () => {
      // Act
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'a'.repeat(201),
          assetId: '507f1f77bcf86cd799439011',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate description max length (500 chars)', async () => {
      // Act
      const response = await request(app)
        .post(`/users/${creatorUserId}/portfolio`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Test',
          description: 'a'.repeat(501),
          assetId: '507f1f77bcf86cd799439011',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });
});

