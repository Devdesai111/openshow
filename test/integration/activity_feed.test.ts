import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { ActivityModel } from '../../src/models/activity.model';

async function createAdminToken(email: string, password: string): Promise<string> {
  // Sign up as creator first
  await request(app).post('/auth/signup').send({
    email,
    password,
    role: 'creator',
    fullName: 'AdminTemp',
  });
  // Promote to admin in DB
  await UserModel.updateOne({ email }, { $set: { role: 'admin' } });
  // Re-login to get fresh token with admin role
  const loginRes = await request(app).post('/auth/login').send({ email, password });
  return loginRes.body.accessToken as string;
}

describe('Activity Feed (Write/Read) Integration Tests', () => {
  let ownerToken: string;
  let ownerId: string;
  let memberToken: string;
  let memberId: string;
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
    await ActivityModel.deleteMany({});

    // Owner
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com', password: 'Password123', role: 'owner', fullName: 'Owner'
    });
    ownerToken = ownerSignup.body.accessToken;
    ownerId = ownerSignup.body.user.id;

    // Member
    const memberSignup = await request(app).post('/auth/signup').send({
      email: 'member@example.com', password: 'Password123', role: 'creator', fullName: 'Member'
    });
    memberToken = memberSignup.body.accessToken;
    memberId = memberSignup.body.user.id;

    // Create project and add member
    const projRes = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Activity Project',
        category: 'Film',
        visibility: 'private',
        roles: [{ title: 'Role', slots: 2 }],
        revenueModel: { splits: [{ placeholder: 'Role', percentage: 100 }] },
      });
    projectId = projRes.body.projectId;

    await ProjectModel.findByIdAndUpdate(projectId, {
      $push: { teamMemberIds: new mongoose.Types.ObjectId(memberId) },
    });
  });

  describe('POST /projects/:projectId/activity', () => {
    it('T18.1 - should log an activity event (admin only)', async () => {
      // Acquire admin token via promotion + re-login
      const adminToken = await createAdminToken('admin@example.com', 'Password123');

      const res = await request(app)
        .post(`/projects/${projectId}/activity`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'milestone.created', summary: 'Milestone 1 created', payload: { milestoneId: 'm1' } });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('activityId');
      expect(res.body).toHaveProperty('type', 'milestone.created');

      const act = await ActivityModel.findOne({ activityId: res.body.activityId });
      expect(act).toBeDefined();
      expect(act?.summary).toBe('Milestone 1 created');
    });

    it('T18.2 - should fail when non-admin tries to log activity (403)', async () => {
      const res = await request(app)
        .post(`/projects/${projectId}/activity`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ type: 'milestone.created', summary: 'Unauthorized log' });

      expect(res.status).toBe(403);
      expect(res.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('T18.3 - should validate missing summary (422)', async () => {
      // Acquire admin token via promotion + re-login
      const adminToken = await createAdminToken('admin2@example.com', 'Password123');

      const res = await request(app)
        .post(`/projects/${projectId}/activity`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'asset.uploaded' });

      expect(res.status).toBe(422);
      expect(res.body.error).toHaveProperty('code', 'validation_error');
    });
  });

  describe('GET /projects/:projectId/activity', () => {
    beforeEach(async () => {
      // Seed activities
      const now = Date.now();
      await ActivityModel.insertMany([
        { projectId: new mongoose.Types.ObjectId(projectId), type: 'project.created', summary: 'Project created', createdAt: new Date(now - 3000) },
        { projectId: new mongoose.Types.ObjectId(projectId), type: 'message.posted', summary: 'Owner posted a message', actorId: new mongoose.Types.ObjectId(ownerId), createdAt: new Date(now - 2000) },
        { projectId: new mongoose.Types.ObjectId(projectId), type: 'milestone.created', summary: 'Milestone created', createdAt: new Date(now - 1000) },
      ]);
    });

    it('T18.4 - should allow member to retrieve activity feed (descending)', async () => {
      const res = await request(app)
        .get(`/projects/${projectId}/activity`)
        .set('Authorization', `Bearer ${memberToken}`)
        .query({ limit: 10 });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      const items = res.body.data;
      for (let i = 0; i < items.length - 1; i++) {
        const a = new Date(items[i].createdAt).getTime();
        const b = new Date(items[i + 1].createdAt).getTime();
        expect(a).toBeGreaterThanOrEqual(b);
      }
    });

    it('T18.5 - should return 403 for non-member', async () => {
      // Create outsider
      const outsiderSignup = await request(app).post('/auth/signup').send({
        email: 'outsider@example.com', password: 'Password123', role: 'creator', fullName: 'Outsider'
      });
      const outsiderToken = outsiderSignup.body.accessToken;

      const res = await request(app)
        .get(`/projects/${projectId}/activity`)
        .set('Authorization', `Bearer ${outsiderToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('T18.6 - should support cursor pagination with after', async () => {
      const firstRes = await request(app)
        .get(`/projects/${projectId}/activity`)
        .set('Authorization', `Bearer ${memberToken}`)
        .query({ limit: 2 });

      expect(firstRes.status).toBe(200);
      expect(firstRes.body.data).toHaveLength(2);

      const afterId = firstRes.body.data[1].activityId;

      const secondRes = await request(app)
        .get(`/projects/${projectId}/activity`)
        .set('Authorization', `Bearer ${memberToken}`)
        .query({ limit: 2, after: afterId });

      expect(secondRes.status).toBe(200);
      // No overlap guaranteed by cursor
      const ids1 = firstRes.body.data.map((i: any) => i.activityId);
      const ids2 = secondRes.body.data.map((i: any) => i.activityId);
      ids2.forEach((id: string) => expect(ids1).not.toContain(id));
    });
  });
});
