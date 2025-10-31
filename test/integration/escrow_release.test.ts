import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { PaymentTransactionModel } from '../../src/models/paymentTransaction.model';
import { EscrowModel } from '../../src/models/escrow.model';

describe('Escrow Release & Refund Integration Tests', () => {
  let adminToken: string;
  let payerToken: string;
  let payerId: string;
  let ownerToken: string;
  let projectId: string;
  let milestoneId: string;
  let escrowId: string;

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

    // Create payer user
    const payerSignup = await request(app).post('/auth/signup').send({
      email: 'payer@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Payer User',
    });
    payerToken = payerSignup.body.accessToken;
    payerId = payerSignup.body.user.id;

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

    // Create payment intent
    const intentResponse = await request(app)
      .post('/payments/intents')
      .set('Authorization', `Bearer ${payerToken}`)
      .send({
        projectId,
        milestoneId,
        amount: 10000,
        currency: 'USD',
      });

    const intentId = intentResponse.body.intentId;

    // Update transaction to succeeded status (simulating webhook confirmation)
    await PaymentTransactionModel.updateOne({ intentId }, { status: 'succeeded' });

    // Create escrow directly (simulating locked escrow)
    const escrow = new EscrowModel({
      projectId: new mongoose.Types.ObjectId(projectId),
      milestoneId: new mongoose.Types.ObjectId(milestoneId),
      payerId: new mongoose.Types.ObjectId(payerId),
      amount: 10000,
      currency: 'USD',
      provider: 'stripe',
      providerEscrowId: intentResponse.body.providerPaymentIntentId,
      status: 'locked',
      transactions: [],
    });
    const savedEscrow = await escrow.save();
    escrowId = savedEscrow.escrowId;

    // Update milestone with escrow ID
    await ProjectModel.updateOne(
      { _id: projectId, 'milestones._id': milestoneId },
      {
        $set: {
          'milestones.$.escrowId': savedEscrow._id,
          'milestones.$.status': 'funded',
        },
      }
    );
  });

  describe('POST /payments/escrow/:escrowId/release', () => {
    it('T36.1 - should successfully release escrow funds (200 OK)', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/release`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('escrowId');
      expect(response.body).toHaveProperty('status', 'release_initiated');
      expect(response.body).toHaveProperty('jobId');
      expect(response.body.message).toContain('Funds release confirmed');

      // Verify escrow status updated
      const escrow = await EscrowModel.findOne({ escrowId });
      expect(escrow?.status).toBe('released');
      expect(escrow?.releasedAt).toBeDefined();
    });

    it('T36.2 - should fail when escrow already released (409 Conflict)', async () => {
      // Arrange - Release escrow first
      await request(app)
        .post(`/payments/escrow/${escrowId}/release`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});

      // Act - Try to release again
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/release`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already released');
    });

    it('T36.3 - should fail when requester is not owner (403 Forbidden)', async () => {
      // Act - Non-owner (payer) tries to release
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/release`)
        .set('Authorization', `Bearer ${payerToken}`)
        .send({});

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('Only the project owner or admin');
    });

    it('should allow admin to release escrow', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/release`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'release_initiated');
    });

    it('should accept optional releaseAmount', async () => {
      // Arrange - Create new escrow
      const newEscrow = new EscrowModel({
        projectId: new mongoose.Types.ObjectId(projectId),
        milestoneId: new mongoose.Types.ObjectId(),
        payerId: new mongoose.Types.ObjectId(payerId),
        amount: 20000,
        currency: 'USD',
        provider: 'stripe',
        providerEscrowId: 'pi_test123',
        status: 'locked',
        transactions: [],
      });
      const savedNewEscrow = await newEscrow.save();

      // Act - Release partial amount
      const response = await request(app)
        .post(`/payments/escrow/${savedNewEscrow.escrowId}/release`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ releaseAmount: 10000 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'release_initiated');
    });

    it('should fail when releaseAmount exceeds escrow amount (422)', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/release`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ releaseAmount: 20000 }); // Exceeds escrow amount of 10000

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('exceeds the total escrow amount');
    });

    it('should fail when escrow not found (404)', async () => {
      // Act
      const response = await request(app)
        .post('/payments/escrow/nonexistent_escrow/release')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/release`)
        .send({});

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /payments/escrow/:escrowId/refund', () => {
    it('T36.4 - should successfully refund escrow funds (200 OK)', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          amount: 10000,
          reason: 'Customer requested refund due to project cancellation',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('escrowId');
      expect(response.body).toHaveProperty('status', 'refund_initiated');
      expect(response.body).toHaveProperty('providerRefundId');
      expect(response.body.message).toContain('Refund process initiated');

      // Verify escrow status updated
      const escrow = await EscrowModel.findOne({ escrowId });
      expect(escrow?.status).toBe('refunded');
      expect(escrow?.refundedAt).toBeDefined();

      // Verify refund transaction created
      const refundTransactions = await PaymentTransactionModel.find({
        type: 'refund',
        projectId,
      });
      expect(refundTransactions.length).toBeGreaterThan(0);
      expect(refundTransactions[0]?.amount).toBe(10000);
    });

    it('T36.5 - should fail when refund amount exceeds escrow total (422)', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          amount: 20000, // Exceeds escrow amount of 10000
          reason: 'Refund request',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('exceeds the total escrow amount');
    });

    it('should fail when escrow already refunded (409)', async () => {
      // Arrange - Refund escrow first
      await request(app)
        .post(`/payments/escrow/${escrowId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          amount: 10000,
          reason: 'Customer requested refund due to project cancellation',
        });

      // Act - Try to refund again
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          amount: 10000,
          reason: 'Second refund attempt',
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already released or refunded');
    });

    it('should fail when reason is too short (422)', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          amount: 10000,
          reason: 'Short', // Less than 10 characters
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should allow owner to refund escrow', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/refund`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: 10000,
          reason: 'Customer requested refund due to project cancellation',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'refund_initiated');
    });

    it('should fail when requester is not owner or admin (403)', async () => {
      // Act - Payer (not owner) tries to refund
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/refund`)
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          amount: 10000,
          reason: 'Customer requested refund due to project cancellation',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('Only the project owner or admin');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/refund`)
        .send({
          amount: 10000,
          reason: 'Customer requested refund due to project cancellation',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('T36.2 - should verify release calls RevenueService.schedulePayouts', async () => {
      // Act
      const response = await request(app)
        .post(`/payments/escrow/${escrowId}/release`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('jobId');
      // The jobId comes from RevenueService.schedulePayouts which creates a batchId
      expect(response.body.jobId).toMatch(/^batch_/);
    });
  });
});

