import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';

describe('RBAC Integration Tests', () => {
  let creatorToken: string;
  let ownerToken: string;
  let adminToken: string;
  let suspendedAdminToken: string;

  // Test database connection setup
  beforeAll(async () => {
    // Use test database
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
    // Clean up database before each test
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});

    // Create test users and get their tokens
    // 1. Creator (active)
    const creatorResponse = await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'Password123',
      role: 'creator',
    });
    creatorToken = creatorResponse.body.accessToken;

    // 2. Owner (active)
    const ownerResponse = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
    });
    ownerToken = ownerResponse.body.accessToken;

    // 3. Admin (active)
    const adminResponse = await request(app).post('/auth/signup').send({
      email: 'admin@example.com',
      password: 'Password123',
      role: 'creator', // Note: We'll manually update to admin in DB
    });
    adminToken = adminResponse.body.accessToken;

    // Update admin user role in DB
    await UserModel.findOneAndUpdate({ email: 'admin@example.com' }, { role: 'admin' });

    // 4. Suspended Admin
    const suspendedAdminResponse = await request(app).post('/auth/signup').send({
      email: 'suspended-admin@example.com',
      password: 'Password123',
      role: 'creator',
    });
    suspendedAdminToken = suspendedAdminResponse.body.accessToken;

    // Update suspended admin in DB
    await UserModel.findOneAndUpdate(
      { email: 'suspended-admin@example.com' },
      { role: 'admin', status: 'suspended' }
    );
  });

  describe('GET /users/admin/all', () => {
    it('should return 401 when no authorization token is provided (T2.1)', async () => {
      // Act
      const response = await request(app).get('/users/admin/all');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'no_token');
      expect(response.body.error).toHaveProperty(
        'message',
        'Authentication token is missing or malformed.'
      );
    });

    it('should return 401 when invalid token is provided (T2.2)', async () => {
      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', 'Bearer invalid.jwt.token');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'invalid_token');
      expect(response.body.error).toHaveProperty(
        'message',
        'Authentication token is invalid or has expired.'
      );
    });

    it('should return 401 when malformed authorization header (no Bearer)', async () => {
      // Act
      const response = await request(app).get('/users/admin/all').set('Authorization', 'InvalidToken');

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should return 403 when creator tries to access admin route (T2.3 - Forbidden Role)', async () => {
      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', `Bearer ${creatorToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error).toHaveProperty(
        'message',
        'You do not have the required role or permissions.'
      );
    });

    it('should return 403 when owner tries to access admin route', async () => {
      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', `Bearer ${ownerToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should return 403 when suspended admin tries to access (T2.4 - Suspended Status)', async () => {
      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', `Bearer ${suspendedAdminToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'account_inactive');
      expect(response.body.error.message).toContain('suspended');
    });

    it('should return 200 when active admin accesses the route (T2.5 - Admin Success)', async () => {
      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty(
        'message',
        'ADMIN ACCESS GRANTED: Successfully retrieved mock list of all users.'
      );
      expect(response.body).toHaveProperty('userId');
      expect(response.body).toHaveProperty('role', 'admin');
    });

    it('should return 401 when user is deleted after token generation', async () => {
      // Arrange - Delete the creator user
      await UserModel.findOneAndDelete({ email: 'creator@example.com' });

      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', `Bearer ${creatorToken}`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'user_not_found');
      expect(response.body.error).toHaveProperty('message', 'Authenticated user account not found.');
    });
  });

  describe('Permission Check Logic', () => {
    it('should verify that admin role has all required permissions', async () => {
      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
    });

    it('should verify token payload is accessible in controller', async () => {
      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('userId');
      expect(response.body).toHaveProperty('role');
      expect(response.body.role).toBe('admin');
    });
  });

  describe('Status Check Logic', () => {
    it('should allow access for pending status to be denied', async () => {
      // Arrange - Set admin to pending status
      await UserModel.findOneAndUpdate({ email: 'admin@example.com' }, { status: 'pending' });

      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'account_inactive');
    });

    it('should allow access for deleted status to be denied', async () => {
      // Arrange - Set admin to deleted status
      await UserModel.findOneAndUpdate({ email: 'admin@example.com' }, { status: 'deleted' });

      // Act
      const response = await request(app)
        .get('/users/admin/all')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'account_inactive');
    });
  });
});

