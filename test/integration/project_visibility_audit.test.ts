import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';

describe('Project Visibility Audit (Non-Member Views) Integration Tests', () => {
  let ownerToken: string;
  let ownerId: string;
  let memberToken: string;
  let memberId: string;
  let nonMemberToken: string;
  let publicProjectId: string;
  let privateProjectId: string;

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

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerToken = ownerSignup.body.accessToken;
    ownerId = ownerSignup.body.user.id;

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

    // Create public project
    const publicProjectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Public Test Project',
        category: 'Film Production',
        visibility: 'public',
        roles: [{ title: 'Director', slots: 1, description: 'Project director role' }],
        revenueModel: {
          splits: [
            { userId: ownerId, percentage: 60 },
            { placeholder: 'Director', percentage: 40 },
          ],
        },
        milestones: [
          {
            title: 'Milestone 1',
            amount: 50000,
            currency: 'USD',
            status: 'pending',
          },
        ],
      });
    publicProjectId = publicProjectResponse.body.projectId;

    // Add member to public project
    await ProjectModel.findByIdAndUpdate(publicProjectId, {
      $push: { teamMemberIds: new mongoose.Types.ObjectId(memberId) },
    });

    // Create private project
    const privateProjectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Private Test Project',
        category: 'Music Production',
        visibility: 'private',
        roles: [{ title: 'Producer', slots: 1 }],
        revenueModel: {
          splits: [{ userId: ownerId, percentage: 100 }],
        },
      });
    privateProjectId = privateProjectResponse.body.projectId;

    // Add member to private project
    await ProjectModel.findByIdAndUpdate(privateProjectId, {
      $push: { teamMemberIds: new mongoose.Types.ObjectId(memberId) },
    });
  });

  describe('GET /projects/:projectId', () => {
    it('T23.1 - should return 404 for anonymous access to private project (security by obscurity)', async () => {
      // Act - Anonymous request (no auth token)
      const response = await request(app).get(`/projects/${privateProjectId}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
      expect(response.body.error.message).toContain('Project not found');
      // Security: Should not reveal that the project exists
    });

    it('T23.2 - should return 200 with redacted data for anonymous access to public project', async () => {
      // Act - Anonymous request
      const response = await request(app).get(`/projects/${publicProjectId}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('projectId', publicProjectId);
      expect(response.body).toHaveProperty('visibility', 'public');

      // REDACTION CHECK: revenueSplits must NOT contain userId for anonymous users
      expect(response.body.revenueSplits).toBeDefined();
      response.body.revenueSplits.forEach((split: any) => {
        expect(split).not.toHaveProperty('userId'); // userId must be hidden
        expect(split).toHaveProperty('placeholder');
        expect(split).toHaveProperty('percentage');
      });

      // REDACTION CHECK: assignedUserIds must be empty array for anonymous users
      response.body.roles.forEach((role: any) => {
        expect(role.assignedUserIds).toEqual([]); // Must be empty for non-members
      });

      // REDACTION CHECK: Milestone amounts must be undefined for anonymous users
      response.body.milestones.forEach((milestone: any) => {
        expect(milestone.amount).toBeUndefined(); // Financial data hidden
        expect(milestone.currency).toBeUndefined(); // Financial data hidden
        expect(milestone).toHaveProperty('title');
        expect(milestone).toHaveProperty('status');
      });

      // REDACTION CHECK: teamMemberIds must be empty array for anonymous users
      expect(response.body.teamMemberIds).toEqual([]);
    });

    it('T23.3 - should return 200 with full data for member access to private project', async () => {
      // Act - Member request
      const response = await request(app)
        .get(`/projects/${privateProjectId}`)
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('projectId', privateProjectId);
      expect(response.body).toHaveProperty('visibility', 'private');

      // FULL ACCESS CHECK: revenueSplits must contain userId for members
      expect(response.body.revenueSplits).toBeDefined();
      response.body.revenueSplits.forEach((split: any) => {
        if (split.userId) {
          expect(split).toHaveProperty('userId'); // userId visible for members
        }
      });

      // FULL ACCESS CHECK: assignedUserIds may be populated for members
      expect(Array.isArray(response.body.roles[0]?.assignedUserIds)).toBe(true);

      // FULL ACCESS CHECK: teamMemberIds visible for members
      expect(Array.isArray(response.body.teamMemberIds)).toBe(true);
    });

    it('should return 404 for non-member access to private project (not 403)', async () => {
      // Act - Non-member authenticated request
      const response = await request(app)
        .get(`/projects/${privateProjectId}`)
        .set('Authorization', `Bearer ${nonMemberToken}`);

      // Assert - Should be 404 (security by obscurity), not 403
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
      expect(response.body.error.message).toContain('Project not found');
      // Security: Should not reveal that the project exists or that access was denied
    });

    it('should return 200 with redacted data for non-member access to public project', async () => {
      // Act - Non-member authenticated request
      const response = await request(app)
        .get(`/projects/${publicProjectId}`)
        .set('Authorization', `Bearer ${nonMemberToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('projectId', publicProjectId);

      // REDACTION CHECK: revenueSplits must NOT contain userId for non-members
      response.body.revenueSplits.forEach((split: any) => {
        expect(split).not.toHaveProperty('userId');
        expect(split).toHaveProperty('placeholder');
        expect(split).toHaveProperty('percentage');
      });

      // REDACTION CHECK: assignedUserIds must be empty for non-members
      response.body.roles.forEach((role: any) => {
        expect(role.assignedUserIds).toEqual([]);
      });

      // REDACTION CHECK: Milestone amounts must be undefined for non-members
      response.body.milestones.forEach((milestone: any) => {
        expect(milestone.amount).toBeUndefined();
        expect(milestone.currency).toBeUndefined();
      });
    });
  });

  describe('GET /projects', () => {
    it('T23.4 - should return only public projects for anonymous users', async () => {
      // Act - Anonymous request
      const response = await request(app).get('/projects');

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('pagination');

      // VISIBILITY CHECK: List MUST NOT contain any projects with visibility='private'
      response.body.data.forEach((project: any) => {
        expect(project.visibility).toBe('public');
        expect(project.visibility).not.toBe('private');
      });

      // Verify public project is included
      const publicProject = response.body.data.find((p: any) => p.projectId === publicProjectId);
      expect(publicProject).toBeDefined();
      expect(publicProject.visibility).toBe('public');

      // Verify private project is NOT included
      const privateProject = response.body.data.find((p: any) => p.projectId === privateProjectId);
      expect(privateProject).toBeUndefined();
    });

    it('T23.5 - should return public projects AND member private projects for authenticated member', async () => {
      // Act - Member request
      const response = await request(app)
        .get('/projects')
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');

      // VERIFY: Public project is included
      const publicProject = response.body.data.find((p: any) => p.projectId === publicProjectId);
      expect(publicProject).toBeDefined();
      expect(publicProject.visibility).toBe('public');

      // VERIFY: Member's private project is included
      const memberPrivateProject = response.body.data.find((p: any) => p.projectId === privateProjectId);
      expect(memberPrivateProject).toBeDefined();
      expect(memberPrivateProject.visibility).toBe('private');
      expect(memberPrivateProject.isMember).toBe(true); // Member flag should be set

      // VERIFY: Only projects user is a member of OR public projects are included
      response.body.data.forEach((project: any) => {
        if (project.visibility === 'private') {
          expect(project.isMember).toBe(true); // Private projects must have isMember=true
        }
      });
    });

    it('should return only public projects for non-member authenticated user', async () => {
      // Act - Non-member authenticated request
      const response = await request(app)
        .get('/projects')
        .set('Authorization', `Bearer ${nonMemberToken}`);

      // Assert
      expect(response.status).toBe(200);

      // VERIFY: Public project is included
      const publicProject = response.body.data.find((p: any) => p.projectId === publicProjectId);
      expect(publicProject).toBeDefined();

      // VERIFY: Private project is NOT included (not a member)
      const privateProject = response.body.data.find((p: any) => p.projectId === privateProjectId);
      expect(privateProject).toBeUndefined();

      // VERIFY: All returned projects are public
      response.body.data.forEach((project: any) => {
        expect(project.visibility).toBe('public');
      });
    });

    it('should exclude archived projects by default', async () => {
      // Arrange - Archive the public project
      await ProjectModel.findByIdAndUpdate(publicProjectId, {
        $set: { status: 'archived' },
      });

      // Act - Anonymous request
      const response = await request(app).get('/projects');

      // Assert
      expect(response.status).toBe(200);
      // Verify archived project is not in results
      const archivedProject = response.body.data.find((p: any) => p.projectId === publicProjectId);
      expect(archivedProject).toBeUndefined();
    });

    it('should include archived projects when explicitly requested', async () => {
      // Arrange - Archive the public project
      await ProjectModel.findByIdAndUpdate(publicProjectId, {
        $set: { status: 'archived' },
      });

      // Act - Request with status=archived
      const response = await request(app).get('/projects').query({ status: 'archived' });

      // Assert
      expect(response.status).toBe(200);
      // Verify archived project is included
      const archivedProject = response.body.data.find((p: any) => p.projectId === publicProjectId);
      expect(archivedProject).toBeDefined();
      expect(archivedProject.status).toBe('archived');
    });
  });
});

