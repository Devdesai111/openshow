import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';

describe('Project Finalization Integration Tests', () => {
  let ownerToken: string;
  let ownerId: string;
  let memberToken: string;
  let memberId: string;
  let nonMemberToken: string;
  let adminToken: string;
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
      fullName: 'Team Member',
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

    // Create admin user
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
    adminToken = adminLogin.body.accessToken;

    // Create project with member
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Test Project',
        category: 'Film Production',
        visibility: 'private',
        roles: [
          { title: 'Director', slots: 1 },
          { title: 'Editor', slots: 1 },
        ],
        revenueModel: {
          splits: [{ userId: ownerId, percentage: 100 }],
        },
      });
    projectId = projectResponse.body.projectId;

    // Get project directly from DB to find role IDs
    const project = await ProjectModel.findById(projectId);
    expect(project).toBeDefined();
    
    if (project) {
      const editorRole = project.roles.find(r => r.title === 'Editor');
      const editorRoleId = editorRole?._id?.toString();
      
      // Assign member to a role
      if (editorRoleId) {
        const assignResponse = await request(app)
          .post(`/projects/${projectId}/roles/${editorRoleId}/assign`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ userId: memberId });
        
      // Verify assignment succeeded
      expect(assignResponse.status).toBe(200);
        
        // Verify member is in teamMemberIds
        const projectAfterAssign = await ProjectModel.findById(projectId);
        const memberInTeam = projectAfterAssign?.teamMemberIds.some(
          id => id.toString() === memberId
        );
        expect(memberInTeam).toBe(true);
      }
    }
  });

  describe('DELETE /projects/:projectId', () => {
    it('T29.1 - should successfully archive project by owner (happy path)', async () => {
      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      // Assert
      expect(response.status).toBe(204); // No Content
      expect(response.body).toEqual({});

      // Verify project is archived
      const archivedProject = await ProjectModel.findById(projectId);
      expect(archivedProject?.status).toBe('archived');
      expect(archivedProject?.visibility).toBe('private');
    });

    it('should successfully archive project by admin', async () => {
      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(204);

      // Verify project is archived
      const archivedProject = await ProjectModel.findById(projectId);
      expect(archivedProject?.status).toBe('archived');
      expect(archivedProject?.visibility).toBe('private');
    });

    it('T29.2 - should fail when project has active escrow (409)', async () => {
      // Arrange - Add milestone with escrowId (active funds)
      await ProjectModel.updateOne(
        { _id: projectId },
        {
          $push: {
            milestones: {
              _id: new mongoose.Types.ObjectId(),
              title: 'Funded Milestone',
              amount: 10000,
              currency: 'USD',
              escrowId: new mongoose.Types.ObjectId(), // Active escrow
              status: 'funded',
            },
          },
        }
      );

      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('active escrow');

      // Verify project is NOT archived
      const project = await ProjectModel.findById(projectId);
      expect(project?.status).not.toBe('archived');
    });

    it('should allow archiving when escrow is approved', async () => {
      // Arrange - Add milestone with escrowId but status is approved
      await ProjectModel.updateOne(
        { _id: projectId },
        {
          $push: {
            milestones: {
              _id: new mongoose.Types.ObjectId(),
              title: 'Approved Milestone',
              amount: 10000,
              currency: 'USD',
              escrowId: new mongoose.Types.ObjectId(), // Has escrowId but status is approved
              status: 'approved',
            },
          },
        }
      );

      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      // Assert
      expect(response.status).toBe(204);

      // Verify project is archived
      const archivedProject = await ProjectModel.findById(projectId);
      expect(archivedProject?.status).toBe('archived');
    });

    it('T29.3 - should fail when non-owner tries to archive (403)', async () => {
      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}`)
        .set('Authorization', `Bearer ${memberToken}`); // Member (not owner)

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('owner or an Admin');

      // Verify project is NOT archived
      const project = await ProjectModel.findById(projectId);
      expect(project?.status).not.toBe('archived');
    });

    it('should return 404 for non-existent project', async () => {
      // Act
      const response = await request(app)
        .delete('/projects/507f1f77bcf86cd799439011')
        .set('Authorization', `Bearer ${ownerToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).delete(`/projects/${projectId}`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('GET /projects/:projectId/team', () => {
    it('T29.4 - should successfully retrieve team members for project member (happy path)', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/team`)
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('projectId');
      expect(response.body).toHaveProperty('team');
      expect(Array.isArray(response.body.team)).toBe(true);

      // Verify team structure
      const team = response.body.team;
      expect(team.length).toBeGreaterThan(0);

      // Find owner in team
      const owner = team.find((t: any) => t.isOwner === true);
      expect(owner).toBeDefined();
      expect(owner).toHaveProperty('userId', ownerId);
      expect(owner).toHaveProperty('displayName');
      expect(owner).toHaveProperty('roleIds');
      expect(owner).toHaveProperty('roleTitles');
      expect(owner).toHaveProperty('isOwner', true);

      // Find member in team
      const member = team.find((t: any) => t.userId === memberId);
      expect(member).toBeDefined();
      expect(member).toHaveProperty('displayName');
      expect(member).toHaveProperty('roleIds');
      expect(member).toHaveProperty('isOwner', false);
    });

    it('should successfully retrieve team members for admin', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/team`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('team');
      expect(Array.isArray(response.body.team)).toBe(true);
    });

    it('should successfully retrieve team members for owner', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/team`)
        .set('Authorization', `Bearer ${ownerToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('team');

      // Verify owner is in team with correct data
      const team = response.body.team;
      const owner = team.find((t: any) => t.isOwner === true);
      expect(owner).toBeDefined();
      expect(owner.userId).toBe(ownerId);
    });

    it('T29.5 - should fail when non-member tries to view team (403)', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/team`)
        .set('Authorization', `Bearer ${nonMemberToken}`); // Non-member

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('project member');
    });

    it('should return correct role data for team members', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/team`)
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(200);

      // Find member with assigned role
      const team = response.body.team;
      const member = team.find((t: any) => t.userId === memberId);
      expect(member).toBeDefined();

      // Member should have roleIds and roleTitles from assigned role
      expect(member.roleIds).toBeInstanceOf(Array);
      expect(member.roleTitles).toBeInstanceOf(Array);
      expect(member.roleIds.length).toBeGreaterThan(0);
      expect(member.roleTitles.length).toBeGreaterThan(0);
    });

    it('should return displayName (preferredName, fullName, or email)', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/team`)
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(200);

      const team = response.body.team;
      team.forEach((member: any) => {
        expect(member).toHaveProperty('displayName');
        expect(typeof member.displayName).toBe('string');
        expect(member.displayName.length).toBeGreaterThan(0);
      });
    });

    it('should return 404 for non-existent project', async () => {
      // Act
      const response = await request(app)
        .get('/projects/507f1f77bcf86cd799439011/team')
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).get(`/projects/${projectId}/team`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });
});

