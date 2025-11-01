import request from 'supertest';
import app from '../../src/server';
import { JobModel } from '../../src/models/job.model';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import mongoose from 'mongoose';

describe('Job Monitoring API Integration Tests (Task 59)', () => {
  let adminToken: string;
  let creatorToken: string;
  let userToken: string;
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
    await JobModel.deleteMany({});
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});

    // Create admin user (signup as creator, then update role)
    const adminSignup = await request(app)
      .post('/auth/signup')
      .send({
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

    const adminLogin = await request(app)
      .post('/auth/login')
      .send({
        email: 'admin@test.com',
        password: 'Admin123!',
      });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.data?.token || adminLogin.body.accessToken;
    expect(adminToken).toBeDefined();

    // Create creator user
    const creatorSignup = await request(app)
      .post('/auth/signup')
      .send({
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

    const creatorLogin = await request(app)
      .post('/auth/login')
      .send({
        email: 'creator@test.com',
        password: 'Creator123!',
      });
    expect(creatorLogin.status).toBe(200);
    creatorToken = creatorLogin.body.data?.token || creatorLogin.body.accessToken;
    expect(creatorToken).toBeDefined();

    // Create regular user
    await request(app)
      .post('/auth/signup')
      .send({
        email: 'user@test.com',
        password: 'User123!',
        preferredName: 'User User',
        fullName: 'User User',
        role: 'creator',
      });

    const userLogin = await request(app)
      .post('/auth/login')
      .send({
        email: 'user@test.com',
        password: 'User123!',
      });
    expect(userLogin.status).toBe(200);
    userToken = userLogin.body.data?.token || userLogin.body.accessToken;
    expect(userToken).toBeDefined();
  });

  describe('GET /admin/jobs/queue', () => {
    it('T59.1 - should successfully list jobs for admin (200 OK)', async () => {
      // Arrange: Create test jobs
      await JobModel.create([
        {
          jobId: 'job_1',
          type: 'thumbnail.create',
          payload: { assetId: 'asset_1', versionNumber: 1 },
          status: 'queued',
          priority: 50,
          attempt: 0,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
        {
          jobId: 'job_2',
          type: 'thumbnail.create',
          payload: { assetId: 'asset_2', versionNumber: 1 },
          status: 'succeeded',
          priority: 50,
          attempt: 1,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
        {
          jobId: 'job_3',
          type: 'pdf.generate',
          payload: { agreementId: 'agreement_1', payloadJson: {} },
          status: 'dlq',
          priority: 50,
          attempt: 5,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
      ]);

      // Act
      const response = await request(app)
        .get('/admin/jobs/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(response.body.meta).toHaveProperty('total', 3);
      expect(response.body.meta).toHaveProperty('page', 1);
      expect(response.body.meta).toHaveProperty('per_page', 20);
      expect(response.body.data).toHaveLength(3);
    });

    it('T59.1 - should filter jobs by status', async () => {
      // Arrange: Create jobs with different statuses
      await JobModel.create([
        {
          jobId: 'job_queued_1',
          type: 'thumbnail.create',
          payload: { assetId: 'asset_1', versionNumber: 1 },
          status: 'queued',
          priority: 50,
          attempt: 0,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
        {
          jobId: 'job_succeeded_1',
          type: 'thumbnail.create',
          payload: { assetId: 'asset_2', versionNumber: 1 },
          status: 'succeeded',
          priority: 50,
          attempt: 1,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
      ]);

      // Act: Filter by queued status
      const response = await request(app)
        .get('/admin/jobs/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ status: 'queued', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0]).toHaveProperty('status', 'queued');
    });

    it('T59.1 - should filter jobs by type', async () => {
      // Arrange: Create jobs of different types
      await JobModel.create([
        {
          jobId: 'job_thumb_1',
          type: 'thumbnail.create',
          payload: { assetId: 'asset_1', versionNumber: 1 },
          status: 'queued',
          priority: 50,
          attempt: 0,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
        {
          jobId: 'job_pdf_1',
          type: 'pdf.generate',
          payload: { agreementId: 'agreement_1', payloadJson: {} },
          status: 'queued',
          priority: 50,
          attempt: 0,
          maxAttempts: 5,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
      ]);

      // Act: Filter by type
      const response = await request(app)
        .get('/admin/jobs/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ type: 'thumbnail.create', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0]).toHaveProperty('type', 'thumbnail.create');
    });

    it('T59.3 - should return 403 for unauthorized access', async () => {
      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .get('/admin/jobs/queue')
        .set('Authorization', `Bearer ${creatorToken}`)
        .query({ page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(403);
    });
  });

  describe('GET /admin/jobs/stats', () => {
    it('T59.2 - should successfully retrieve job statistics (200 OK)', async () => {
      // Arrange: Create jobs with different statuses
      await JobModel.create([
        {
          jobId: 'job_queued_1',
          type: 'thumbnail.create',
          payload: { assetId: 'asset_1', versionNumber: 1 },
          status: 'queued',
          priority: 50,
          attempt: 0,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
        {
          jobId: 'job_queued_2',
          type: 'thumbnail.create',
          payload: { assetId: 'asset_2', versionNumber: 1 },
          status: 'queued',
          priority: 50,
          attempt: 0,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
        {
          jobId: 'job_succeeded_1',
          type: 'thumbnail.create',
          payload: { assetId: 'asset_3', versionNumber: 1 },
          status: 'succeeded',
          priority: 50,
          attempt: 1,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
        {
          jobId: 'job_dlq_1',
          type: 'pdf.generate',
          payload: { agreementId: 'agreement_1', payloadJson: {} },
          status: 'dlq',
          priority: 50,
          attempt: 5,
          maxAttempts: 3,
          nextRunAt: new Date(),
          createdBy: new mongoose.Types.ObjectId(adminUserId),
        },
      ]);

      // Act
      const response = await request(app)
        .get('/admin/jobs/stats')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('totalJobs', 4);
      expect(response.body.data).toHaveProperty('statusCounts');
      expect(response.body.data.statusCounts).toHaveProperty('queued', 2);
      expect(response.body.data.statusCounts).toHaveProperty('succeeded', 1);
      expect(response.body.data.statusCounts).toHaveProperty('dlq', 1);
      expect(response.body.data).toHaveProperty('oldestQueuedJobAgeMs');
      expect(typeof response.body.data.oldestQueuedJobAgeMs).toBe('number');
    });

    it('T59.3 - should return 403 for unauthorized access', async () => {
      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .get('/admin/jobs/stats')
        .set('Authorization', `Bearer ${creatorToken}`);

      // Assert
      expect(response.status).toBe(403);
    });
  });

  describe('GET /jobs/:jobId', () => {
    it('T59.1 - should successfully retrieve job status for creator', async () => {
      // Arrange: Create a job owned by creator
      const job = await JobModel.create({
        jobId: 'job_creator_1',
        type: 'thumbnail.create',
        payload: { assetId: 'asset_1', versionNumber: 1 },
        status: 'queued',
        priority: 50,
        attempt: 0,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(creatorUserId),
      });

      // Act
      const response = await request(app)
        .get(`/jobs/${job.jobId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('jobId', 'job_creator_1');
      expect(response.body.data).toHaveProperty('status', 'queued');
      expect(response.body.data).toHaveProperty('type', 'thumbnail.create');
    });

    it('T59.1 - should successfully retrieve job status for admin (even if not creator)', async () => {
      // Arrange: Create a job owned by creator
      const job = await JobModel.create({
        jobId: 'job_creator_2',
        type: 'thumbnail.create',
        payload: { assetId: 'asset_2', versionNumber: 1 },
        status: 'queued',
        priority: 50,
        attempt: 0,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(creatorUserId),
      });

      // Act: Admin accessing job created by creator
      const response = await request(app)
        .get(`/jobs/${job.jobId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('jobId', 'job_creator_2');
    });

    it('T59.4 - should return 403 for non-creator non-admin access', async () => {
      // Arrange: Create a job owned by creator
      const job = await JobModel.create({
        jobId: 'job_creator_3',
        type: 'thumbnail.create',
        payload: { assetId: 'asset_3', versionNumber: 1 },
        status: 'queued',
        priority: 50,
        attempt: 0,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(creatorUserId),
      });

      // Act: Regular user trying to access job created by creator
      const response = await request(app)
        .get(`/jobs/${job.jobId}`)
        .set('Authorization', `Bearer ${userToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('should return 403 for non-existent job', async () => {
      // Act
      const response = await request(app)
        .get('/jobs/nonexistent_job_id')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('should return 401 for unauthenticated access', async () => {
      // Arrange: Create a job
      const job = await JobModel.create({
        jobId: 'job_public_1',
        type: 'thumbnail.create',
        payload: { assetId: 'asset_1', versionNumber: 1 },
        status: 'queued',
        priority: 50,
        attempt: 0,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(adminUserId),
      });

      // Act: No auth header
      const response = await request(app)
        .get(`/jobs/${job.jobId}`);

      // Assert
      expect(response.status).toBe(401);
    });
  });
});

