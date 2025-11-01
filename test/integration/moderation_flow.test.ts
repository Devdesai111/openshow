import request from 'supertest';
import app from '../../src/server';
import { ModerationRecordModel } from '../../src/models/moderationRecord.model';
import { AuditLogModel } from '../../src/models/auditLog.model';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import mongoose from 'mongoose';
import { Types } from 'mongoose';

describe('Moderation Queue & Actions API Integration Tests (Task 63)', () => {
  let adminToken: string;
  let creatorToken: string;
  let adminUserId: string;
  let creatorUserId: string;

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
    await ModerationRecordModel.deleteMany({});
    await AuditLogModel.deleteMany({});
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});

    // Create admin user (signup as creator, then update role)
    await request(app).post('/auth/signup').send({
      email: 'admin@test.com',
      password: 'Admin123!',
      preferredName: 'Admin User',
      fullName: 'Admin User',
      role: 'creator',
    });
    // Get adminUserId from database
    const adminUser = await UserModel.findOne({ email: 'admin@test.com' });
    expect(adminUser).toBeDefined();
    adminUserId = adminUser!._id!.toString();

    // Update to admin role
    await UserModel.updateOne({ email: 'admin@test.com' }, { $set: { role: 'admin' } });

    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@test.com',
      password: 'Admin123!',
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.data?.token || adminLogin.body.accessToken;
    expect(adminToken).toBeDefined();

    // Create creator user
    await request(app).post('/auth/signup').send({
      email: 'creator@test.com',
      password: 'Creator123!',
      preferredName: 'Creator User',
      fullName: 'Creator User',
      role: 'creator',
    });
    // Get creatorUserId from database
    const creatorUser = await UserModel.findOne({ email: 'creator@test.com' });
    expect(creatorUser).toBeDefined();
    creatorUserId = creatorUser!._id!.toString();

    const creatorLogin = await request(app).post('/auth/login').send({
      email: 'creator@test.com',
      password: 'Creator123!',
    });
    expect(creatorLogin.status).toBe(200);
    creatorToken = creatorLogin.body.data?.token || creatorLogin.body.accessToken;
    expect(creatorToken).toBeDefined();
  });

  describe('POST /moderation/report', () => {
    it('T63.1 - should successfully create a report (201 Created)', async () => {
      // Arrange
      const payload = {
        resourceType: 'project',
        resourceId: new Types.ObjectId().toString(),
        reason: 'This project contains inappropriate content that violates community guidelines.',
        severity: 'high',
      };

      // Act: Report as authenticated user
      const response = await request(app)
        .post('/moderation/report')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('modId');
      expect(response.body).toHaveProperty('status', 'open');
      expect(response.body).toHaveProperty('message');

      // Verify record was created
      const record = await ModerationRecordModel.findOne({ modId: response.body.modId });
      expect(record).toBeDefined();
      expect(record!.resourceType).toBe('project');
      expect(record!.status).toBe('open');
      expect(record!.severity).toBe('high');
      expect(record!.reporterId).toBeDefined();

      // Verify audit log was written
      const auditLog = await AuditLogModel.findOne({
        action: 'content.reported',
        'details.modId': response.body.modId,
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.resourceType).toBe('moderation');
      expect(auditLog!.actorId?.toString()).toBe(creatorUserId);
    });

    it('T63.1 - should allow anonymous reporting', async () => {
      // Arrange
      const payload = {
        resourceType: 'asset',
        resourceId: new Types.ObjectId().toString(),
        reason: 'This asset violates copyright and intellectual property rights.',
        severity: 'legal',
      };

      // Act: Report without authentication
      const response = await request(app).post('/moderation/report').send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('modId');
      expect(response.body).toHaveProperty('status', 'open');

      // Verify record was created (reporterId should be undefined for anonymous)
      const record = await ModerationRecordModel.findOne({ modId: response.body.modId });
      expect(record).toBeDefined();
      expect(record!.reporterId).toBeUndefined();
      expect(record!.severity).toBe('legal');
    });

    it('should return 422 for invalid resource type', async () => {
      // Arrange
      const payload = {
        resourceType: 'invalid_type',
        resourceId: new Types.ObjectId().toString(),
        reason: 'This is a test report with sufficient length.',
      };

      // Act
      const response = await request(app).post('/moderation/report').send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 422 for reason too short', async () => {
      // Arrange
      const payload = {
        resourceType: 'user',
        resourceId: new Types.ObjectId().toString(),
        reason: 'Short', // Less than 10 characters
      };

      // Act
      const response = await request(app).post('/moderation/report').send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /admin/moderation/queue', () => {
    it('T63.2 - should successfully retrieve moderation queue (200 OK)', async () => {
      // Arrange: Create moderation records
      await ModerationRecordModel.create([
        {
          modId: 'mod_test_1',
          resourceType: 'project',
          resourceId: new Types.ObjectId(),
          severity: 'high',
          status: 'open',
          actions: [],
        },
        {
          modId: 'mod_test_2',
          resourceType: 'user',
          resourceId: new Types.ObjectId(),
          severity: 'medium',
          status: 'open',
          actions: [],
        },
        {
          modId: 'mod_test_3',
          resourceType: 'asset',
          resourceId: new Types.ObjectId(),
          severity: 'low',
          status: 'closed',
          actions: [],
        },
      ]);

      // Act
      const response = await request(app)
        .get('/admin/moderation/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(response.body.meta).toHaveProperty('total', 3);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(3);
      expect(response.body.data[0]).toHaveProperty('modId');
      expect(response.body.data[0]).toHaveProperty('resourceType');
      expect(response.body.data[0]).toHaveProperty('status');
      expect(response.body.data[0]).toHaveProperty('severity');
    });

    it('T63.2 - should filter by status', async () => {
      // Arrange
      await ModerationRecordModel.create([
        {
          modId: 'mod_status_1',
          resourceType: 'project',
          resourceId: new Types.ObjectId(),
          severity: 'high',
          status: 'open',
          actions: [],
        },
        {
          modId: 'mod_status_2',
          resourceType: 'user',
          resourceId: new Types.ObjectId(),
          severity: 'medium',
          status: 'closed',
          actions: [],
        },
      ]);

      // Act: Filter by status=open
      const response = await request(app)
        .get('/admin/moderation/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ status: 'open', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0].status).toBe('open');
    });

    it('T63.2 - should filter by severity', async () => {
      // Arrange
      await ModerationRecordModel.create([
        {
          modId: 'mod_severity_1',
          resourceType: 'project',
          resourceId: new Types.ObjectId(),
          severity: 'high',
          status: 'open',
          actions: [],
        },
        {
          modId: 'mod_severity_2',
          resourceType: 'user',
          resourceId: new Types.ObjectId(),
          severity: 'medium',
          status: 'open',
          actions: [],
        },
      ]);

      // Act: Filter by severity=high
      const response = await request(app)
        .get('/admin/moderation/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ severity: 'high', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0].severity).toBe('high');
    });

    it('should return 403 for unauthorized access', async () => {
      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .get('/admin/moderation/queue')
        .set('Authorization', `Bearer ${creatorToken}`)
        .query({ page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });
  });

  describe('POST /admin/moderation/:modId/action', () => {
    let testModId: string;

    beforeEach(async () => {
      // Create a test moderation record
      const record = await ModerationRecordModel.create({
        modId: 'mod_action_test',
        resourceType: 'user',
        resourceId: new Types.ObjectId(),
        severity: 'high',
        status: 'open',
        actions: [
          {
            action: 'report_filed',
            by: new Types.ObjectId(),
            notes: 'Initial report',
            createdAt: new Date(),
          },
        ],
      });
      testModId = record.modId;
    });

    it('T63.3 - should successfully take action (suspend_user) (200 OK)', async () => {
      // Arrange
      const payload = {
        action: 'suspend_user',
        notes: 'User has been found in violation of community guidelines. Suspending account immediately.',
      };

      // Act
      const response = await request(app)
        .post(`/admin/moderation/${testModId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('modId', testModId);
      expect(response.body).toHaveProperty('status', 'actioned');
      expect(response.body).toHaveProperty('actionTaken', 'suspend_user');
      expect(response.body).toHaveProperty('message');

      // Verify record was updated
      const record = await ModerationRecordModel.findOne({ modId: testModId });
      expect(record).toBeDefined();
      expect(record!.status).toBe('actioned');
      expect(record!.actions).toHaveLength(2);
      expect(record!.actions[1]).toBeDefined();
      if (record!.actions[1]) {
        expect(record!.actions[1].action).toBe('suspend_user');
        expect(record!.actions[1].by.toString()).toBe(adminUserId);
      }
      expect(record!.assignedTo?.toString()).toBe(adminUserId);

      // Verify audit log was written
      const auditLog = await AuditLogModel.findOne({
        action: 'moderation.action.suspend_user',
        'details.modId': testModId,
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.actorId?.toString()).toBe(adminUserId);
      expect(auditLog!.actorRole).toBe('admin');
    });

    it('T63.3 - should successfully take action (takedown)', async () => {
      // Arrange
      const payload = {
        action: 'takedown',
        notes: 'Content violates terms of service. Removing content immediately.',
      };

      // Act
      const response = await request(app)
        .post(`/admin/moderation/${testModId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.actionTaken).toBe('takedown');

      // Verify audit log was written
      const auditLog = await AuditLogModel.findOne({
        action: 'moderation.action.takedown',
        'details.modId': testModId,
      });
      expect(auditLog).toBeDefined();
    });

    it('T63.4 - should return 403 for unauthorized access', async () => {
      // Arrange
      const payload = {
        action: 'warn',
        notes: 'Warning issued to user.',
      };

      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .post(`/admin/moderation/${testModId}/action`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('T63.5 - should return 409 for double action (already processed)', async () => {
      // Arrange: First action
      await ModerationRecordModel.updateOne(
        { modId: testModId },
        {
          $set: { status: 'actioned' },
          $push: {
            actions: {
              action: 'suspend_user',
              by: new Types.ObjectId(adminUserId),
              notes: 'First action',
              createdAt: new Date(),
            },
          },
        }
      );

      const payload = {
        action: 'warn',
        notes: 'Attempting second action on already processed record.',
      };

      // Act: Try to take action again
      const response = await request(app)
        .post(`/admin/moderation/${testModId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('already_processed');
    });

    it('should return 404 for non-existent moderation record', async () => {
      // Arrange
      const payload = {
        action: 'warn',
        notes: 'Warning issued.',
      };

      // Act
      const response = await request(app)
        .post('/admin/moderation/non_existent_mod/action')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('record_not_found');
    });

    it('should return 422 for invalid action', async () => {
      // Arrange
      const payload = {
        action: 'invalid_action',
        notes: 'Invalid action attempt.',
      };

      // Act
      const response = await request(app)
        .post(`/admin/moderation/${testModId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 422 for notes too short', async () => {
      // Arrange
      const payload = {
        action: 'warn',
        notes: 'Hi', // Less than 5 characters
      };

      // Act
      const response = await request(app)
        .post(`/admin/moderation/${testModId}/action`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });
  });
});

