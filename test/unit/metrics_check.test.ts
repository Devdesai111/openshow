// test/unit/metrics_check.test.ts
import request from 'supertest';
import app from '../../src/server';
import { httpRequestsTotal, getMetricsRegistry } from '../../src/utils/metrics.utility';

describe('Metrics, Monitoring & Alerting Integration (Task 75)', () => {
  beforeEach(() => {
    // Reset counters between tests
    // Note: In a real implementation, we'd have a reset method, but for now we'll work with the existing state
  });

  describe('T75.1 - Counter Check', () => {
    it('should increment httpRequestsTotal counter for successful request to /health', async () => {
      // Arrange: Get initial count (if any)
      const initialCount = httpRequestsTotal.get({ method: 'GET', path: '/health', status: '200' });

      // Act: Make a request to /health
      const response = await request(app).get('/health');

      // Assert
      expect(response.status).toBe(200);
      
      // Check that the counter was incremented
      const finalCount = httpRequestsTotal.get({ method: 'GET', path: '/health', status: '200' });
      expect(finalCount).toBeGreaterThan(initialCount);
    });
  });

  describe('T75.2 - Error Check', () => {
    it('should increment httpRequestsTotal counter for error responses', async () => {
      // Arrange: Make a request to a non-existent endpoint (should return 404)
      const initialCount = httpRequestsTotal.get({ method: 'GET', path: '/nonexistent', status: '404' });

      // Act: Make a request to non-existent endpoint
      const response = await request(app).get('/nonexistent');

      // Assert
      expect(response.status).toBe(404);
      
      // Check that the counter was incremented
      const finalCount = httpRequestsTotal.get({ method: 'GET', path: '/nonexistent', status: '404' });
      expect(finalCount).toBeGreaterThan(initialCount);
    });
  });

  describe('T75.3 - Metrics Endpoint Access', () => {
    it('should return 200 OK with Prometheus format for Admin user', async () => {
      // Arrange: Create admin user and get token
      await request(app).post('/auth/signup').send({
        email: 'admin_metrics@test.com',
        password: 'Admin123!',
        preferredName: 'Admin Metrics',
        fullName: 'Admin Metrics',
        role: 'creator',
      });

      // Update user to admin role
      const { UserModel } = await import('../../src/models/user.model');
      const adminUser = await UserModel.findOne({ email: 'admin_metrics@test.com' });
      expect(adminUser).toBeDefined();
      await UserModel.findOneAndUpdate(
        { _id: adminUser!._id },
        {
          $set: {
            role: 'admin',
            status: 'active',
            twoFA: { enabled: true, enabledAt: new Date() },
          },
        },
        { new: true }
      );

      // Login as admin
      const loginResponse = await request(app).post('/auth/login').send({
        email: 'admin_metrics@test.com',
        password: 'Admin123!',
      });

      expect(loginResponse.status).toBe(200);
      const adminToken = loginResponse.body.accessToken;

      // Act: Access metrics endpoint
      const response = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      
      // Check that the response contains Prometheus format
      expect(response.text).toContain('# HELP');
      expect(response.text).toContain('# TYPE');
      expect(response.text).toContain('http_requests_total');
      expect(response.text).toContain('http_request_duration_seconds');
    });
  });

  describe('T75.4 - Access Control', () => {
    it('should return 403 Forbidden for non-Admin user', async () => {
      // Arrange: Create creator user and get token
      await request(app).post('/auth/signup').send({
        email: 'creator_metrics@test.com',
        password: 'Creator123!',
        preferredName: 'Creator Metrics',
        fullName: 'Creator Metrics',
        role: 'creator',
      });

      // Login as creator
      const loginResponse = await request(app).post('/auth/login').send({
        email: 'creator_metrics@test.com',
        password: 'Creator123!',
      });

      expect(loginResponse.status).toBe(200);
      const creatorToken = loginResponse.body.accessToken;

      // Act: Try to access metrics endpoint as creator
      const response = await request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${creatorToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });
  });

  describe('Metrics Middleware Integration', () => {
    it('should record request duration in histogram', async () => {
      // Act: Make a request to /health
      await request(app).get('/health');

      // Small delay to ensure metrics are recorded
      await new Promise(resolve => setTimeout(resolve, 10));

      // Assert: Check that duration metrics are present in the registry
      const metrics = await getMetricsRegistry();
      expect(metrics).toContain('http_request_duration_seconds');
    });
  });
});

