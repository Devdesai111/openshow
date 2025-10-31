import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';

describe('Project Read & Edit Integration Tests', () => {
  let ownerAccessToken: string;
  let ownerUserId: string;
  let creatorAccessToken: string;
  let creatorUserId: string;
  let publicProjectId: string;
  let privateProjectId: string;
  let memberProjectId: string;

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

    // Create public project
    const publicProjectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({
        title: 'Public Film Project',
        category: 'Film Production',
        visibility: 'public',
        collaborationType: 'open',
        roles: [{ title: 'Director', slots: 1 }],
        revenueModel: { splits: [{ placeholder: 'Director', percentage: 100 }] },
      });
    publicProjectId = publicProjectResponse.body.projectId;

    // Create private project
    const privateProjectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({
        title: 'Private Project',
        category: 'Commercial',
        visibility: 'private',
        collaborationType: 'invite',
        roles: [{ title: 'Producer', slots: 1 }],
        revenueModel: { splits: [{ placeholder: 'Producer', percentage: 100 }] },
      });
    privateProjectId = privateProjectResponse.body.projectId;

    // Create project where creator is a member
    const memberProjectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${creatorAccessToken}`)
      .send({
        title: 'Creator Owned Project',
        category: 'Web Development',
        visibility: 'private',
        roles: [{ title: 'Developer', slots: 2 }],
        revenueModel: { splits: [{ placeholder: 'Developer', percentage: 100 }] },
      });
    memberProjectId = memberProjectResponse.body.projectId;
  });

  describe('GET /projects', () => {
    it('T15.1 - should return only public projects for anonymous users', async () => {
      // Act - Anonymous request (no auth header)
      const response = await request(app).get('/projects');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('pagination');
      expect(response.body.pagination).toHaveProperty('has_next');
      expect(response.body.pagination).toHaveProperty('has_prev');

      // Should only include public project
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toHaveProperty('projectId', publicProjectId);
      expect(response.body.data[0]).toHaveProperty('visibility', 'public');
    });

    it('T15.2 - should return public + member projects for authenticated users', async () => {
      // Act - Authenticated creator request
      const response = await request(app)
        .get('/projects')
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2); // Public + creator's own project

      const projectIds = response.body.data.map((p: any) => p.projectId);
      expect(projectIds).toContain(publicProjectId);
      expect(projectIds).toContain(memberProjectId);
      expect(projectIds).not.toContain(privateProjectId); // Not a member of this one
    });

    it('should support pagination', async () => {
      // Act
      const response = await request(app)
        .get('/projects?page=1&per_page=1')
        .set('Authorization', `Bearer ${ownerAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.pagination).toMatchObject({
        page: 1,
        per_page: 1,
        has_next: true, // Should have more projects
        has_prev: false,
      });
    });

    it('should support status filtering', async () => {
      // Arrange - Update one project to active status
      await ProjectModel.findByIdAndUpdate(publicProjectId, { status: 'active' });

      // Act
      const response = await request(app)
        .get('/projects?status=active')
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toHaveProperty('status', 'active');
    });
  });

  describe('GET /projects/:projectId', () => {
    it('T15.3 - should return public project details for anonymous users (redacted)', async () => {
      // Act - Anonymous request to public project
      const response = await request(app).get(`/projects/${publicProjectId}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('projectId', publicProjectId);
      expect(response.body).toHaveProperty('title', 'Public Film Project');
      expect(response.body).toHaveProperty('visibility', 'public');
      expect(response.body).toHaveProperty('roles');
      expect(response.body).toHaveProperty('milestones');
      expect(response.body).toHaveProperty('revenueSplits');

      // Revenue splits should be redacted (no userId)
      expect(response.body.revenueSplits[0]).not.toHaveProperty('userId');
      expect(response.body.revenueSplits[0]).toHaveProperty('placeholder');

      // Team member IDs should be hidden for non-members
      expect(response.body.teamMemberIds).toHaveLength(0);
      expect(response.body).toHaveProperty('teamMemberCount', 1); // But count is visible
    });

    it('T15.4 - should return 404 for private project when anonymous', async () => {
      // Act - Anonymous request to private project
      const response = await request(app).get(`/projects/${privateProjectId}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('T15.5 - should return full details for project member (non-redacted)', async () => {
      // Act - Member request to their own project
      const response = await request(app)
        .get(`/projects/${memberProjectId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('projectId', memberProjectId);
      expect(response.body).toHaveProperty('title', 'Creator Owned Project');

      // Revenue splits should include userId for members
      expect(response.body.revenueSplits[0]).toHaveProperty('placeholder');
      // Note: userId might be undefined if it's a placeholder split

      // Team member IDs should be visible for members
      expect(response.body.teamMemberIds).toHaveLength(1);
      expect(response.body.teamMemberIds[0]).toBe(creatorUserId);

      // Role assignees should be visible for members
      expect(response.body.roles[0]).toHaveProperty('assignedUserIds');
    });

    it('should return 404 for non-existent project', async () => {
      // Act
      const response = await request(app)
        .get('/projects/507f1f77bcf86cd799439011')
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should validate project ID format', async () => {
      // Act
      const response = await request(app)
        .get('/projects/invalid-id')
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });

  describe('PUT /projects/:projectId', () => {
    it('T15.6 - should successfully update project (owner access)', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${memberProjectId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Updated Project Title',
          description: 'Updated project description',
          visibility: 'public',
          status: 'active',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('projectId', memberProjectId);
      expect(response.body).toHaveProperty('title', 'Updated Project Title');
      expect(response.body).toHaveProperty('description', 'Updated project description');
      expect(response.body).toHaveProperty('visibility', 'public');
      expect(response.body).toHaveProperty('status', 'active');

      // Verify database record
      const project = await ProjectModel.findById(memberProjectId);
      expect(project?.title).toBe('Updated Project Title');
      expect(project?.visibility).toBe('public');
      expect(project?.status).toBe('active');
    });

    it('T15.7 - should fail when non-owner tries to update (403 Forbidden)', async () => {
      // Act - Creator tries to update owner's project
      const response = await request(app)
        .put(`/projects/${privateProjectId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Unauthorized Update',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should allow partial updates', async () => {
      // Act - Update only title
      const response = await request(app)
        .put(`/projects/${memberProjectId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Only Title Updated',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('title', 'Only Title Updated');
      // Other fields should remain unchanged
      expect(response.body).toHaveProperty('category', 'Web Development');
    });

    it('should validate title length', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${memberProjectId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Bad', // Too short
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate visibility values', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${memberProjectId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          visibility: 'invalid', // Invalid visibility
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when project does not exist', async () => {
      // Act
      const response = await request(app)
        .put('/projects/507f1f77bcf86cd799439011')
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          title: 'Non-existent Project Update',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${memberProjectId}`)
        .send({
          title: 'Unauthenticated Update',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('Visibility and Access Control', () => {
    it('should hide sensitive data for public project non-members', async () => {
      // Act - Anonymous user viewing public project
      const response = await request(app).get(`/projects/${publicProjectId}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.teamMemberIds).toHaveLength(0); // Hidden
      expect(response.body.roles[0].assignedUserIds).toHaveLength(0); // Hidden
      expect(response.body).toHaveProperty('teamMemberCount', 1); // Count visible
    });

    it('should show full data for project members', async () => {
      // Act - Owner viewing their own project
      const response = await request(app)
        .get(`/projects/${privateProjectId}`)
        .set('Authorization', `Bearer ${ownerAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.teamMemberIds).toHaveLength(1); // Visible to member
      expect(response.body.teamMemberIds[0]).toBe(ownerUserId);
    });

    it('should support owner filtering', async () => {
      // Act
      const response = await request(app)
        .get(`/projects?ownerId=${ownerUserId}`)
        .set('Authorization', `Bearer ${ownerAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      // Should return both owner's projects (public and private)
      expect(response.body.data).toHaveLength(2);
      for (const project of response.body.data) {
        expect(project.ownerId).toBe(ownerUserId);
      }
    });
  });

  describe('Pagination', () => {
    it('should return correct pagination metadata', async () => {
      // Act
      const response = await request(app)
        .get('/projects?page=1&per_page=2')
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.pagination).toMatchObject({
        page: 1,
        per_page: 2,
        total_items: 2, // Creator sees public + own project
        total_pages: 1,
        has_next: false,
        has_prev: false,
      });
    });

    it('should enforce per_page maximum', async () => {
      // Act
      const response = await request(app)
        .get('/projects?per_page=200') // Over maximum
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert - Validation should reject values over 100
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });

  describe('Project Summary Data', () => {
    it('should include role summary in list view', async () => {
      // Act
      const response = await request(app)
        .get('/projects')
        .set('Authorization', `Bearer ${ownerAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      const project = response.body.data.find((p: any) => p.projectId === publicProjectId);
      expect(project).toHaveProperty('rolesSummary');
      expect(project.rolesSummary[0]).toMatchObject({
        title: 'Director',
        slots: 1,
        filled: 1, // Owner is assigned
      });
    });

    it('should include team member count', async () => {
      // Act
      const response = await request(app)
        .get('/projects')
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      for (const project of response.body.data) {
        expect(project).toHaveProperty('teamMemberCount');
        expect(typeof project.teamMemberCount).toBe('number');
      }
    });
  });
});
