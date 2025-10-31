import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { DiscoveryService } from '../../src/services/discovery.service';

describe('Indexing API Integration Tests', () => {
  let adminToken: string;
  let creatorToken: string;
  let docId: string;

  const discoveryService = new DiscoveryService();

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
    discoveryService._clearMockIndexStore();

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

    // Create creator user
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Creator User',
    });
    creatorToken = creatorSignup.body.accessToken;

    docId = new mongoose.Types.ObjectId().toString();
  });

  describe('POST /search/index-update', () => {
    it('T41.1 - should successfully index a new document (200 OK)', async () => {
      // Act
      const response = await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'creator',
          docId,
          payload: {
            headline: 'AI Video Editor (Freelance)',
            skills: ['video-editing', 'prompt-engineering'],
          },
          updatedAt: new Date().toISOString(),
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('docId', docId);
      expect(response.body).toHaveProperty('status', 'indexed');
      expect(response.body).toHaveProperty('updatedAt');

      // Verify document was stored in mock index
      const mockStore = discoveryService._getMockIndexStore();
      const indexKey = `creator_${docId}`;
      const storedDoc = mockStore.get(indexKey);
      expect(storedDoc).toBeDefined();
      expect(storedDoc.headline).toBe('AI Video Editor (Freelance)');
    });

    it('T41.2 - should return 403 for non-admin user (403 Forbidden)', async () => {
      // Act
      const response = await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          docType: 'creator',
          docId,
          payload: { headline: 'Test' },
          updatedAt: new Date().toISOString(),
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('T41.3 - should return 200 with ignored status for stale update', async () => {
      // Arrange - Index a document first
      const firstUpdate = new Date().toISOString();
      await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'creator',
          docId,
          payload: { headline: 'First Update' },
          updatedAt: firstUpdate,
        });

      // Act - Try to update with older timestamp
      const secondUpdate = new Date(Date.now() - 10000).toISOString();
      const response = await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'creator',
          docId,
          payload: { headline: 'Stale Update' },
          updatedAt: secondUpdate,
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ignored');
      expect(response.body.message).toContain('older than the current indexed document');

      // Verify document was NOT updated
      const mockStore = discoveryService._getMockIndexStore();
      const indexKey = `creator_${docId}`;
      const storedDoc = mockStore.get(indexKey);
      expect(storedDoc.headline).toBe('First Update'); // Should remain unchanged
    });

    it('T41.4 - should return 422 for missing updatedAt', async () => {
      // Act
      const response = await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'creator',
          docId,
          payload: { headline: 'Test' },
          // Missing updatedAt
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for invalid docType', async () => {
      // Act
      const response = await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'invalid_type',
          docId,
          payload: { headline: 'Test' },
          updatedAt: new Date().toISOString(),
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for invalid docId format', async () => {
      // Act
      const response = await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'creator',
          docId: 'invalid_id',
          payload: { headline: 'Test' },
          updatedAt: new Date().toISOString(),
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for missing payload', async () => {
      // Act
      const response = await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'creator',
          docId,
          // Missing payload
          updatedAt: new Date().toISOString(),
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).post('/search/index-update').send({
        docType: 'creator',
        docId,
        payload: { headline: 'Test' },
        updatedAt: new Date().toISOString(),
      });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should successfully update document with newer timestamp', async () => {
      // Arrange - Index a document first
      const firstUpdate = new Date(Date.now() - 10000).toISOString();
      await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'project',
          docId,
          payload: { title: 'Original Title' },
          updatedAt: firstUpdate,
        });

      // Act - Update with newer timestamp
      const secondUpdate = new Date().toISOString();
      const response = await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'project',
          docId,
          payload: { title: 'Updated Title', status: 'active' },
          updatedAt: secondUpdate,
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'indexed');

      // Verify document was updated
      const mockStore = discoveryService._getMockIndexStore();
      const indexKey = `project_${docId}`;
      const storedDoc = mockStore.get(indexKey);
      expect(storedDoc.title).toBe('Updated Title');
      expect(storedDoc.status).toBe('active');
      expect(storedDoc.updatedAt).toBe(secondUpdate);
    });

    it('should handle project document type', async () => {
      // Act
      const response = await request(app)
        .post('/search/index-update')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          docType: 'project',
          docId,
          payload: {
            title: 'Test Project',
            category: 'Film Production',
            status: 'active',
          },
          updatedAt: new Date().toISOString(),
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('docId', docId);
      expect(response.body).toHaveProperty('status', 'indexed');

      // Verify document was stored
      const mockStore = discoveryService._getMockIndexStore();
      const indexKey = `project_${docId}`;
      const storedDoc = mockStore.get(indexKey);
      expect(storedDoc).toBeDefined();
      expect(storedDoc.title).toBe('Test Project');
      expect(storedDoc.category).toBe('Film Production');
    });
  });
});
