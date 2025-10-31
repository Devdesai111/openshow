import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { PaymentTransactionModel } from '../../src/models/paymentTransaction.model';

describe('Payment Intent Flow Integration Tests', () => {
  let payerToken: string;
  let payerId: string;
  let ownerToken: string;
  let projectId: string;
  let milestoneId: string;
  const originalDefaultPSP = process.env.DEFAULT_PSP;

  beforeAll(async () => {
    const testDbUri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/openshow-test';
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    await mongoose.connect(testDbUri);
  });

  afterAll(async () => {
    // Restore original environment variable
    if (originalDefaultPSP !== undefined) {
      process.env.DEFAULT_PSP = originalDefaultPSP;
    } else {
      delete process.env.DEFAULT_PSP;
    }
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await PaymentTransactionModel.deleteMany({});

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

    // Create project first
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

    // Add milestone separately using the addMilestone endpoint
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
  });

  describe('POST /payments/intents', () => {
    it('T34.1 - should create Stripe payment intent (201 Created) with clientSecret', async () => {
      // Arrange
      process.env.DEFAULT_PSP = 'stripe';

      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('intentId');
      expect(response.body).toHaveProperty('provider', 'stripe');
      expect(response.body).toHaveProperty('providerPaymentIntentId');
      expect(response.body.providerPaymentIntentId).toMatch(/^pi_/);
      expect(response.body).toHaveProperty('clientSecret');
      expect(response.body.clientSecret).toBeDefined();
      expect(response.body).toHaveProperty('status');
      expect(response.body.checkoutUrl).toBeUndefined(); // Stripe uses clientSecret, not checkoutUrl

      // Verify transaction record
      const transaction = await PaymentTransactionModel.findOne({ intentId: response.body.intentId });
      expect(transaction).toBeDefined();
      expect(transaction?.status).toBe('created');
      expect(transaction?.type).toBe('escrow_lock');
      expect(transaction?.provider).toBe('stripe');
      expect(transaction?.providerPaymentIntentId).toBe(response.body.providerPaymentIntentId);
    });

    it('T34.2 - should create Razorpay payment intent (201 Created) with checkoutUrl', async () => {
      // Arrange
      process.env.DEFAULT_PSP = 'razorpay';

      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'INR',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('intentId');
      expect(response.body).toHaveProperty('provider', 'razorpay');
      expect(response.body).toHaveProperty('providerPaymentIntentId');
      expect(response.body.providerPaymentIntentId).toMatch(/^order_/);
      expect(response.body).toHaveProperty('checkoutUrl');
      expect(response.body.checkoutUrl).toContain('checkout.razorpay.com');
      expect(response.body).toHaveProperty('status');
      expect(response.body.clientSecret).toBeUndefined(); // Razorpay uses checkoutUrl, not clientSecret

      // Verify transaction record
      const transaction = await PaymentTransactionModel.findOne({ intentId: response.body.intentId });
      expect(transaction).toBeDefined();
      expect(transaction?.status).toBe('created');
      expect(transaction?.type).toBe('escrow_lock');
      expect(transaction?.provider).toBe('razorpay');
      expect(transaction?.providerPaymentIntentId).toBe(response.body.providerPaymentIntentId);
    });

    it('T34.3 - should fail when amount is less than minimum (422)', async () => {
      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId,
          amount: 1, // Less than minimum 100
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('validation failed');

      // Verify no transaction was created
      const transactions = await PaymentTransactionModel.find({ payerId });
      expect(transactions).toHaveLength(0);
    });

    it('T34.4 - should create transaction record with correct status and type', async () => {
      // Arrange
      process.env.DEFAULT_PSP = 'stripe';

      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
        });

      expect(response.status).toBe(201);

      // Assert - Verify transaction record
      const transaction = await PaymentTransactionModel.findOne({ intentId: response.body.intentId });
      expect(transaction).toBeDefined();
      expect(transaction?.status).toBe('created');
      expect(transaction?.type).toBe('escrow_lock');
      expect(transaction?.amount).toBe(10000);
      expect(transaction?.currency).toBe('USD');
      expect(transaction?.payerId.toString()).toBe(payerId);
      expect(transaction?.projectId?.toString()).toBe(projectId);
      expect(transaction?.milestoneId?.toString()).toBe(milestoneId);
      expect(transaction?.provider).toBe('stripe');
      expect(transaction?.providerPaymentIntentId).toBe(response.body.providerPaymentIntentId);
    });

    it('should fail when projectId is invalid (422)', async () => {
      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId: 'invalid-id',
          milestoneId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when milestoneId is invalid (422)', async () => {
      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId: 'invalid-id',
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when currency is invalid format (422)', async () => {
      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'US', // Invalid (must be 3 letters)
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when returnUrl is invalid format (422)', async () => {
      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
          returnUrl: 'not-a-valid-url',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post('/payments/intents')
        .send({
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should accept valid returnUrl', async () => {
      // Arrange
      process.env.DEFAULT_PSP = 'stripe';

      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
          returnUrl: 'https://example.com/return',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('intentId');
    });

    it('should use default Stripe adapter when DEFAULT_PSP is not set', async () => {
      // Arrange
      delete process.env.DEFAULT_PSP;

      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('provider', 'stripe');
      expect(response.body).toHaveProperty('clientSecret');
    });

    it('should include metadata in transaction record', async () => {
      // Arrange
      process.env.DEFAULT_PSP = 'stripe';

      // Act
      const response = await request(app)
        .post('/payments/intents')
        .set('Authorization', `Bearer ${payerToken}`)
        .send({
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
        });

      expect(response.status).toBe(201);

      // Assert
      const transaction = await PaymentTransactionModel.findOne({ intentId: response.body.intentId });
      expect(transaction).toBeDefined();
      expect(transaction?.metadata).toBeDefined();
      expect(transaction?.metadata?.projectId).toBe(projectId);
      expect(transaction?.metadata?.milestoneId).toBe(milestoneId);
      expect(transaction?.metadata?.payerId).toBe(payerId);
      expect(transaction?.metadata?.internalIntentId).toBe(response.body.intentId);
    });
  });
});

