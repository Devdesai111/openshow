import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { PaymentTransactionModel } from '../../src/models/paymentTransaction.model';

describe('Transaction Ledger Read Integration Tests', () => {
  let adminToken: string;
  let payer1Token: string;
  let payer2Token: string;
  let ownerToken: string;
  let projectId: string;
  let milestoneId: string;
  let payer1TransactionId: string;
  let payer2TransactionId: string;

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

    // Create payer1 user
    const payer1Signup = await request(app).post('/auth/signup').send({
      email: 'payer1@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Payer 1',
    });
    payer1Token = payer1Signup.body.accessToken;

    // Create payer2 user
    const payer2Signup = await request(app).post('/auth/signup').send({
      email: 'payer2@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Payer 2',
    });
    payer2Token = payer2Signup.body.accessToken;

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

    // Create payment intent for payer1
    const intent1Response = await request(app)
      .post('/payments/intents')
      .set('Authorization', `Bearer ${payer1Token}`)
      .send({
        projectId,
        milestoneId,
        amount: 10000,
        currency: 'USD',
      });
    payer1TransactionId = intent1Response.body.intentId;

    // Create payment intent for payer2
    const intent2Response = await request(app)
      .post('/payments/intents')
      .set('Authorization', `Bearer ${payer2Token}`)
      .send({
        projectId,
        milestoneId: new mongoose.Types.ObjectId().toString(), // Different milestone
        amount: 5000,
        currency: 'USD',
      });
    payer2TransactionId = intent2Response.body.intentId;
  });

  describe('GET /payments/transactions', () => {
    it('T37.1 - should list only requester transactions for non-admin (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/payments/transactions')
        .set('Authorization', `Bearer ${payer1Token}`)
        .query({});

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('meta');
      expect(response.body).toHaveProperty('data');
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta).toHaveProperty('page', 1);
      expect(response.body.meta).toHaveProperty('per_page', 20);
      expect(response.body.data).toBeInstanceOf(Array);

      // Verify all transactions belong to payer1
      response.body.data.forEach((txn: any) => {
        expect(txn).toHaveProperty('transactionId');
        expect(txn).toHaveProperty('type');
        expect(txn).toHaveProperty('amount');
        expect(txn).toHaveProperty('currency');
        expect(txn).toHaveProperty('status');
        expect(txn).toHaveProperty('createdAt');
      });

      // Verify payer1's transaction is included
      const payer1Txn = response.body.data.find((txn: any) => txn.transactionId === payer1TransactionId);
      expect(payer1Txn).toBeDefined();

      // Verify payer2's transaction is NOT included
      const payer2Txn = response.body.data.find((txn: any) => txn.transactionId === payer2TransactionId);
      expect(payer2Txn).toBeUndefined();
    });

    it('T37.2 - should list all transactions for admin (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/payments/transactions')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({});

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('meta');
      expect(response.body).toHaveProperty('data');
      expect(response.body.meta.total).toBeGreaterThanOrEqual(2); // At least payer1 and payer2 transactions

      // Verify both transactions are included
      const payer1Txn = response.body.data.find((txn: any) => txn.transactionId === payer1TransactionId);
      expect(payer1Txn).toBeDefined();

      const payer2Txn = response.body.data.find((txn: any) => txn.transactionId === payer2TransactionId);
      expect(payer2Txn).toBeDefined();
    });

    it('should filter by transaction type', async () => {
      // Act
      const response = await request(app)
        .get('/payments/transactions')
        .set('Authorization', `Bearer ${payer1Token}`)
        .query({ type: 'escrow_lock' });

      // Assert
      expect(response.status).toBe(200);
      response.body.data.forEach((txn: any) => {
        expect(txn.type).toBe('escrow_lock');
      });
    });

    it('should filter by transaction status', async () => {
      // Act
      const response = await request(app)
        .get('/payments/transactions')
        .set('Authorization', `Bearer ${payer1Token}`)
        .query({ status: 'created' });

      // Assert
      expect(response.status).toBe(200);
      response.body.data.forEach((txn: any) => {
        expect(txn.status).toBe('created');
      });
    });

    it('should support pagination', async () => {
      // Act - First page
      const response1 = await request(app)
        .get('/payments/transactions')
        .set('Authorization', `Bearer ${payer1Token}`)
        .query({ page: 1, per_page: 1 });

      expect(response1.status).toBe(200);
      expect(response1.body.data).toHaveLength(1);
      expect(response1.body.meta.page).toBe(1);
      expect(response1.body.meta.per_page).toBe(1);
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .get('/payments/transactions')
        .query({});

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('GET /payments/transactions/:transactionId', () => {
    it('T37.4 - should return transaction details for requester (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get(`/payments/transactions/${payer1TransactionId}`)
        .set('Authorization', `Bearer ${payer1Token}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('transactionId', payer1TransactionId);
      expect(response.body).toHaveProperty('type');
      expect(response.body).toHaveProperty('amount');
      expect(response.body).toHaveProperty('currency');
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('provider');
      expect(response.body).toHaveProperty('projectId');
      expect(response.body).toHaveProperty('createdAt');
    });

    it('T37.3 - should return 404 when non-admin views other payer transaction (Security by obscurity)', async () => {
      // Act - payer1 tries to view payer2's transaction
      const response = await request(app)
        .get(`/payments/transactions/${payer2TransactionId}`)
        .set('Authorization', `Bearer ${payer1Token}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
      expect(response.body.error.message).toContain('Transaction');
    });

    it('should allow admin to view any transaction', async () => {
      // Act
      const response = await request(app)
        .get(`/payments/transactions/${payer1TransactionId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('transactionId', payer1TransactionId);
    });

    it('should return 404 when transaction not found', async () => {
      // Act
      const response = await request(app)
        .get('/payments/transactions/nonexistent_transaction_id')
        .set('Authorization', `Bearer ${payer1Token}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .get(`/payments/transactions/${payer1TransactionId}`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should return full transaction details for authorized user', async () => {
      // Act
      const response = await request(app)
        .get(`/payments/transactions/${payer1TransactionId}`)
        .set('Authorization', `Bearer ${payer1Token}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('transactionId');
      expect(response.body).toHaveProperty('providerPaymentIntentId');
      expect(response.body).toHaveProperty('projectId');
      expect(response.body).toHaveProperty('milestoneId');
      expect(response.body).toHaveProperty('type');
      expect(response.body).toHaveProperty('amount');
      expect(response.body).toHaveProperty('currency');
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('provider');
      expect(response.body).toHaveProperty('createdAt');
    });

    it('should handle invalid transaction ID format', async () => {
      // Act
      const response = await request(app)
        .get('/payments/transactions/invalid_id_format')
        .set('Authorization', `Bearer ${payer1Token}`);

      // Assert - Should still return 404 (transaction not found)
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });
  });
});

