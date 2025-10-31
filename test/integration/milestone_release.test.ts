import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';

describe('Milestone Approval & Dispute Integration Tests', () => {
  let ownerToken: string;
  let ownerId: string;
  let memberToken: string;
  let memberId: string;
  let nonMemberToken: string;
  let projectId: string;
  let milestoneId: string;
  let escrowId: string;

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

    // Create project with milestone
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Test Project',
        category: 'Film Production',
        visibility: 'private',
        roles: [{ title: 'Director', slots: 1 }],
        revenueModel: {
          splits: [{ userId: ownerId, percentage: 100 }],
        },
      });
    projectId = projectResponse.body.projectId;

    // Get project to add milestone
    const project = await ProjectModel.findById(projectId);
    expect(project).toBeDefined();

    if (project) {
      // Add milestone with escrow (funded)
      escrowId = new mongoose.Types.ObjectId().toString();
      const milestone = {
        _id: new mongoose.Types.ObjectId(),
        title: 'Test Milestone',
        description: 'Test milestone description',
        amount: 10000,
        currency: 'USD',
        escrowId: new mongoose.Types.ObjectId(escrowId),
        status: 'completed' as const,
      };
      project.milestones.push(milestone);
      await project.save();
      milestoneId = milestone._id.toString();
    }

    // Assign member to a role
    const projectDetails = await request(app)
      .get(`/projects/${projectId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const roles = projectDetails.body.project?.roles || [];
    const directorRoleId = roles.find((r: any) => r.title === 'Director')?._id;

    if (directorRoleId) {
      await request(app)
        .post(`/projects/${projectId}/roles/${directorRoleId}/assign`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userId: memberId });
    }
  });

  describe('POST /projects/:projectId/milestones/:milestoneId/approve', () => {
    it('T30.1 - should successfully approve completed milestone (happy path)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('milestoneId', milestoneId);
      expect(response.body).toHaveProperty('status', 'approved');
      expect(response.body).toHaveProperty('escrowReleaseStatus', 'release_initiated');
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('approved and funds release process initiated');

      // Verify milestone status in database
      const project = await ProjectModel.findById(projectId);
      const milestone = project?.milestones.find(m => m._id?.toString() === milestoneId);
      expect(milestone?.status).toBe('approved');
    });

    it('T30.2 - should fail when milestone is not completed (409)', async () => {
      // Arrange - Create a pending milestone
      const project = await ProjectModel.findById(projectId);
      expect(project).toBeDefined();

      if (project) {
        const pendingMilestone = {
          _id: new mongoose.Types.ObjectId(),
          title: 'Pending Milestone',
          amount: 5000,
          currency: 'USD',
          status: 'pending' as const,
        };
        project.milestones.push(pendingMilestone);
        await project.save();
        const pendingMilestoneId = pendingMilestone._id.toString();

        // Act
        const response = await request(app)
          .post(`/projects/${projectId}/milestones/${pendingMilestoneId}/approve`)
          .set('Authorization', `Bearer ${ownerToken}`);

        // Assert
        expect(response.status).toBe(409);
        expect(response.body.error).toHaveProperty('code', 'conflict');
        expect(response.body.error.message).toContain('completed before it can be approved');
      }
    });

    it('should fail when milestone is not funded (409)', async () => {
      // Arrange - Create a completed milestone without escrow
      const project = await ProjectModel.findById(projectId);
      expect(project).toBeDefined();

      if (project) {
        const unfundedMilestone = {
          _id: new mongoose.Types.ObjectId(),
          title: 'Unfunded Milestone',
          amount: 5000,
          currency: 'USD',
          status: 'completed' as const,
          // No escrowId
        };
        project.milestones.push(unfundedMilestone);
        await project.save();
        const unfundedMilestoneId = unfundedMilestone._id.toString();

        // Act
        const response = await request(app)
          .post(`/projects/${projectId}/milestones/${unfundedMilestoneId}/approve`)
          .set('Authorization', `Bearer ${ownerToken}`);

        // Assert
        expect(response.status).toBe(409);
        expect(response.body.error).toHaveProperty('code', 'conflict');
        expect(response.body.error.message).toContain('no associated escrow funds');
      }
    });

    it('T30.3 - should fail when non-owner tries to approve (403)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/approve`)
        .set('Authorization', `Bearer ${memberToken}`); // Member (not owner)

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('owner can approve milestones');

      // Verify milestone status unchanged
      const project = await ProjectModel.findById(projectId);
      const milestone = project?.milestones.find(m => m._id?.toString() === milestoneId);
      expect(milestone?.status).toBe('completed'); // Still completed
    });

    it('should return 404 for non-existent milestone', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${new mongoose.Types.ObjectId()}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/approve`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /projects/:projectId/milestones/:milestoneId/dispute', () => {
    beforeEach(async () => {
      // Reset milestone status to completed for dispute tests
      const project = await ProjectModel.findById(projectId);
      if (project) {
        const milestone = project.milestones.find(m => m._id?.toString() === milestoneId);
        if (milestone) {
          milestone.status = 'completed';
          // Ensure member is in teamMemberIds
          if (!project.teamMemberIds.some(id => id.toString() === memberId)) {
            project.teamMemberIds.push(new mongoose.Types.ObjectId(memberId));
          }
          await project.save();
        }
      }
    });

    it('T30.4 - should successfully dispute completed milestone (happy path)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          reason: 'The milestone deliverables do not meet the requirements.',
          evidenceAssetIds: [],
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('milestoneId', milestoneId);
      expect(response.body).toHaveProperty('status', 'disputed');
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('dispute logged');

      // Verify milestone status in database
      const project = await ProjectModel.findById(projectId);
      const milestone = project?.milestones.find(m => m._id?.toString() === milestoneId);
      expect(milestone?.status).toBe('disputed');
    });

    it('should successfully dispute with evidence assets', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          reason: 'Evidence of incomplete work.',
          evidenceAssetIds: [
            new mongoose.Types.ObjectId().toString(),
            new mongoose.Types.ObjectId().toString(),
          ],
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'disputed');
    });

    it('T30.5 - should fail when non-member tries to dispute (403)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${nonMemberToken}`) // Non-member
        .send({
          reason: 'I am not a member but want to dispute.',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('project member to dispute');

      // Verify milestone status unchanged
      const project = await ProjectModel.findById(projectId);
      const milestone = project?.milestones.find(m => m._id?.toString() === milestoneId);
      expect(milestone?.status).toBe('completed'); // Still completed
    });

    it('T30.6 - should fail when milestone is already approved (409)', async () => {
      // Arrange - Approve the milestone first
      await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`);

      // Act - Try to dispute
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          reason: 'Trying to dispute an approved milestone.',
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already approved or disputed');
    });

    it('should fail when milestone is already disputed (409)', async () => {
      // Arrange - Dispute the milestone first
      await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          reason: 'First dispute.',
        });

      // Act - Try to dispute again
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          reason: 'Trying to dispute again.',
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already approved or disputed');
    });

    it('should fail when milestone is rejected (409)', async () => {
      // Arrange - Set milestone status to rejected
      const project = await ProjectModel.findById(projectId);
      if (project) {
        const milestone = project.milestones.find(m => m._id?.toString() === milestoneId);
        if (milestone) {
          milestone.status = 'rejected';
          await project.save();
        }
      }

      // Act - Try to dispute
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          reason: 'Trying to dispute a rejected milestone.',
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already approved or disputed');
    });

    it('should validate reason is required and min 10 chars', async () => {
      // Act - Missing reason
      const response1 = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({});

      expect(response1.status).toBe(422);
      expect(response1.body.error).toHaveProperty('code', 'validation_error');

      // Act - Too short reason
      const response2 = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          reason: 'Short',
        });

      expect(response2.status).toBe(422);
      expect(response2.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate evidenceAssetIds is array if provided', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          reason: 'Valid reason for dispute.',
          evidenceAssetIds: 'not-an-array',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 404 for non-existent milestone', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${new mongoose.Types.ObjectId()}/dispute`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          reason: 'Disputing non-existent milestone.',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/milestones/${milestoneId}/dispute`)
        .send({
          reason: 'Dispute without auth.',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });
});

