import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { PaymentTransactionModel } from '../../src/models/paymentTransaction.model';
import { EscrowModel } from '../../src/models/escrow.model';

describe('Escrow Lock & Webhook Integration Tests', () => {
  let adminToken: string;
  let payerToken: string;
  let payerId: string;
  let ownerToken: string;
  let projectId: string;
  let milestoneId: string;
  let intentId: string;
  let providerPaymentIntentId: string;

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

    intentId = intentResponse.body.intentId;
    providerPaymentIntentId = intentResponse.body.providerPaymentIntentId;

    // Update transaction to succeeded status (simulating webhook confirmation)
    await PaymentTransactionModel.updateOne({ intentId }, { status: 'succeeded' });
  });

  describe('POST /payments/escrow/lock', () => {
    it('T35.3 - should successfully lock funds into escrow (201 Created)', async () => {
      // Act
      const response = await request(app)
        .post('/payments/escrow/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          intentId,
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
          provider: 'stripe',
          providerPaymentIntentId,
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('escrowId');
      expect(response.body).toHaveProperty('status', 'locked');
      expect(response.body.message).toContain('Funds locked successfully');

      // Verify escrow record
      const escrow = await EscrowModel.findOne({ escrowId: response.body.escrowId });
      expect(escrow).toBeDefined();
      expect(escrow?.status).toBe('locked');
      expect(escrow?.amount).toBe(10000);
      expect(escrow?.currency).toBe('USD');
      expect(escrow?.projectId.toString()).toBe(projectId);
      expect(escrow?.milestoneId.toString()).toBe(milestoneId);
      expect(escrow?.payerId.toString()).toBe(payerId);

      // Verify milestone updated (T35.5)
      const project = await ProjectModel.findById(projectId);
      const milestone = project?.milestones.find(m => m._id?.toString() === milestoneId);
      expect(milestone).toBeDefined();
      expect(milestone?.escrowId?.toString()).toBe(escrow?._id?.toString());
      expect(milestone?.status).toBe('funded');
    });

    it('T35.4 - should fail when escrow already locked (409 Conflict)', async () => {
      // Arrange - Lock escrow first
      await request(app)
        .post('/payments/escrow/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          intentId,
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
          provider: 'stripe',
          providerPaymentIntentId,
        });

      // Act - Try to lock again
      const response = await request(app)
        .post('/payments/escrow/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          intentId,
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
          provider: 'stripe',
          providerPaymentIntentId,
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already active');

      // Verify only one escrow exists
      const escrows = await EscrowModel.find({ milestoneId });
      expect(escrows).toHaveLength(1);
    });

    it('should fail when transaction status is not succeeded (409)', async () => {
      // Arrange - Create new intent and transaction with pending status
      const newIntentResponse = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId: new mongoose.Types.ObjectId().toString(),
          amount: 5000,
          currency: 'USD',
        });

      // Act
      const response = await request(app)
        .post('/payments/escrow/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          intentId: newIntentResponse.body.intentId,
          projectId,
          milestoneId: new mongoose.Types.ObjectId().toString(),
          amount: 5000,
          currency: 'USD',
          provider: 'stripe',
          providerPaymentIntentId: newIntentResponse.body.providerPaymentIntentId,
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('must be marked as succeeded');
    });

    it('should require FINANCE_MANAGE permission', async () => {
      // Act
      const response = await request(app)
        .post('/payments/escrow/lock')
        .set('Authorization', `Bearer ${payerToken}`) // Payer (not admin)
        .send({
          intentId,
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
          provider: 'stripe',
          providerPaymentIntentId,
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');

      // Verify no escrow was created
      const escrows = await EscrowModel.find({ milestoneId });
      expect(escrows).toHaveLength(0);
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post('/payments/escrow/lock')
        .send({
          intentId,
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
          provider: 'stripe',
          providerPaymentIntentId,
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('POST /webhooks/payments', () => {
    beforeEach(async () => {
      // Set webhook secret for testing
      process.env.STRIPE_WEBHOOK_SECRET = 'wh_secret';
    });

    it('T35.1 - should fail when webhook signature is invalid (401)', async () => {
      // Arrange
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: providerPaymentIntentId,
            metadata: {
              internalIntentId: intentId,
            },
          },
        },
      };

      // Act - Invalid signature
      const response = await request(app)
        .post('/webhooks/payments')
        .set('stripe-signature', 'invalid_signature')
        .send(payload);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'unauthorized');
      expect(response.body.error.message).toContain('signature validation failed');
    });

    it('T35.2 - should successfully process payment succeeded webhook (200 OK)', async () => {
      // Arrange
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: providerPaymentIntentId,
            metadata: {
              internalIntentId: intentId,
            },
          },
        },
      };

      // Act - Valid signature
      const response = await request(app)
        .post('/webhooks/payments')
        .set('stripe-signature', 'wh_secret')
        .set('x-psp-provider', 'stripe')
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('OK');

      // Verify transaction updated
      const transaction = await PaymentTransactionModel.findOne({ intentId });
      expect(transaction?.status).toBe('succeeded');
      expect(transaction?.providerPaymentId).toBe(providerPaymentIntentId);

      // Verify escrow created
      const escrow = await EscrowModel.findOne({ milestoneId });
      expect(escrow).toBeDefined();
      expect(escrow?.status).toBe('locked');

      // Verify milestone updated
      const project = await ProjectModel.findById(projectId);
      const milestone = project?.milestones.find(m => m._id?.toString() === milestoneId);
      expect(milestone?.escrowId?.toString()).toBe(escrow?._id?.toString());
      expect(milestone?.status).toBe('funded');
    });

    it('should handle Razorpay webhook (order.paid)', async () => {
      // Arrange - Create Razorpay intent
      process.env.DEFAULT_PSP = 'razorpay';
      const razorpayIntentResponse = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId: new mongoose.Types.ObjectId().toString(),
          amount: 5000,
          currency: 'INR',
        });

      const razorpayIntentId = razorpayIntentResponse.body.intentId;
      const razorpayOrderId = razorpayIntentResponse.body.providerPaymentIntentId;

      // Update transaction to succeeded
      await PaymentTransactionModel.updateOne({ intentId: razorpayIntentId }, { status: 'succeeded' });

      const payload = {
        type: 'order.paid',
        data: {
          object: {
            id: razorpayOrderId,
            metadata: {
              internalIntentId: razorpayIntentId,
            },
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/webhooks/payments')
        .set('x-razorpay-signature', 'wh_secret')
        .set('x-psp-provider', 'razorpay')
        .send(payload);

      // Assert
      expect(response.status).toBe(200);

      // Verify transaction updated
      const transaction = await PaymentTransactionModel.findOne({ intentId: razorpayIntentId });
      expect(transaction?.status).toBe('succeeded');
    });

    it('should handle payment failed webhook', async () => {
      // Arrange
      const payload = {
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: providerPaymentIntentId,
            metadata: {
              internalIntentId: intentId,
            },
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/webhooks/payments')
        .set('stripe-signature', 'wh_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(200);

      // Verify transaction updated to failed
      const transaction = await PaymentTransactionModel.findOne({ intentId });
      expect(transaction?.status).toBe('failed');
    });

    it('should handle webhook with missing correlation ID (400)', async () => {
      // Arrange
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: providerPaymentIntentId,
            // Missing metadata.internalIntentId
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/webhooks/payments')
        .set('stripe-signature', 'wh_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(400);
      expect(response.body.error).toHaveProperty('code', 'webhook_fail');
    });

    it('should handle webhook with transaction not found (400)', async () => {
      // Arrange
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: providerPaymentIntentId,
            metadata: {
              internalIntentId: 'nonexistent_intent_id',
            },
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/webhooks/payments')
        .set('stripe-signature', 'wh_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(400);
      expect(response.body.error).toHaveProperty('code', 'webhook_fail');
    });

    it('should be idempotent (handle duplicate webhook)', async () => {
      // Arrange
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: providerPaymentIntentId,
            metadata: {
              internalIntentId: intentId,
            },
          },
        },
      };

      // Act - First webhook
      const response1 = await request(app)
        .post('/webhooks/payments')
        .set('stripe-signature', 'wh_secret')
        .send(payload);

      expect(response1.status).toBe(200);

      // Act - Duplicate webhook (transaction already succeeded)
      const response2 = await request(app)
        .post('/webhooks/payments')
        .set('stripe-signature', 'wh_secret')
        .send(payload);

      // Assert
      expect(response2.status).toBe(200); // Should handle gracefully

      // Verify only one escrow exists (idempotency)
      const escrows = await EscrowModel.find({ milestoneId });
      expect(escrows).toHaveLength(1);
    });

    it('should not require authentication (public endpoint)', async () => {
      // Arrange
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: providerPaymentIntentId,
            metadata: {
              internalIntentId: intentId,
            },
          },
        },
      };

      // Act - No Authorization header
      const response = await request(app)
        .post('/webhooks/payments')
        .set('stripe-signature', 'wh_secret')
        .send(payload);

      // Assert - Should work (public endpoint)
      expect(response.status).toBe(200);
    });
  });
});

