import request from 'supertest';
import app from '../../src/server';
import { AuditLogModel } from '../../src/models/auditLog.model';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import mongoose from 'mongoose';

describe('Audit Log API Integration Tests (Task 60)', () => {
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
    await AuditLogModel.deleteMany({});
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

  describe('POST /admin/audit', () => {
    it('T60.1 - should successfully create genesis log (201 Created)', async () => {
      // Arrange: Ensure no logs exist (genesis block)
      await AuditLogModel.deleteMany({});

      const payload = {
        resourceType: 'system',
        action: 'system.initialized',
        details: { message: 'System initialized' },
      };

      // Act
      const response = await request(app)
        .post('/admin/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('auditId');
      expect(response.body.data).toHaveProperty('hash');
      expect(response.body.data).toHaveProperty('previousHash');
      expect(response.body.data.previousHash).toBe(
        '0000000000000000000000000000000000000000000000000000000000000000'
      );
      expect(response.body.data.hash).toMatch(/^[a-f0-9]{64}$/);

      // Verify log in database
      const log = await AuditLogModel.findOne({ auditId: response.body.data.auditId });
      expect(log).toBeDefined();
      expect(log!.previousHash).toBe(
        '0000000000000000000000000000000000000000000000000000000000000000'
      );
    });

    it('T60.2 - should successfully create chained log (201 Created)', async () => {
      // Arrange: Create first log (genesis)
      const firstLogPayload = {
        resourceType: 'user',
        action: 'user.created',
        details: { userId: 'user_123' },
      };

      const firstResponse = await request(app)
        .post('/admin/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(firstLogPayload);

      expect(firstResponse.status).toBe(201);
      const firstHash = firstResponse.body.data.hash;

      // Arrange: Create second log (chained)
      const secondLogPayload = {
        resourceType: 'user',
        action: 'user.updated',
        details: { userId: 'user_123', changes: { name: 'John' } },
      };

      // Act
      const secondResponse = await request(app)
        .post('/admin/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(secondLogPayload);

      // Assert
      expect(secondResponse.status).toBe(201);
      expect(secondResponse.body.data).toHaveProperty('auditId');
      expect(secondResponse.body.data).toHaveProperty('hash');
      expect(secondResponse.body.data).toHaveProperty('previousHash');
      expect(secondResponse.body.data.previousHash).toBe(firstHash); // Chained to first log
      expect(secondResponse.body.data.hash).not.toBe(firstHash);

      // Verify chain integrity in database
      const secondLog = await AuditLogModel.findOne({ auditId: secondResponse.body.data.auditId });
      expect(secondLog).toBeDefined();
      expect(secondLog!.previousHash).toBe(firstHash);

      const firstLog = await AuditLogModel.findOne({ auditId: firstResponse.body.data.auditId });
      expect(firstLog).toBeDefined();
      expect(firstLog!.hash).toBe(firstHash);
    });

    it('T60.3 - should return 403 for unauthorized access', async () => {
      // Arrange
      const payload = {
        resourceType: 'user',
        action: 'user.suspended',
        details: { userId: 'user_123' },
      };

      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .post('/admin/audit')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('should return 422 for missing required fields', async () => {
      // Arrange: Missing resourceType
      const payload = {
        action: 'user.suspended',
        details: { userId: 'user_123' },
      };

      // Act
      const response = await request(app)
        .post('/admin/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 422 for invalid action length', async () => {
      // Arrange: Action too short (< 5 characters)
      const payload = {
        resourceType: 'user',
        action: 'abc',
        details: { userId: 'user_123' },
      };

      // Act
      const response = await request(app)
        .post('/admin/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should include actor information from authenticated user', async () => {
      // Arrange
      const payload = {
        resourceType: 'user',
        action: 'user.suspended',
        details: { userId: 'user_123' },
      };

      // Act
      const response = await request(app)
        .post('/admin/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);

      // Verify actorId is stored in database
      const log = await AuditLogModel.findOne({ auditId: response.body.data.auditId });
      expect(log).toBeDefined();
      expect(log!.actorId).toBeDefined();
      expect(log!.actorId!.toString()).toBe(adminUserId);
      expect(log!.actorRole).toBe('admin');
    });

    it('should handle resourceId when provided', async () => {
      // Arrange
      const resourceId = new mongoose.Types.ObjectId();
      const payload = {
        resourceType: 'user',
        resourceId: resourceId.toString(),
        action: 'user.updated',
        details: { changes: { name: 'John' } },
      };

      // Act
      const response = await request(app)
        .post('/admin/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);

      // Verify resourceId is stored
      const log = await AuditLogModel.findOne({ auditId: response.body.data.auditId });
      expect(log).toBeDefined();
      expect(log!.resourceId).toBeDefined();
      expect(log!.resourceId!.toString()).toBe(resourceId.toString());
    });
  });
});

