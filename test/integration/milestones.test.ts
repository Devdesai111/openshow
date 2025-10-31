import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';

describe('Project Milestones Integration Tests', () => {
  let ownerAccessToken: string;
  let ownerUserId: string;
  let creatorAccessToken: string;
  let creatorUserId: string;
  let adminAccessToken: string;
  let adminUserId: string;
  let projectId: string;
  let milestoneId: string;

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

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerAccessToken = ownerSignup.body.accessToken;
    ownerUserId = ownerSignup.body.user.id;

    // Create creator user
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Creator User',
    });
    creatorAccessToken = creatorSignup.body.accessToken;
    creatorUserId = creatorSignup.body.user.id;

    // Create admin user
    const adminSignup = await request(app).post('/auth/signup').send({
      email: 'admin@example.com',
      password: 'AdminPassword123',
      role: 'creator',
    });
    adminUserId = adminSignup.body.user.id;

    // Update to admin role and re-login
    await UserModel.findByIdAndUpdate(adminUserId, { role: 'admin' });
    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@example.com',
      password: 'AdminPassword123',
    });
    adminAccessToken = adminLogin.body.accessToken;

    // Create test project
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({
        title: 'Test Project with Milestones',
        category: 'Film Production',
        roles: [
          { title: 'Director', slots: 1 },
          { title: 'Editor', slots: 1 },
        ],
        revenueModel: {
          splits: [{ placeholder: 'Owner', percentage: 100 }],
        },
      });

    projectId = projectResponse.body.projectId;

    // Assign creator to project as team member
    const project = await ProjectModel.findById(projectId);
    const editorRoleId = project?.roles[1]?._id?.toString();
    if (editorRoleId) {
      await request(app)
        .post(`/projects/${projectId}/roles/${editorRoleId}/assign`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: creatorUserId });
    }
  });

  describe('POST /projects/:projectId/milestones', () => {
    it('T14.1 - should successfully create milestone (owner access)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Pre-production Complete',
          description: 'All planning and preparation finished',
          amount: 50000, // $500 in cents
          currency: 'USD',
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('milestoneId');
      expect(response.body).toHaveProperty('title', 'Pre-production Complete');
      expect(response.body).toHaveProperty('amount', 50000);
      expect(response.body).toHaveProperty('currency', 'USD');
      expect(response.body).toHaveProperty('status', 'pending');
      expect(response.body).toHaveProperty('createdAt');

      // Store milestone ID for other tests
      milestoneId = response.body.milestoneId;

      // Verify database record
      const project = await ProjectModel.findById(projectId);
      expect(project?.milestones).toHaveLength(1);
      expect(project?.milestones[0]?.title).toBe('Pre-production Complete');
    });

    it('should fail when non-owner tries to create milestone (403)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Unauthorized Milestone',
          amount: 10000,
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should validate required fields', async () => {
      // Act - Missing title
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          amount: 10000,
          // Missing title
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate amount is non-negative', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Invalid Amount Milestone',
          amount: -1000, // Negative amount
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should allow admin to create milestones', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          title: 'Admin Created Milestone',
          amount: 25000,
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('milestoneId');
    });
  });

  describe('PUT /projects/:projectId/milestones/:milestoneId', () => {
    beforeEach(async () => {
      // Create a milestone for update tests
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Original Milestone',
          amount: 30000,
          currency: 'USD',
        });
      milestoneId = response.body.milestoneId;
    });

    it('T14.2 - should successfully update milestone (owner access)', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${projectId}/milestones/${milestoneId}`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Updated Milestone Title',
          description: 'Updated description',
          amount: 40000,
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('milestoneId', milestoneId);
      expect(response.body).toHaveProperty('title', 'Updated Milestone Title');
      expect(response.body).toHaveProperty('amount', 40000);

      // Verify database record
      const project = await ProjectModel.findById(projectId);
      const milestone = project?.milestones.find(m => m._id?.toString() === milestoneId);
      expect(milestone?.title).toBe('Updated Milestone Title');
      expect(milestone?.amount).toBe(40000);
    });

    it('T14.3 - should fail to update funded milestone amount (409 Conflict)', async () => {
      // Arrange - Simulate funded milestone
      await ProjectModel.updateOne(
        { _id: projectId, 'milestones._id': milestoneId },
        { $set: { 'milestones.$.status': 'funded' } }
      );

      // Act - Try to update amount of funded milestone
      const response = await request(app)
        .put(`/projects/${projectId}/milestones/${milestoneId}`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          amount: 60000, // Try to change amount
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('funded milestone');
    });

    it('should fail when non-owner tries to update (403)', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${projectId}/milestones/${milestoneId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Unauthorized Update',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should fail when milestone does not exist (404)', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${projectId}/milestones/507f1f77bcf86cd799439011`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Non-existent Milestone',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });
  });

  describe('DELETE /projects/:projectId/milestones/:milestoneId', () => {
    beforeEach(async () => {
      // Create a milestone for deletion tests
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Milestone to Delete',
          amount: 20000,
        });
      milestoneId = response.body.milestoneId;
    });

    it('T14.4 - should successfully delete milestone (owner access)', async () => {
      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}/milestones/${milestoneId}`)
        .set('Authorization', `Bearer ${ownerAccessToken}`);

      // Assert
      expect(response.status).toBe(204);

      // Verify milestone removed from database
      const project = await ProjectModel.findById(projectId);
      const milestone = project?.milestones.find(m => m._id?.toString() === milestoneId);
      expect(milestone).toBeUndefined();
    });

    it('should fail when non-owner tries to delete (403)', async () => {
      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}/milestones/${milestoneId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should fail to delete milestone with escrow (409)', async () => {
      // Arrange - Simulate milestone with escrow
      await ProjectModel.updateOne(
        { _id: projectId, 'milestones._id': milestoneId },
        { $set: { 'milestones.$.escrowId': new mongoose.Types.ObjectId() } }
      );

      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}/milestones/${milestoneId}`)
        .set('Authorization', `Bearer ${ownerAccessToken}`);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('funds/escrow');
    });
  });

  describe('POST /projects/:projectId/milestones/:milestoneId/complete', () => {
    beforeEach(async () => {
      // Create a milestone for completion tests
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Milestone to Complete',
          amount: 35000,
        });
      milestoneId = response.body.milestoneId;
    });

    it('T14.5 - should successfully complete milestone (member access)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/complete`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          notes: 'All deliverables have been completed and reviewed.',
          evidenceAssetIds: ['507f1f77bcf86cd799439011'],
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('milestoneId', milestoneId);
      expect(response.body).toHaveProperty('status', 'completed');
      expect(response.body).toHaveProperty('completedBy', creatorUserId);
      expect(response.body).toHaveProperty('message');

      // Verify database record
      const project = await ProjectModel.findById(projectId);
      const milestone = project?.milestones.find(m => m._id?.toString() === milestoneId);
      expect(milestone?.status).toBe('completed');
    });

    it('should allow owner to complete milestone', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/complete`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          notes: 'Owner completing milestone',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'completed');
      expect(response.body).toHaveProperty('completedBy', ownerUserId);
    });

    it('should fail when non-member tries to complete (403)', async () => {
      // Arrange - Create another user who is not a project member
      const outsiderSignup = await request(app).post('/auth/signup').send({
        email: 'outsider@example.com',
        password: 'Password123',
        role: 'creator',
      });

      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/complete`)
        .set('Authorization', `Bearer ${outsiderSignup.body.accessToken}`)
        .send({
          notes: 'Unauthorized completion attempt',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('project member');
    });

    it('should fail to complete already completed milestone (409)', async () => {
      // Arrange - Complete milestone first
      await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/complete`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ notes: 'First completion' });

      // Act - Try to complete again
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/complete`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ notes: 'Second completion attempt' });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already completed');
    });

    it('should fail when milestone does not exist (404)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/507f1f77bcf86cd799439011/complete`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ notes: 'Completing non-existent milestone' });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should validate evidence asset IDs format', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/complete`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          evidenceAssetIds: ['invalid-asset-id'], // Invalid format
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });

  describe('Authentication and Authorization', () => {
    beforeEach(async () => {
      // Create milestone for auth tests
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Auth Test Milestone',
          amount: 15000,
        });
      milestoneId = response.body.milestoneId;
    });

    it('should require authentication for milestone creation', async () => {
      const response = await request(app)
        .post(`/projects/${projectId}/milestones`)
        .send({
          title: 'Unauthenticated Milestone',
          amount: 10000,
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should require authentication for milestone update', async () => {
      const response = await request(app)
        .put(`/projects/${projectId}/milestones/${milestoneId}`)
        .send({
          title: 'Updated Title',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should require authentication for milestone deletion', async () => {
      const response = await request(app)
        .delete(`/projects/${projectId}/milestones/${milestoneId}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should require authentication for milestone completion', async () => {
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/complete`)
        .send({
          notes: 'Unauthenticated completion',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('Validation', () => {
    it('should validate project ID format', async () => {
      const response = await request(app)
        .post('/projects/invalid-id/milestones')
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Test Milestone',
          amount: 10000,
        });

      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate milestone ID format', async () => {
      const response = await request(app)
        .put(`/projects/${projectId}/milestones/invalid-id`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Updated Title',
        });

      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });
});
