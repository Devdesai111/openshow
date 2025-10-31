import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';

describe('Re-ranker Hook API Integration Tests', () => {
  let adminToken: string;
  let creatorToken: string;

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
  });

  describe('POST /admin/search/rerank-hook', () => {
    it('T45.1 - should successfully re-rank results (200 OK)', async () => {
      // Arrange
      const payload = {
        query: 'video editor',
        results: [
          { docId: 'creator_a', score: 0.85, features: { completion_rate: 0.8 } },
          { docId: 'creator_b', score: 0.75, features: { completion_rate: 0.7 } },
        ],
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('query', 'video editor');
      expect(response.body).toHaveProperty('rerankedResults');
      expect(Array.isArray(response.body.rerankedResults)).toBe(true);
      expect(response.body.rerankedResults.length).toBe(2);
      expect(response.body.rerankedResults[0]).toHaveProperty('docId');
      expect(response.body.rerankedResults[0]).toHaveProperty('finalScore');
    });

    it('T45.2 - should boost scores for high completion_rate', async () => {
      // Arrange
      const payload = {
        query: 'video editor',
        results: [
          { docId: 'creator_a', score: 0.85, features: { completion_rate: 0.95 } }, // Should be boosted
          { docId: 'creator_b', score: 0.75, features: { completion_rate: 0.7 } }, // No boost
        ],
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      const boostedDoc = response.body.rerankedResults.find((r: any) => r.docId === 'creator_a');
      const normalDoc = response.body.rerankedResults.find((r: any) => r.docId === 'creator_b');

      expect(boostedDoc).toBeDefined();
      expect(normalDoc).toBeDefined();

      // Boosted doc should have score increased by ~0.1
      expect(boostedDoc.finalScore).toBeGreaterThan(0.85);
      expect(boostedDoc.finalScore).toBeCloseTo(0.95, 1); // 0.85 + 0.1 = 0.95

      // Normal doc should have original score
      expect(normalDoc.finalScore).toBe(0.75);
    });

    it('T45.3 - should return 403 for non-admin user (403 Forbidden)', async () => {
      // Arrange
      const payload = {
        query: 'test query',
        results: [{ docId: 'doc_1', score: 0.8, features: {} }],
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('T45.4 - should return 422 for missing results array', async () => {
      // Arrange
      const payload = {
        query: 'test query',
        // Missing results array
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for missing query', async () => {
      // Arrange
      const payload = {
        results: [{ docId: 'doc_1', score: 0.8, features: {} }],
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for empty results array', async () => {
      // Arrange
      const payload = {
        query: 'test query',
        results: [], // Empty array
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for invalid score (out of range)', async () => {
      // Arrange
      const payload = {
        query: 'test query',
        results: [{ docId: 'doc_1', score: 1.5, features: {} }], // Score > 1.0
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for missing docId in results', async () => {
      // Arrange
      const payload = {
        query: 'test query',
        results: [{ score: 0.8, features: {} }], // Missing docId
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Arrange
      const payload = {
        query: 'test query',
        results: [{ docId: 'doc_1', score: 0.8, features: {} }],
      };

      // Act
      const response = await request(app).post('/admin/search/rerank-hook').send(payload);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should sort results by finalScore descending', async () => {
      // Arrange
      const payload = {
        query: 'test query',
        results: [
          { docId: 'doc_1', score: 0.5, features: { completion_rate: 0.95 } }, // Will be boosted
          { docId: 'doc_2', score: 0.8, features: { completion_rate: 0.7 } }, // Higher base score
          { docId: 'doc_3', score: 0.6, features: { completion_rate: 0.92 } }, // Will be boosted
        ],
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      const results = response.body.rerankedResults;

      // Results should be sorted by finalScore DESC
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].finalScore).toBeGreaterThanOrEqual(results[i + 1].finalScore);
      }
    });

    it('should cap final scores at 1.0', async () => {
      // Arrange - High score that would exceed 1.0 after boost
      const payload = {
        query: 'test query',
        results: [
          { docId: 'doc_1', score: 0.95, features: { completion_rate: 0.95 } }, // 0.95 + 0.1 = 1.05, should cap at 1.0
        ],
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.rerankedResults[0].finalScore).toBe(1.0);
      expect(response.body.rerankedResults[0].finalScore).toBeLessThanOrEqual(1.0);
    });

    it('should preserve query in response', async () => {
      // Arrange
      const payload = {
        query: 'preserve this query string',
        results: [{ docId: 'doc_1', score: 0.8, features: {} }],
      };

      // Act
      const response = await request(app)
        .post('/admin/search/rerank-hook')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.query).toBe('preserve this query string');
    });
  });
});

