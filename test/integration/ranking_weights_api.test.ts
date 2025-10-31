import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { getCurrentRankingWeights, _resetRankingWeights, DEFAULT_WEIGHTS } from '../../src/config/rankingWeights';

describe('Ranking Weights API Integration Tests', () => {
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
    _resetRankingWeights();

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

  describe('PUT /admin/ranking/weights', () => {
    it('T42.2 - should successfully update weights (200 OK)', async () => {
      // Arrange
      const newWeights = {
        alpha: 0.5,
        beta: 0.2,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const experimentId = 'test_experiment_1';

      // Act
      const response = await request(app)
        .put('/admin/ranking/weights')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          experimentId,
          weights: newWeights,
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'updated');
      expect(response.body).toHaveProperty('experimentId', experimentId);
      expect(response.body).toHaveProperty('updatedAt');
      expect(response.body).toHaveProperty('activeWeights');
      expect(response.body.activeWeights).toEqual(newWeights);

      // Verify weights are actually updated
      const currentWeights = getCurrentRankingWeights();
      expect(currentWeights).toEqual(newWeights);
    });

    it('T42.3 - should return 422 for invalid weight sum', async () => {
      // Arrange
      const invalidWeights = {
        alpha: 0.2,
        beta: 0.15,
        gamma: 0.1,
        delta: 0.05,
        epsilon: 0.05, // Sum = 0.55
      };

      // Act
      const response = await request(app)
        .put('/admin/ranking/weights')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          experimentId: 'test_experiment',
          weights: invalidWeights,
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('non-negative and sum to 1.0');
    });

    it('should return 422 for negative weight value', async () => {
      // Arrange
      const invalidWeights = {
        alpha: 0.5,
        beta: -0.2, // Negative value
        gamma: 0.2,
        delta: 0.3,
        epsilon: 0.2,
      };

      // Act
      const response = await request(app)
        .put('/admin/ranking/weights')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          experimentId: 'test_experiment',
          weights: invalidWeights,
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('T42.4 - should return 403 for non-admin user (403 Forbidden)', async () => {
      // Arrange
      const newWeights = {
        alpha: 0.5,
        beta: 0.2,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };

      // Act
      const response = await request(app)
        .put('/admin/ranking/weights')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({
          experimentId: 'test_experiment',
          weights: newWeights,
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should return 422 for missing experimentId', async () => {
      // Act
      const response = await request(app)
        .put('/admin/ranking/weights')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          weights: DEFAULT_WEIGHTS,
          // Missing experimentId
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for missing weights', async () => {
      // Act
      const response = await request(app)
        .put('/admin/ranking/weights')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          experimentId: 'test_experiment',
          // Missing weights
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for missing weight fields', async () => {
      // Act
      const response = await request(app)
        .put('/admin/ranking/weights')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          experimentId: 'test_experiment',
          weights: {
            alpha: 0.5,
            // Missing beta, gamma, delta, epsilon
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .put('/admin/ranking/weights')
        .send({
          experimentId: 'test_experiment',
          weights: DEFAULT_WEIGHTS,
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should update weights and preserve existing config on subsequent call', async () => {
      // Arrange - First update
      const weights1 = {
        alpha: 0.5,
        beta: 0.2,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const response1 = await request(app)
        .put('/admin/ranking/weights')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          experimentId: 'same_experiment',
          weights: weights1,
        });

      expect(response1.status).toBe(200);
      const firstUpdatedAt = response1.body.updatedAt;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      // Act - Second update with same experiment ID
      const weights2 = {
        alpha: 0.4,
        beta: 0.3,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const response2 = await request(app)
        .put('/admin/ranking/weights')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          experimentId: 'same_experiment',
          weights: weights2,
        });

      // Assert
      expect(response2.status).toBe(200);
      expect(response2.body.activeWeights).toEqual(weights2);
      expect(response2.body.updatedAt).not.toBe(firstUpdatedAt); // Should be updated
    });
  });

  describe('applyBlendedRanking', () => {
    it('should apply blended ranking correctly with default weights', () => {
      // This test would be in the discovery service unit tests if we had direct access
      // For now, we'll verify the weights are accessible
      const weights = getCurrentRankingWeights();
      expect(weights).toBeDefined();
      expect(weights.alpha + weights.beta + weights.gamma + weights.delta + weights.epsilon).toBeCloseTo(1.0, 2);
    });
  });
});

