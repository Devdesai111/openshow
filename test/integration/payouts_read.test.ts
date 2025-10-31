import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { PaymentTransactionModel } from '../../src/models/paymentTransaction.model';
import { EscrowModel } from '../../src/models/escrow.model';
import { PayoutBatchModel } from '../../src/models/payout.model';

describe('Creator Earnings & Payouts Dashboard Integration Tests', () => {
  let adminToken: string;
  let creator1Token: string;
  let creator1Id: string;
  let creator2Id: string;
  let ownerToken: string;
  let projectId: string;
  let milestoneId: string;
  let creator1PayoutItemId: string;
  let creator2PayoutItemId: string;

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
    await ProjectModel.deleteMany({});
    await PaymentTransactionModel.deleteMany({});
    await EscrowModel.deleteMany({});
    await PayoutBatchModel.deleteMany({});

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

    // Create creator1 user
    const creator1Signup = await request(app).post('/auth/signup').send({
      email: 'creator1@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Creator 1',
    });
    creator1Token = creator1Signup.body.accessToken;
    creator1Id = creator1Signup.body.user.id;

    // Create creator2 user
    const creator2Signup = await request(app).post('/auth/signup').send({
      email: 'creator2@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Creator 2',
    });
    creator2Id = creator2Signup.body.user.id;

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerToken = ownerSignup.body.accessToken;

    // Create project with revenue splits
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Test Project',
        category: 'Film Production',
        visibility: 'private',
        roles: [{ title: 'Director', slots: 1 }],
        revenueModel: {
          splits: [
            { percentage: 50, userId: creator1Id },
            { percentage: 50, userId: creator2Id },
          ],
        },
      });
    projectId = projectResponse.body.projectId;

    // Add milestone
    const milestoneResponse = await request(app)
      .post(`/projects/${projectId}/milestones`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Milestone 1',
        description: 'First milestone',
        amount: 10000,
        currency: 'USD',
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    milestoneId = milestoneResponse.body.milestoneId;

    // Create escrow
    const escrow = new EscrowModel({
      projectId: new mongoose.Types.ObjectId(projectId),
      milestoneId: new mongoose.Types.ObjectId(milestoneId),
      payerId: new mongoose.Types.ObjectId(creator1Id),
      amount: 10000,
      currency: 'USD',
      provider: 'stripe',
      providerEscrowId: 'pi_test123',
      status: 'locked',
      transactions: [],
    });
    const savedEscrow = await escrow.save();

    // Schedule payouts (creating payout batch)
    const scheduleResponse = await request(app)
      .post('/revenue/schedule-payouts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        escrowId: savedEscrow._id.toString(),
        projectId,
        milestoneId,
        amount: 10000,
        currency: 'USD',
      });

    expect(scheduleResponse.status).toBe(201);

    // Get payout batch and extract item IDs
    const batch = await PayoutBatchModel.findOne({ escrowId: savedEscrow._id }).lean();
    expect(batch).toBeDefined();
    expect(batch?.items).toBeDefined();
    expect(batch?.items.length).toBeGreaterThanOrEqual(2);

    // Find creator1 and creator2 payout items
    const creator1Item = batch?.items.find(item => item.userId.toString() === creator1Id);
    const creator2Item = batch?.items.find(item => item.userId.toString() === creator2Id);

    expect(creator1Item).toBeDefined();
    expect(creator2Item).toBeDefined();

    creator1PayoutItemId = creator1Item?._id!.toString() || '';
    creator2PayoutItemId = creator2Item?._id!.toString() || '';
  });

  describe('GET /revenue/earnings', () => {
    it('T38.1 - should list only requester payouts for non-admin (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/revenue/earnings')
        .set('Authorization', `Bearer ${creator1Token}`)
        .query({});

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('meta');
      expect(response.body).toHaveProperty('data');
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta).toHaveProperty('page', 1);
      expect(response.body.meta).toHaveProperty('per_page', 20);
      expect(response.body.data).toBeInstanceOf(Array);

      // Verify all payouts belong to creator1
      response.body.data.forEach((payout: any) => {
        expect(payout).toHaveProperty('payoutItemId');
        expect(payout).toHaveProperty('projectId');
        expect(payout).toHaveProperty('netAmount');
        expect(payout).toHaveProperty('status');
        expect(payout).toHaveProperty('fees');
        expect(payout).toHaveProperty('createdAt');
      });

      // Verify creator1's payout is included
      const creator1Payout = response.body.data.find(
        (p: any) => p.payoutItemId === creator1PayoutItemId
      );
      expect(creator1Payout).toBeDefined();

      // Verify creator2's payout is NOT included
      const creator2Payout = response.body.data.find(
        (p: any) => p.payoutItemId === creator2PayoutItemId
      );
      expect(creator2Payout).toBeUndefined();
    });

    it('T38.2 - should filter payouts by status', async () => {
      // Act
      const response = await request(app)
        .get('/revenue/earnings')
        .set('Authorization', `Bearer ${creator1Token}`)
        .query({ status: 'scheduled' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);

      // Verify all payouts have the filtered status
      response.body.data.forEach((payout: any) => {
        expect(payout.status).toBe('scheduled');
      });
    });

    it('should list all payouts for admin (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/revenue/earnings')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({});

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('meta');
      expect(response.body).toHaveProperty('data');
      expect(response.body.meta.total).toBeGreaterThanOrEqual(2); // At least creator1 and creator2 payouts

      // Verify both payouts are included (admin sees all)
      const creator1Payout = response.body.data.find(
        (p: any) => p.payoutItemId === creator1PayoutItemId
      );
      expect(creator1Payout).toBeDefined();

      const creator2Payout = response.body.data.find(
        (p: any) => p.payoutItemId === creator2PayoutItemId
      );
      expect(creator2Payout).toBeDefined();
    });

    it('should support pagination', async () => {
      // Act - First page
      const response = await request(app)
        .get('/revenue/earnings')
        .set('Authorization', `Bearer ${creator1Token}`)
        .query({ page: 1, per_page: 1 });

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeLessThanOrEqual(1);
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.per_page).toBe(1);
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .get('/revenue/earnings')
        .query({});

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should fail with invalid status filter (422)', async () => {
      // Act
      const response = await request(app)
        .get('/revenue/earnings')
        .set('Authorization', `Bearer ${creator1Token}`)
        .query({ status: 'invalid_status' });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });

  describe('GET /revenue/payouts/:payoutItemId', () => {
    it('T38.3 - should return payout details for requester (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get(`/revenue/payouts/${creator1PayoutItemId}`)
        .set('Authorization', `Bearer ${creator1Token}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('payoutItemId', creator1PayoutItemId);
      expect(response.body).toHaveProperty('projectId');
      expect(response.body).toHaveProperty('escrowId');
      expect(response.body).toHaveProperty('userId', creator1Id);
      expect(response.body).toHaveProperty('amount');
      expect(response.body).toHaveProperty('fees');
      expect(response.body).toHaveProperty('netAmount');
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('attempts');
    });

    it('T38.4 - should return 404 when non-recipient views payout (Security by obscurity)', async () => {
      // Act - creator1 tries to view creator2's payout
      const response = await request(app)
        .get(`/revenue/payouts/${creator2PayoutItemId}`)
        .set('Authorization', `Bearer ${creator1Token}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
      expect(response.body.error.message).toContain('Payout');
    });

    it('should allow admin to view any payout', async () => {
      // Act
      const response = await request(app)
        .get(`/revenue/payouts/${creator1PayoutItemId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('payoutItemId', creator1PayoutItemId);
    });

    it('should return 404 when payout not found', async () => {
      // Act
      const fakeId = new mongoose.Types.ObjectId().toString();
      const response = await request(app)
        .get(`/revenue/payouts/${fakeId}`)
        .set('Authorization', `Bearer ${creator1Token}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .get(`/revenue/payouts/${creator1PayoutItemId}`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should fail with invalid payout item ID format (422)', async () => {
      // Act
      const response = await request(app)
        .get('/revenue/payouts/invalid_id_format')
        .set('Authorization', `Bearer ${creator1Token}`);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return full payout details for authorized user', async () => {
      // Act
      const response = await request(app)
        .get(`/revenue/payouts/${creator1PayoutItemId}`)
        .set('Authorization', `Bearer ${creator1Token}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('payoutItemId');
      expect(response.body).toHaveProperty('projectId');
      expect(response.body).toHaveProperty('escrowId');
      expect(response.body).toHaveProperty('userId');
      expect(response.body).toHaveProperty('amount');
      expect(response.body).toHaveProperty('fees');
      expect(response.body).toHaveProperty('taxWithheld');
      expect(response.body).toHaveProperty('netAmount');
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('attempts');
    });
  });
});

