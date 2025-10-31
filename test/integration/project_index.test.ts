import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';

describe('Project Search Index Hook & List Integration Tests', () => {
  let ownerAccessToken: string;
  let ownerUserId: string;
  let publicActiveProjectId: string;
  let publicCompletedProjectId: string;
  let privateProjectId: string;
  let draftProjectId: string;

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

    // Create public active project
    const publicActiveResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({
        title: 'Public Active Project',
        category: 'Film Production',
        visibility: 'public',
        collaborationType: 'open',
        roles: [{ title: 'Director', slots: 1 }],
        revenueModel: { splits: [{ placeholder: 'Director', percentage: 100 }] },
      });
    publicActiveProjectId = publicActiveResponse.body.projectId;

    // Update to active status
    await request(app)
      .put(`/projects/${publicActiveProjectId}`)
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({ status: 'active' });

    // Create public completed project
    const publicCompletedResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({
        title: 'Public Completed Project',
        category: 'Commercial',
        visibility: 'public',
        roles: [{ title: 'Producer', slots: 1 }],
        revenueModel: { splits: [{ placeholder: 'Producer', percentage: 100 }] },
      });
    publicCompletedProjectId = publicCompletedResponse.body.projectId;

    // Update to completed status
    await request(app)
      .put(`/projects/${publicCompletedProjectId}`)
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({ status: 'completed' });

    // Create private project
    const privateResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({
        title: 'Private Project',
        category: 'Web Development',
        visibility: 'private',
        roles: [{ title: 'Developer', slots: 1 }],
        revenueModel: { splits: [{ placeholder: 'Developer', percentage: 100 }] },
      });
    privateProjectId = privateResponse.body.projectId;

    // Update to active status (but private)
    await request(app)
      .put(`/projects/${privateProjectId}`)
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({ status: 'active' });

    // Create draft project (public but draft status)
    const draftResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({
        title: 'Draft Project',
        category: 'Animation',
        visibility: 'public',
        roles: [{ title: 'Animator', slots: 1 }],
        revenueModel: { splits: [{ placeholder: 'Animator', percentage: 100 }] },
      });
    draftProjectId = draftResponse.body.projectId;
    // Leave as draft (default status)
  });

  describe('Event Emission', () => {
    it('T16.1 - should emit project.created event on project creation', async () => {
      // Arrange - Set up console spy
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Act - Create a new project
      const response = await request(app)
        .post('/projects')
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'New Project for Event Test',
          category: 'Film Production',
          visibility: 'public',
          roles: [{ title: 'Director', slots: 1 }],
          revenueModel: { splits: [{ placeholder: 'Director', percentage: 100 }] },
        });

      // Assert
      expect(response.status).toBe(201);
      const projectId = response.body.projectId;

      // Verify event was emitted
      const eventLog = consoleSpy.mock.calls.find(call =>
        call[0]?.includes('[EVENT EMITTED]') && call[0]?.includes('project.created')
      );
      expect(eventLog).toBeDefined();
      expect(JSON.stringify(eventLog)).toContain(projectId);
      expect(JSON.stringify(eventLog)).toContain('visibility');
      expect(JSON.stringify(eventLog)).toContain('title');

      consoleSpy.mockRestore();
    });

    it('T16.2 - should emit project.updated event on project update', async () => {
      // Arrange - Set up console spy
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Act - Update project
      const response = await request(app)
        .put(`/projects/${publicActiveProjectId}`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          title: 'Updated Title',
          visibility: 'private',
        });

      // Assert
      expect(response.status).toBe(200);

      // Verify event was emitted
      const eventLog = consoleSpy.mock.calls.find(call =>
        call[0]?.includes('[EVENT EMITTED]') && call[0]?.includes('project.updated')
      );
      expect(eventLog).toBeDefined();
      expect(JSON.stringify(eventLog)).toContain(publicActiveProjectId);
      expect(JSON.stringify(eventLog)).toContain('changes');
      expect(JSON.stringify(eventLog)).toContain('visibility');

      consoleSpy.mockRestore();
    });

    it('T16.3 - should emit project.archived event on project archive', async () => {
      // Arrange - Import ProjectService to test archive method
      const { ProjectService } = await import('../../src/services/project.service');
      const projectService = new ProjectService();
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Act - Archive project (using service directly since we don't have a public endpoint yet)
      await projectService.archiveProject(publicActiveProjectId, ownerUserId);

      // Assert - Verify event was emitted
      const eventLog = consoleSpy.mock.calls.find(call =>
        call[0]?.includes('[EVENT EMITTED]') && call[0]?.includes('project.archived')
      );
      expect(eventLog).toBeDefined();
      expect(JSON.stringify(eventLog)).toContain(publicActiveProjectId);

      // Verify project was archived
      const project = await ProjectModel.findById(publicActiveProjectId);
      expect(project?.status).toBe('archived');
      expect(project?.visibility).toBe('private');

      consoleSpy.mockRestore();
    });
  });

  describe('GET /market/projects', () => {
    it('T16.4 - should return only public active/completed projects (happy path)', async () => {
      // Act
      const response = await request(app)
        .get('/market/projects')
        .query({ sort: 'newest' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('pagination');
      expect(response.body.pagination).toHaveProperty('has_next');
      expect(response.body.pagination).toHaveProperty('has_prev');

      // Should only include public active/completed projects
      const projectIds = response.body.data.map((p: any) => p.projectId);
      expect(projectIds).toContain(publicActiveProjectId);
      expect(projectIds).toContain(publicCompletedProjectId);
      expect(projectIds).not.toContain(privateProjectId); // Private excluded
      expect(projectIds).not.toContain(draftProjectId); // Draft excluded

      // Verify all returned projects are public and active/completed
      for (const project of response.body.data) {
        expect(project).toHaveProperty('visibility', 'public');
        expect(['active', 'completed']).toContain(project.status);
      }
    });

    it('T16.5 - should NOT show draft or private projects (security)', async () => {
      // Act
      const response = await request(app)
        .get('/market/projects');

      // Assert
      expect(response.status).toBe(200);

      const projectIds = response.body.data.map((p: any) => p.projectId);

      // MUST NOT show draft projects
      expect(projectIds).not.toContain(draftProjectId);

      // MUST NOT show private projects
      expect(projectIds).not.toContain(privateProjectId);

      // Verify filters are correctly applied
      const draftProject = await ProjectModel.findById(draftProjectId);
      expect(draftProject?.status).toBe('draft'); // Verify it's still draft
      expect(draftProject?.visibility).toBe('public'); // But public visibility

      const privateProject = await ProjectModel.findById(privateProjectId);
      expect(privateProject?.visibility).toBe('private'); // Verify it's private
      expect(privateProject?.status).toBe('active'); // But active status
    });

    it('T16.6 - should return validation error for invalid sort parameter', async () => {
      // Act
      const response = await request(app)
        .get('/market/projects')
        .query({ sort: 'invalid_param' });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should support category filtering', async () => {
      // Act
      const response = await request(app)
        .get('/market/projects')
        .query({ category: 'Film Production' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);

      // All projects should match the category
      for (const project of response.body.data) {
        expect(project.category).toBe('Film Production');
      }
    });

    it('should support text search query', async () => {
      // Act
      const response = await request(app)
        .get('/market/projects')
        .query({ q: 'Active' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);

      // Should find projects with "Active" in title
      const foundProject = response.body.data.find((p: any) => p.title.includes('Active'));
      expect(foundProject).toBeDefined();
    });

    it('should support pagination', async () => {
      // Act
      const response = await request(app)
        .get('/market/projects')
        .query({ page: 1, per_page: 1 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.pagination).toMatchObject({
        page: 1,
        per_page: 1,
        has_prev: false,
      });
      expect(response.body.pagination.has_next).toBeDefined();
    });

    it('should enforce per_page maximum', async () => {
      // Act
      const response = await request(app)
        .get('/market/projects')
        .query({ per_page: 200 }); // Over maximum

      // Assert - Validation should reject values over 100
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return empty list when no public active/completed projects exist', async () => {
      // Arrange - Delete all public projects
      await ProjectModel.deleteMany({ visibility: 'public', status: { $in: ['active', 'completed'] } });

      // Act
      const response = await request(app)
        .get('/market/projects');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
      expect(response.body.pagination.total_items).toBe(0);
    });

    it('should include required project fields in response', async () => {
      // Act
      const response = await request(app)
        .get('/market/projects');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);

      const project = response.body.data[0];
      expect(project).toHaveProperty('projectId');
      expect(project).toHaveProperty('title');
      expect(project).toHaveProperty('ownerId');
      expect(project).toHaveProperty('category');
      expect(project).toHaveProperty('status');
      expect(project).toHaveProperty('visibility', 'public');
      expect(project).toHaveProperty('collaborationType');
      expect(project).toHaveProperty('createdAt');

      // Should NOT include sensitive data
      expect(project).not.toHaveProperty('revenueSplits');
      expect(project).not.toHaveProperty('milestones');
      expect(project).not.toHaveProperty('teamMemberIds');
    });
  });
});
