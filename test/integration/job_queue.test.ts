import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { JobModel } from '../../src/models/job.model';

describe('Jobs & Worker Queue Integration Tests', () => {
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
    await JobModel.deleteMany({});

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

  describe('POST /jobs - Enqueue Job', () => {
    it('T52.1 - should successfully enqueue a job (201 Created)', async () => {
      // Arrange
      const payload = {
        type: 'thumbnail.create',
        payload: { assetId: 'asset_123', versionNumber: 1 },
        priority: 75,
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('jobId');
      expect(response.body).toHaveProperty('status', 'queued');
      expect(response.body).toHaveProperty('type', 'thumbnail.create');
      expect(response.body).toHaveProperty('nextRunAt');

      // Verify job in database
      const job = await JobModel.findOne({ jobId: response.body.jobId });
      expect(job).toBeDefined();
      expect(job!.status).toBe('queued');
      expect(job!.attempt).toBe(0);
      expect(job!.priority).toBe(75);
      expect(job!.maxAttempts).toBe(3); // Policy default for thumbnail.create
    });

    it('T52.2 - should return 403 for non-admin user (403 Forbidden)', async () => {
      // Arrange
      const payload = {
        type: 'thumbnail.create',
        payload: { assetId: 'asset_123', versionNumber: 1 },
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should require authentication', async () => {
      // Arrange
      const payload = {
        type: 'thumbnail.create',
        payload: { assetId: 'asset_123', versionNumber: 1 },
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .send(payload);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should return 422 for missing type', async () => {
      // Arrange
      const payload = {
        payload: { assetId: 'asset_123' },
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for missing payload', async () => {
      // Arrange
      const payload = {
        type: 'thumbnail.create',
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('T53.2 - should return 422 for missing required field', async () => {
      // Arrange: Missing versionNumber (required field)
      const payload = {
        type: 'thumbnail.create',
        payload: { assetId: 'asset_123' }, // Missing versionNumber
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('Missing required field');
    });

    it('T53.3 - should return 404 for unknown job type', async () => {
      // Arrange
      const payload = {
        type: 'unknown.job',
        payload: {},
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
      expect(response.body.error.message).toContain('not registered');
    });

    it('T53.4 - should apply policy maxAttempts when not provided', async () => {
      // Arrange
      const payload = {
        type: 'thumbnail.create',
        payload: { assetId: 'asset_123', versionNumber: 1 },
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);

      // Verify policy maxAttempts was applied
      const job = await JobModel.findOne({ jobId: response.body.jobId });
      expect(job).toBeDefined();
      expect(job!.maxAttempts).toBe(3); // Policy default for thumbnail.create
    });

    it('should allow overriding policy maxAttempts', async () => {
      // Arrange: Override maxAttempts
      const payload = {
        type: 'thumbnail.create',
        payload: { assetId: 'asset_123', versionNumber: 1 },
        maxAttempts: 10, // Override policy default of 3
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);

      // Verify override was applied
      const job = await JobModel.findOne({ jobId: response.body.jobId });
      expect(job).toBeDefined();
      expect(job!.maxAttempts).toBe(10); // Override value
    });

    it('should validate payout.execute job type', async () => {
      // Arrange
      const payload = {
        type: 'payout.execute',
        payload: { batchId: 'batch_123', escrowId: 'escrow_456' },
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('jobId');

      // Verify payout.execute policy was applied
      const job = await JobModel.findOne({ jobId: response.body.jobId });
      expect(job).toBeDefined();
      expect(job!.maxAttempts).toBe(10); // Policy default for payout.execute
    });

    it('should support scheduled jobs (scheduleAt in future)', async () => {
      // Arrange
      const futureDate = new Date(Date.now() + 60000); // 1 minute in future
      const payload = {
        type: 'payout.execute',
        payload: { batchId: 'batch_123', escrowId: 'escrow_456' },
        scheduleAt: futureDate.toISOString(),
      };

      // Act
      const response = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('jobId');
      expect(response.body).toHaveProperty('status', 'queued');

      // Verify job in database
      const job = await JobModel.findOne({ jobId: response.body.jobId });
      expect(job).toBeDefined();
      expect(job!.nextRunAt.getTime()).toBeCloseTo(futureDate.getTime(), -3); // Within 1 second
    });
  });

  describe('GET /jobs/lease - Lease Jobs', () => {
    it('T52.3 - should successfully lease a job (200 OK)', async () => {
      // Arrange: Create a queued job
      await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'thumbnail.create',
          payload: { assetId: 'asset_123', versionNumber: 1 },
        });

      const workerId = 'worker_123';

      // Act
      const response = await request(app)
        .get('/jobs/lease')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Worker-Id', workerId)
        .query({ limit: 1 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('leasedAt');
      expect(response.body).toHaveProperty('jobs');
      expect(Array.isArray(response.body.jobs)).toBe(true);
      expect(response.body.jobs.length).toBe(1);

      const leasedJob = response.body.jobs[0];
      expect(leasedJob).toHaveProperty('jobId');
      expect(leasedJob).toHaveProperty('type', 'thumbnail.create');
      expect(leasedJob).toHaveProperty('payload');
      expect(leasedJob).toHaveProperty('attempt', 1); // Should be incremented
      expect(leasedJob).toHaveProperty('leaseExpiresAt');

      // Verify job status in database
      const job = await JobModel.findOne({ jobId: leasedJob.jobId });
      expect(job).toBeDefined();
      expect(job!.status).toBe('leased');
      expect(job!.workerId).toBe(workerId);
      expect(job!.attempt).toBe(1);
      expect(job!.leaseExpiresAt).toBeDefined();
    });

    it('T52.4 - should atomically lease jobs (only one worker can claim same job)', async () => {
      // Arrange: Create a single job
      const createResponse = await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'thumbnail.create',
          payload: { assetId: 'asset_123', versionNumber: 1 },
        });
      const singleJobId = createResponse.body.jobId;

      // Act: Two workers try to lease simultaneously
      const [worker1Response, worker2Response] = await Promise.all([
        request(app)
          .get('/jobs/lease')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Worker-Id', 'worker_1')
          .query({ limit: 1 }),
        request(app)
          .get('/jobs/lease')
          .set('Authorization', `Bearer ${adminToken}`)
          .set('X-Worker-Id', 'worker_2')
          .query({ limit: 1 }),
      ]);

      // Assert: Only one worker should get the job
      const worker1Jobs = worker1Response.body.jobs || [];
      const worker2Jobs = worker2Response.body.jobs || [];
      const totalLeased = worker1Jobs.length + worker2Jobs.length;

      expect(totalLeased).toBe(1); // Only one job should be leased

      // Verify the job is leased to one worker
      const job = await JobModel.findOne({ jobId: singleJobId });
      expect(job).toBeDefined();
      expect(job!.status).toBe('leased');
      expect(job!.attempt).toBe(1);
    });

    it('T52.5 - should return empty array when no jobs available', async () => {
      // Arrange: No queued jobs (or all already leased)
      await JobModel.deleteMany({});

      // Act
      const response = await request(app)
        .get('/jobs/lease')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Worker-Id', 'worker_123')
        .query({ limit: 1 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('jobs');
      expect(Array.isArray(response.body.jobs)).toBe(true);
      expect(response.body.jobs.length).toBe(0);
    });

    it('should filter by job type when specified', async () => {
      // Arrange: Create jobs of different types
      await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'thumbnail.create',
          payload: { assetId: 'asset_123', versionNumber: 1 },
        });

      await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'payout.execute',
          payload: { batchId: 'batch_123', escrowId: 'escrow_456' },
        });

      // Act: Lease only 'thumbnail.create' jobs
      const response = await request(app)
        .get('/jobs/lease')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Worker-Id', 'worker_123')
        .query({ type: 'thumbnail.create', limit: 5 });

      // Assert: Should only get thumbnail.create job (payout.process was created but filter applies)
      expect(response.status).toBe(200);
      expect(response.body.jobs.length).toBe(1);
      expect(response.body.jobs[0].type).toBe('thumbnail.create');
    });

    it('should respect limit parameter', async () => {
      // Arrange: Create multiple jobs
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/jobs')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            type: 'thumbnail.create',
            payload: { assetId: `asset_${i}`, versionNumber: 1 },
          });
      }

      // Act: Lease with limit=2
      const response = await request(app)
        .get('/jobs/lease')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Worker-Id', 'worker_123')
        .query({ limit: 2 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.jobs.length).toBe(2);
    });

    it('should require X-Worker-Id header', async () => {
      // Act
      const response = await request(app)
        .get('/jobs/lease')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ limit: 1 });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .get('/jobs/lease')
        .set('X-Worker-Id', 'worker_123')
        .query({ limit: 1 });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should not lease scheduled jobs (nextRunAt in future)', async () => {
      // Arrange: Create a scheduled job (1 minute in future)
      const futureDate = new Date(Date.now() + 60000);
      await request(app)
        .post('/jobs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'payout.execute',
          payload: { batchId: 'batch_123', escrowId: 'escrow_456' },
          scheduleAt: futureDate.toISOString(),
        });

      // Act: Try to lease
      const response = await request(app)
        .get('/jobs/lease')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Worker-Id', 'worker_123')
        .query({ limit: 5 });

      // Assert: Should not lease the scheduled job
      expect(response.status).toBe(200);
      expect(response.body.jobs.length).toBe(0);
    });

    it('should reclaim expired leases', async () => {
      // Arrange: Create a job with an expired lease
      const expiredDate = new Date(Date.now() - 1000); // 1 second ago
      const expiredJob = new JobModel({
        type: 'thumbnail.create',
        payload: { assetId: 'asset_123', versionNumber: 1 },
        status: 'leased',
        workerId: 'old_worker',
        leaseExpiresAt: expiredDate,
        nextRunAt: new Date(),
        attempt: 1,
      });
      await expiredJob.save();

      // Act: Try to lease
      const response = await request(app)
        .get('/jobs/lease')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Worker-Id', 'new_worker')
        .query({ limit: 1 });

      // Assert: Should reclaim the expired lease
      expect(response.status).toBe(200);
      expect(response.body.jobs.length).toBe(1);
      expect(response.body.jobs[0].jobId).toBe(expiredJob.jobId);

      // Verify job was updated
      const job = await JobModel.findOne({ jobId: expiredJob.jobId });
      expect(job).toBeDefined();
      expect(job!.status).toBe('leased');
      expect(job!.workerId).toBe('new_worker');
      expect(job!.attempt).toBe(2); // Incremented on reclaim
    });
  });
});

