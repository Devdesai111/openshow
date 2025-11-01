import request from 'supertest';
import app from '../../src/server';
import { AuditLogModel } from '../../src/models/auditLog.model';
import { JobModel } from '../../src/models/job.model';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import mongoose from 'mongoose';

describe('Audit Log Query & Export API Integration Tests (Task 61)', () => {
  let adminToken: string;
  let creatorToken: string;
  let adminUserId: string;

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
    await AuditLogModel.deleteMany({});
    await JobModel.deleteMany({});
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});

    // Create admin user (signup as creator, then update role)
    const adminSignup = await request(app).post('/auth/signup').send({
      email: 'admin@test.com',
      password: 'Admin123!',
      preferredName: 'Admin User',
      fullName: 'Admin User',
      role: 'creator',
    });
    expect(adminSignup.status).toBe(201);
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
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'creator@test.com',
      password: 'Creator123!',
      preferredName: 'Creator User',
      fullName: 'Creator User',
      role: 'creator',
    });
    expect(creatorSignup.status).toBe(201);

    const creatorLogin = await request(app).post('/auth/login').send({
      email: 'creator@test.com',
      password: 'Creator123!',
    });
    expect(creatorLogin.status).toBe(200);
    creatorToken = creatorLogin.body.data?.token || creatorLogin.body.accessToken;
    expect(creatorToken).toBeDefined();
  });

  describe('GET /admin/audit-logs', () => {
    it('T61.1 - should successfully query audit logs with time filter (200 OK)', async () => {
      // Arrange: Create audit logs with different timestamps
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Create logs
      await AuditLogModel.create([
        {
          auditId: 'audit_001',
          resourceType: 'user',
          action: 'user.created',
          actorId: new mongoose.Types.ObjectId(adminUserId),
          actorRole: 'admin',
          timestamp: yesterday,
          details: { userId: 'user_123' },
          previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
          hash: 'hash001',
        },
        {
          auditId: 'audit_002',
          resourceType: 'user',
          action: 'user.updated',
          actorId: new mongoose.Types.ObjectId(adminUserId),
          actorRole: 'admin',
          timestamp: now,
          details: { userId: 'user_123', changes: { name: 'John' } },
          previousHash: 'hash001',
          hash: 'hash002',
        },
        {
          auditId: 'audit_003',
          resourceType: 'project',
          action: 'project.created',
          actorId: new mongoose.Types.ObjectId(adminUserId),
          actorRole: 'admin',
          timestamp: tomorrow,
          details: { projectId: 'project_456' },
          previousHash: 'hash002',
          hash: 'hash003',
        },
      ]);

      // Act: Query logs from today onwards
      const fromDate = now.toISOString().split('T')[0]; // Today's date
      const response = await request(app)
        .get('/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ from: fromDate, page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta).toHaveProperty('page', 1);
      expect(response.body.meta).toHaveProperty('per_page', 20);
      expect(Array.isArray(response.body.data)).toBe(true);
      // Should include logs from today and tomorrow (filtered by from date)
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('T61.1 - should filter by action', async () => {
      // Arrange: Create logs with different actions
      await AuditLogModel.create([
        {
          auditId: 'audit_action_1',
          resourceType: 'user',
          action: 'user.created',
          actorId: new mongoose.Types.ObjectId(adminUserId),
          actorRole: 'admin',
          timestamp: new Date(),
          details: {},
          previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
          hash: 'hash_action_1',
        },
        {
          auditId: 'audit_action_2',
          resourceType: 'user',
          action: 'user.suspended',
          actorId: new mongoose.Types.ObjectId(adminUserId),
          actorRole: 'admin',
          timestamp: new Date(),
          details: {},
          previousHash: 'hash_action_1',
          hash: 'hash_action_2',
        },
      ]);

      // Act: Filter by action
      const response = await request(app)
        .get('/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ action: 'user.created', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0]).toHaveProperty('action', 'user.created');
    });

    it('T61.1 - should filter by resourceType', async () => {
      // Arrange: Create logs with different resource types
      await AuditLogModel.create([
        {
          auditId: 'audit_type_1',
          resourceType: 'user',
          action: 'user.created',
          actorId: new mongoose.Types.ObjectId(adminUserId),
          actorRole: 'admin',
          timestamp: new Date(),
          details: {},
          previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
          hash: 'hash_type_1',
        },
        {
          auditId: 'audit_type_2',
          resourceType: 'project',
          action: 'project.created',
          actorId: new mongoose.Types.ObjectId(adminUserId),
          actorRole: 'admin',
          timestamp: new Date(),
          details: {},
          previousHash: 'hash_type_1',
          hash: 'hash_type_2',
        },
      ]);

      // Act: Filter by resourceType
      const response = await request(app)
        .get('/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ resourceType: 'user', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0]).toHaveProperty('resourceType', 'user');
    });

    it('T61.1 - should support pagination', async () => {
      // Arrange: Create multiple logs
      const logs = [];
      let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
      for (let i = 1; i <= 25; i++) {
        const hash = `hash_pag_${i}`;
        logs.push({
          auditId: `audit_pag_${i}`,
          resourceType: 'user',
          action: 'user.created',
          actorId: new mongoose.Types.ObjectId(adminUserId),
          actorRole: 'admin',
          timestamp: new Date(),
          details: { index: i },
          previousHash,
          hash,
        });
        previousHash = hash;
      }
      await AuditLogModel.create(logs);

      // Act: Request first page
      const response = await request(app)
        .get('/admin/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ page: 1, per_page: 10 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(25);
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.per_page).toBe(10);
      expect(response.body.meta.total_pages).toBe(3);
      expect(response.body.data).toHaveLength(10);
    });

    it('T61.2 - should return 403 for unauthorized access', async () => {
      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .get('/admin/audit-logs')
        .set('Authorization', `Bearer ${creatorToken}`)
        .query({ page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });
  });

  describe('POST /admin/audit-logs/export', () => {
    it('T61.3 - should successfully queue export job (202 Accepted)', async () => {
      // Arrange
      const payload = {
        filters: {
          resourceType: 'user',
          action: 'user.created',
        },
        format: 'csv',
      };

      // Act
      const response = await request(app)
        .post('/admin/audit-logs/export')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty('jobId');
      expect(response.body).toHaveProperty('status', 'queued');
      expect(response.body).toHaveProperty('message');

      // Verify job was created
      const job = await JobModel.findOne({ jobId: response.body.jobId });
      expect(job).toBeDefined();
      expect(job!.type).toBe('export.audit');
      expect(job!.status).toBe('queued');
      expect(job!.payload).toHaveProperty('format', 'csv');
      expect(job!.payload).toHaveProperty('exportFilters');
    });

    it('T61.3 - should queue job with correct payload', async () => {
      // Arrange
      const payload = {
        filters: {
          from: '2025-01-01',
          to: '2025-01-31',
          resourceType: 'project',
        },
        format: 'pdf',
      };

      // Act
      const response = await request(app)
        .post('/admin/audit-logs/export')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(202);
      const job = await JobModel.findOne({ jobId: response.body.jobId });
      expect(job).toBeDefined();
      expect(job!.payload.format).toBe('pdf');
      expect(job!.payload.exportFilters).toHaveProperty('from', '2025-01-01');
      expect(job!.payload.exportFilters).toHaveProperty('to', '2025-01-31');
      expect(job!.payload.exportFilters).toHaveProperty('resourceType', 'project');
      expect(job!.payload).toHaveProperty('requesterId', adminUserId);
    });

    it('T61.4 - should return 422 for invalid format', async () => {
      // Arrange
      const payload = {
        filters: {},
        format: 'json', // Invalid format
      };

      // Act
      const response = await request(app)
        .post('/admin/audit-logs/export')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('validation_error');
    });

    it('T61.4 - should return 422 for missing filters', async () => {
      // Arrange
      const payload = {
        format: 'csv',
        // Missing filters
      };

      // Act
      const response = await request(app)
        .post('/admin/audit-logs/export')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('T61.2 - should return 403 for unauthorized access', async () => {
      // Arrange
      const payload = {
        filters: {},
        format: 'csv',
      };

      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .post('/admin/audit-logs/export')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('should support ndjson format', async () => {
      // Arrange
      const payload = {
        filters: {
          resourceType: 'user',
        },
        format: 'ndjson',
      };

      // Act
      const response = await request(app)
        .post('/admin/audit-logs/export')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(202);
      const job = await JobModel.findOne({ jobId: response.body.jobId });
      expect(job).toBeDefined();
      expect(job!.payload.format).toBe('ndjson');
    });
  });
});

