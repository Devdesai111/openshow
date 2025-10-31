import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { ProjectInviteModel, ProjectApplicationModel } from '../../src/models/projectApplication.model';

describe('Project Member Management Integration Tests', () => {
  let ownerAccessToken: string;
  let ownerUserId: string;
  let creatorAccessToken: string;
  let creatorUserId: string;
  let otherCreatorAccessToken: string;
  let otherCreatorUserId: string;
  let adminAccessToken: string;
  let adminUserId: string;
  let projectId: string;
  let roleId: string;
  let openProjectId: string;
  let openRoleId: string;

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
    await ProjectInviteModel.deleteMany({});
    await ProjectApplicationModel.deleteMany({});

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerAccessToken = ownerSignup.body.accessToken;
    ownerUserId = ownerSignup.body.user.id;

    // Create creator users
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Creator User',
    });
    creatorAccessToken = creatorSignup.body.accessToken;
    creatorUserId = creatorSignup.body.user.id;

    const otherCreatorSignup = await request(app).post('/auth/signup').send({
      email: 'othercreator@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Other Creator',
    });
    otherCreatorAccessToken = otherCreatorSignup.body.accessToken;
    otherCreatorUserId = otherCreatorSignup.body.user.id;

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

    // Create test project (invite-only)
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({
        title: 'Test Project for Member Management',
        category: 'Film Production',
        collaborationType: 'invite',
        roles: [
          { title: 'Director', slots: 1 },
          { title: 'Editor', slots: 2 },
        ],
        revenueModel: {
          splits: [{ placeholder: 'Owner', percentage: 100 }],
        },
      });

    projectId = projectResponse.body.projectId;
    const project = await ProjectModel.findById(projectId);
    roleId = project?.roles[1]?._id?.toString() || ''; // Editor role

    // Create open project for application testing
    const openProjectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${creatorAccessToken}`)
      .send({
        title: 'Open Project for Applications',
        category: 'Web Development',
        collaborationType: 'open',
        roles: [
          { title: 'Frontend Developer', slots: 1 },
        ],
        revenueModel: {
          splits: [{ placeholder: 'Team', percentage: 100 }],
        },
      });

    openProjectId = openProjectResponse.body.projectId;
    const openProject = await ProjectModel.findById(openProjectId);
    openRoleId = openProject?.roles[0]?._id?.toString() || '';
  });

  describe('POST /projects/:projectId/invite', () => {
    it('T13.1 - should successfully invite user to role (owner access)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/invite`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          userId: creatorUserId,
          roleId: roleId,
          message: 'Would you like to join our film project as an editor?',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('inviteId');
      expect(response.body).toHaveProperty('projectId', projectId);
      expect(response.body).toHaveProperty('roleId', roleId);
      expect(response.body).toHaveProperty('status', 'pending');
      expect(response.body).toHaveProperty('invitedUserId', creatorUserId);

      // Verify database record
      const invite = await ProjectInviteModel.findById(response.body.inviteId);
      expect(invite).toBeTruthy();
      expect(invite?.message).toBe('Would you like to join our film project as an editor?');
    });

    it('T13.2 - should fail when non-owner tries to invite (403 Forbidden)', async () => {
      // Act - Creator tries to invite to owner's project
      const response = await request(app)
        .post(`/projects/${projectId}/invite`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          userId: otherCreatorUserId,
          roleId: roleId,
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should allow admin to invite users', async () => {
      // Act - Admin invites user
      const response = await request(app)
        .post(`/projects/${projectId}/invite`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({
          userId: creatorUserId,
          roleId: roleId,
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('inviteId');
    });

    it('should fail when role is full', async () => {
      // Arrange - Fill the role first
      const project = await ProjectModel.findById(projectId);
      const directorRoleId = project?.roles[0]?._id?.toString(); // Director role with 1 slot

      // Assign owner to director role to fill it
      await request(app)
        .post(`/projects/${projectId}/roles/${directorRoleId}/assign`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: ownerUserId });

      // Act - Try to invite to full role
      const response = await request(app)
        .post(`/projects/${projectId}/invite`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          userId: creatorUserId,
          roleId: directorRoleId,
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
    });

    it('should fail when target user does not exist', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/invite`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          userId: '507f1f77bcf86cd799439011', // Non-existent user
          roleId: roleId,
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });
  });

  describe('POST /projects/:projectId/apply', () => {
    it('T13.3 - should successfully apply to open project', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${openProjectId}/apply`)
        .set('Authorization', `Bearer ${otherCreatorAccessToken}`)
        .send({
          roleId: openRoleId,
          message: 'I would love to contribute to this project!',
          proposedRate: 5000, // $50/hour in cents
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('applicationId');
      expect(response.body).toHaveProperty('projectId', openProjectId);
      expect(response.body).toHaveProperty('roleId', openRoleId);
      expect(response.body).toHaveProperty('status', 'pending');
      expect(response.body).toHaveProperty('appliedAt');

      // Verify database record
      const application = await ProjectApplicationModel.findById(response.body.applicationId);
      expect(application).toBeTruthy();
      expect(application?.proposedRate).toBe(5000);
    });

    it('T13.4 - should fail to apply to invite-only project (403 Forbidden)', async () => {
      // Act - Try to apply to invite-only project
      const response = await request(app)
        .post(`/projects/${projectId}/apply`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          roleId: roleId,
          message: 'Can I join this project?',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('does not accept open applications');
    });

    it('should fail when applying to non-existent project', async () => {
      // Act
      const response = await request(app)
        .post('/projects/507f1f77bcf86cd799439011/apply')
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          roleId: roleId,
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should prevent duplicate applications', async () => {
      // Arrange - Apply once
      await request(app)
        .post(`/projects/${openProjectId}/apply`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ roleId: openRoleId });

      // Act - Try to apply again
      const response = await request(app)
        .post(`/projects/${openProjectId}/apply`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ roleId: openRoleId });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
    });
  });

  describe('POST /projects/:projectId/roles/:roleId/assign', () => {
    it('T13.5 - should successfully assign user to role (owner access)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/roles/${roleId}/assign`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          userId: creatorUserId,
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('roleId', roleId);
      expect(response.body).toHaveProperty('assignedUserIds');
      expect(response.body.assignedUserIds).toContain(creatorUserId);
      expect(response.body).toHaveProperty('filled', 1);
      expect(response.body).toHaveProperty('slots', 2);

      // Verify database record
      const project = await ProjectModel.findById(projectId);
      const role = project?.roles.find(r => r._id?.toString() === roleId);
      expect(role?.assignedUserIds.map(id => id.toString())).toContain(creatorUserId);
      expect(project?.teamMemberIds.map(id => id.toString())).toContain(creatorUserId);
    });

    it('T13.6 - should fail when role slots are full (409 Conflict)', async () => {
      // Arrange - Fill the role first (Director has 1 slot)
      const project = await ProjectModel.findById(projectId);
      const directorRoleId = project?.roles[0]?._id?.toString(); // Director role with 1 slot

      // Assign owner to fill the slot
      await request(app)
        .post(`/projects/${projectId}/roles/${directorRoleId}/assign`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: ownerUserId });

      // Act - Try to assign another user to full role
      const response = await request(app)
        .post(`/projects/${projectId}/roles/${directorRoleId}/assign`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: creatorUserId });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('role slots are full');
    });

    it('T13.7 - should fail when role does not exist (404 Not Found)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/roles/507f1f77bcf86cd799439011/assign`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: creatorUserId });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should fail when non-owner tries to assign', async () => {
      // Act - Creator tries to assign to owner's project
      const response = await request(app)
        .post(`/projects/${projectId}/roles/${roleId}/assign`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ userId: otherCreatorUserId });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should allow admin to assign users', async () => {
      // Act - Admin assigns user
      const response = await request(app)
        .post(`/projects/${projectId}/roles/${roleId}/assign`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ userId: creatorUserId });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.assignedUserIds).toContain(creatorUserId);
    });

    it('should prevent double assignment to same role', async () => {
      // Arrange - Assign user first time
      await request(app)
        .post(`/projects/${projectId}/roles/${roleId}/assign`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: creatorUserId });

      // Act - Try to assign same user again
      const response = await request(app)
        .post(`/projects/${projectId}/roles/${roleId}/assign`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: creatorUserId });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already assigned');
    });

    it('should fail when target user does not exist', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/roles/${roleId}/assign`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: '507f1f77bcf86cd799439011' }); // Non-existent user

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });
  });

  describe('Authentication and Authorization', () => {
    it('should require authentication for invite', async () => {
      const response = await request(app)
        .post(`/projects/${projectId}/invite`)
        .send({ userId: creatorUserId, roleId: roleId });

      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should require authentication for apply', async () => {
      const response = await request(app)
        .post(`/projects/${openProjectId}/apply`)
        .send({ roleId: openRoleId });

      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should require authentication for assign', async () => {
      const response = await request(app)
        .post(`/projects/${projectId}/roles/${roleId}/assign`)
        .send({ userId: creatorUserId });

      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('Validation', () => {
    it('should validate project ID format', async () => {
      const response = await request(app)
        .post('/projects/invalid-id/invite')
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: creatorUserId, roleId: roleId });

      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate user ID format in invite', async () => {
      const response = await request(app)
        .post(`/projects/${projectId}/invite`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ userId: 'invalid-id', roleId: roleId });

      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate role ID format in apply', async () => {
      const response = await request(app)
        .post(`/projects/${openProjectId}/apply`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ roleId: 'invalid-id' });

      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });
});
