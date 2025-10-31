import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { PaymentTransactionModel } from '../../src/models/paymentTransaction.model';
import { EscrowModel } from '../../src/models/escrow.model';
import { PayoutBatchModel } from '../../src/models/payout.model';

describe('Admin Financial Oversight Integration Tests', () => {
  let adminToken: string;
  let creatorToken: string;
  let ownerToken: string;
  let projectId: string;
  let milestoneId: string;
  let transactionId1: string;
  let transactionId2: string;
  let batchId: string;

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

    // Create creator user
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Creator User',
    });
    creatorToken = creatorSignup.body.accessToken;

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerToken = ownerSignup.body.accessToken;

    // Create project
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Test Project',
        category: 'Film Production',
        visibility: 'private',
        roles: [{ title: 'Director', slots: 1 }],
        revenueModel: {
          splits: [{ percentage: 100 }],
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

    // Create payment intents (transactions)
    const intent1Response = await request(app)
      .post('/payments/intents')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        projectId,
        milestoneId,
        amount: 10000,
        currency: 'USD',
      });
    transactionId1 = intent1Response.body.intentId;

    const intent2Response = await request(app)
      .post('/payments/intents')
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({
        projectId,
        milestoneId: new mongoose.Types.ObjectId().toString(),
        amount: 5000,
        currency: 'USD',
      });
    transactionId2 = intent2Response.body.intentId;

    // Create escrow
    const escrow = new EscrowModel({
      projectId: new mongoose.Types.ObjectId(projectId),
      milestoneId: new mongoose.Types.ObjectId(milestoneId),
      payerId: new mongoose.Types.ObjectId(creatorSignup.body.user.id),
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
    batchId = scheduleResponse.body.batchId;
  });

  describe('GET /admin/payments/ledger', () => {
    it('T39.1 - should list all transactions for admin (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payments/ledger')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({});

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('meta');
      expect(response.body).toHaveProperty('data');
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta.total).toBeGreaterThanOrEqual(2); // At least 2 transactions
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeGreaterThanOrEqual(2);

      // Verify all transactions are included
      const transaction1 = response.body.data.find((txn: any) => txn.transactionId === transactionId1);
      const transaction2 = response.body.data.find((txn: any) => txn.transactionId === transactionId2);
      expect(transaction1).toBeDefined();
      expect(transaction2).toBeDefined();

      // Verify full transaction details
      response.body.data.forEach((txn: any) => {
        expect(txn).toHaveProperty('transactionId');
        expect(txn).toHaveProperty('payerId');
        expect(txn).toHaveProperty('type');
        expect(txn).toHaveProperty('amount');
        expect(txn).toHaveProperty('currency');
        expect(txn).toHaveProperty('status');
        expect(txn).toHaveProperty('provider');
        expect(txn).toHaveProperty('createdAt');
      });
    });

    it('T39.3 - should filter transactions by date range', async () => {
      // Act - Filter by from date (today)
      const today = new Date().toISOString().split('T')[0];
      const response = await request(app)
        .get('/admin/payments/ledger')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ from: today });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);

      // Verify all transactions are on or after the specified date
      if (today) {
        response.body.data.forEach((txn: any) => {
          const txnDate = new Date(txn.createdAt);
          const fromDate = new Date(today);
          expect(txnDate.getTime()).toBeGreaterThanOrEqual(fromDate.getTime());
        });
      }
    });

    it('should filter transactions by status', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payments/ledger')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ status: 'created' });

      // Assert
      expect(response.status).toBe(200);
      response.body.data.forEach((txn: any) => {
        expect(txn.status).toBe('created');
      });
    });

    it('should filter transactions by provider', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payments/ledger')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ provider: 'stripe' });

      // Assert
      expect(response.status).toBe(200);
      response.body.data.forEach((txn: any) => {
        expect(txn.provider).toBe('stripe');
      });
    });

    it('should support pagination', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payments/ledger')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ page: 1, per_page: 1 });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.per_page).toBe(1);
    });

    it('T39.2 - should return 403 for non-admin user (403 Forbidden)', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payments/ledger')
        .set('Authorization', `Bearer ${creatorToken}`)
        .query({});

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payments/ledger')
        .query({});

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('GET /admin/payouts/batches', () => {
    it('T39.4 - should list all payout batches for admin (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payouts/batches')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({});

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('meta');
      expect(response.body).toHaveProperty('data');
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta.total).toBeGreaterThanOrEqual(1); // At least 1 batch
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBeGreaterThanOrEqual(1);

      // Verify batch is included
      const batch = response.body.data.find((b: any) => b.batchId === batchId);
      expect(batch).toBeDefined();

      // Verify full batch details
      response.body.data.forEach((batchItem: any) => {
        expect(batchItem).toHaveProperty('batchId');
        expect(batchItem).toHaveProperty('escrowId');
        expect(batchItem).toHaveProperty('scheduledBy');
        expect(batchItem).toHaveProperty('currency');
        expect(batchItem).toHaveProperty('totalNet');
        expect(batchItem).toHaveProperty('status');
        expect(batchItem).toHaveProperty('items');
        expect(batchItem).toHaveProperty('createdAt');
        expect(batchItem.items).toBeInstanceOf(Array);

        // Verify items structure
        batchItem.items.forEach((item: any) => {
          expect(item).toHaveProperty('payoutItemId');
          expect(item).toHaveProperty('userId');
          expect(item).toHaveProperty('amount');
          expect(item).toHaveProperty('fees');
          expect(item).toHaveProperty('netAmount');
          expect(item).toHaveProperty('status');
        });
      });
    });

    it('should filter batches by status', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payouts/batches')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ status: 'scheduled' });

      // Assert
      expect(response.status).toBe(200);
      response.body.data.forEach((batch: any) => {
        expect(batch.status).toBe('scheduled');
      });
    });

    it('should filter batches by projectId', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payouts/batches')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ projectId });

      // Assert
      expect(response.status).toBe(200);
      response.body.data.forEach((batch: any) => {
        expect(batch.projectId).toBe(projectId);
      });
    });

    it('should support pagination', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payouts/batches')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ page: 1, per_page: 1 });

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeLessThanOrEqual(1);
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.per_page).toBe(1);
    });

    it('T39.5 - should return 403 for non-admin user (403 Forbidden)', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payouts/batches')
        .set('Authorization', `Bearer ${creatorToken}`)
        .query({});

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .get('/admin/payouts/batches')
        .query({});

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });
});

