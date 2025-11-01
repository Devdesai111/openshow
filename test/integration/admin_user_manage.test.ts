import request from 'supertest';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuditLogModel } from '../../src/models/auditLog.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import mongoose from 'mongoose';
import { Types } from 'mongoose';

describe('Admin User Management API Integration Tests (Task 64)', () => {
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
    await UserModel.deleteMany({});
    await AuditLogModel.deleteMany({});
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
    const creatorLogin = await request(app).post('/auth/login').send({
      email: 'creator@test.com',
      password: 'Creator123!',
    });
    expect(creatorLogin.status).toBe(200);
    creatorToken = creatorLogin.body.data?.token || creatorLogin.body.accessToken;
    expect(creatorToken).toBeDefined();
  });

  describe('GET /admin/users', () => {
    it('T64.1 - should successfully return full list of users (200 OK)', async () => {
      // Arrange: Create additional users
      await UserModel.create([
        {
          email: 'user1@test.com',
          preferredName: 'User One',
          fullName: 'User One',
          role: 'creator',
          status: 'active',
          hashedPassword: 'hash1',
        },
        {
          email: 'user2@test.com',
          preferredName: 'User Two',
          fullName: 'User Two',
          role: 'owner',
          status: 'active',
          hashedPassword: 'hash2',
        },
        {
          email: 'suspended@test.com',
          preferredName: 'Suspended User',
          fullName: 'Suspended User',
          role: 'creator',
          status: 'suspended',
          hashedPassword: 'hash3',
        },
      ]);

      // Act
      const response = await request(app)
        .get('/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta).toHaveProperty('page', 1);
      expect(response.body.meta).toHaveProperty('per_page', 20);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);

      // Verify full DTO includes email and status
      const firstUser = response.body.data[0];
      expect(firstUser).toHaveProperty('id');
      expect(firstUser).toHaveProperty('email');
      expect(firstUser).toHaveProperty('status');
      expect(firstUser).toHaveProperty('role');
      expect(firstUser).not.toHaveProperty('passwordHash'); // Should not include password hash
    });

    it('T64.1 - should filter by role', async () => {
      // Arrange: Create users with different roles
      await UserModel.create([
        {
          email: 'creator1@test.com',
          preferredName: 'Creator One',
          role: 'creator',
          status: 'active',
          hashedPassword: 'hash1',
        },
        {
          email: 'owner1@test.com',
          preferredName: 'Owner One',
          role: 'owner',
          status: 'active',
          hashedPassword: 'hash2',
        },
      ]);

      // Act: Filter by role=creator
      const response = await request(app)
        .get('/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ role: 'creator', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.every((u: any) => u.role === 'creator')).toBe(true);
    });

    it('T64.1 - should filter by status', async () => {
      // Arrange: Create users with different statuses
      await UserModel.create([
        {
          email: 'active@test.com',
          preferredName: 'Active User',
          role: 'creator',
          status: 'active',
          hashedPassword: 'hash1',
        },
        {
          email: 'suspended@test.com',
          preferredName: 'Suspended User',
          role: 'creator',
          status: 'suspended',
          hashedPassword: 'hash2',
        },
      ]);

      // Act: Filter by status=suspended
      const response = await request(app)
        .get('/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ status: 'suspended', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.every((u: any) => u.status === 'suspended')).toBe(true);
    });

    it('T64.1 - should search by query (email/name)', async () => {
      // Arrange: Create users
      await UserModel.create([
        {
          email: 'john.doe@test.com',
          preferredName: 'John',
          fullName: 'John Doe',
          role: 'creator',
          status: 'active',
          hashedPassword: 'hash1',
        },
        {
          email: 'jane.smith@test.com',
          preferredName: 'Jane',
          fullName: 'Jane Smith',
          role: 'creator',
          status: 'active',
          hashedPassword: 'hash2',
        },
      ]);

      // Act: Search for "john"
      const response = await request(app)
        .get('/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ q: 'john', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      const hasJohn = response.body.data.some((u: any) =>
        u.email.toLowerCase().includes('john') || u.fullName?.toLowerCase().includes('john')
      );
      expect(hasJohn).toBe(true);
    });

    it('T64.2 - should return 403 for unauthorized access', async () => {
      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .get('/admin/users')
        .set('Authorization', `Bearer ${creatorToken}`)
        .query({ page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });
  });

  describe('PUT /admin/users/:userId/role', () => {
    let targetUserId: string;

    beforeEach(async () => {
      // Create a target user to modify
      const targetUser = await UserModel.create({
        email: 'target@test.com',
        preferredName: 'Target User',
        fullName: 'Target User',
        role: 'creator',
        status: 'active',
        hashedPassword: 'hash',
      });
      targetUserId = targetUser._id!.toString();
    });

    it('T64.3 - should successfully change user role (200 OK)', async () => {
      // Arrange
      const payload = {
        newRole: 'owner',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('userId', targetUserId);
      expect(response.body).toHaveProperty('oldRole', 'creator');
      expect(response.body).toHaveProperty('newRole', 'owner');
      expect(response.body).toHaveProperty('message');

      // Verify database was updated
      const updatedUser = await UserModel.findById(targetUserId);
      expect(updatedUser).toBeDefined();
      expect(updatedUser!.role).toBe('owner');

      // Verify audit log was written
      const auditLog = await AuditLogModel.findOne({
        action: 'user.role.updated',
        resourceId: new Types.ObjectId(targetUserId),
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.actorId?.toString()).toBe(adminUserId);
      expect(auditLog!.details).toHaveProperty('oldRole', 'creator');
      expect(auditLog!.details).toHaveProperty('newRole', 'owner');
    });

    it('T64.3 - should change creator to admin', async () => {
      // Arrange
      const payload = {
        newRole: 'admin',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.newRole).toBe('admin');

      // Verify database was updated
      const updatedUser = await UserModel.findById(targetUserId);
      expect(updatedUser!.role).toBe('admin');
    });

    it('T64.4 - should return 403 for self-demotion (admin to owner)', async () => {
      // Arrange: Try to demote admin user's own role
      const payload = {
        newRole: 'owner',
      };

      // Act: Admin tries to demote themselves
      const response = await request(app)
        .put(`/admin/users/${adminUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
      expect(response.body.error.message).toContain('cannot demote themselves');

      // Verify role was not changed
      const user = await UserModel.findById(adminUserId);
      expect(user!.role).toBe('admin');
    });

    it('should return 403 for unauthorized access', async () => {
      // Arrange
      const payload = {
        newRole: 'owner',
      };

      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('should return 404 for non-existent user', async () => {
      // Arrange
      const nonExistentId = new Types.ObjectId().toString();
      const payload = {
        newRole: 'owner',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${nonExistentId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('user_not_found');
    });

    it('should return 422 for invalid role', async () => {
      // Arrange
      const payload = {
        newRole: 'invalid_role',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${targetUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should allow admin to keep their own admin role', async () => {
      // Arrange: Admin tries to set their own role to admin (no change)
      const payload = {
        newRole: 'admin',
      };

      // Act
      const response = await request(app)
        .put(`/admin/users/${adminUserId}/role`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert: Should succeed (no change, no demotion)
      expect(response.status).toBe(200);
      expect(response.body.newRole).toBe('admin');
    });
  });
});

