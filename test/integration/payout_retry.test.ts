import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { EscrowModel } from '../../src/models/escrow.model';
import { PayoutBatchModel } from '../../src/models/payout.model';
import { RevenueService } from '../../src/services/revenue.service';

describe('Payout Retry Integration Tests', () => {
  let adminToken: string;
  let creatorToken: string;
  let creatorId: string;
  let ownerToken: string;
  let projectId: string;
  let milestoneId: string;
  let payoutItemId: string;

  const revenueService = new RevenueService();

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
    creatorId = creatorSignup.body.user.id;

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
          splits: [{ percentage: 100, userId: creatorId }],
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
      payerId: new mongoose.Types.ObjectId(creatorId),
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

    // Get payout batch and extract item ID
    const batch = await PayoutBatchModel.findOne({ escrowId: savedEscrow._id }).lean();
    expect(batch).toBeDefined();
    expect(batch?.items).toBeDefined();
    expect(batch?.items.length).toBeGreaterThan(0);

    const item = batch?.items.find(item => item.userId.toString() === creatorId);
    expect(item).toBeDefined();
    payoutItemId = item?._id!.toString() || '';
  });

  describe('POST /revenue/payouts/:payoutItemId/retry', () => {
    it('T40.3 - should successfully retry a failed payout (200 OK)', async () => {
      // Arrange - Set payout item to failed status
      const batch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(batch).toBeDefined();
      const itemIndex = batch!.items.findIndex(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(itemIndex).not.toBe(-1);
      const item = batch!.items[itemIndex];
      expect(item).toBeDefined();
      if (!item) return; // Type guard
      item.status = 'failed';
      item.attempts = 1;
      item.failureReason = 'Test failure';
      await batch!.save();

      // Act
      const response = await request(app)
        .post(`/revenue/payouts/${payoutItemId}/retry`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('payoutItemId', payoutItemId);
      expect(response.body).toHaveProperty('status', 'processing');
      expect(response.body).toHaveProperty('attempts', 2); // Incremented from 1
      expect(response.body).toHaveProperty('message', 'Payout re-queued for immediate execution.');

      // Verify database state
      const updatedBatch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(updatedBatch).toBeDefined();
      const updatedItem = updatedBatch!.items.find(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(updatedItem).toBeDefined();
      expect(updatedItem!.status).toBe('processing');
      expect(updatedItem!.attempts).toBe(2);
      expect(updatedItem!.failureReason).toBeUndefined(); // Cleared for new attempt
    });

    it('T40.4 - should return 409 for already paid payout', async () => {
      // Arrange - Set payout item to paid status
      const batch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(batch).toBeDefined();
      const itemIndex = batch!.items.findIndex(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(itemIndex).not.toBe(-1);
      const item = batch!.items[itemIndex];
      expect(item).toBeDefined();
      if (!item) return; // Type guard
      item.status = 'paid';
      await batch!.save();

      // Act
      const response = await request(app)
        .post(`/revenue/payouts/${payoutItemId}/retry`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already paid or processing');
    });

    it('should return 409 for processing payout', async () => {
      // Arrange - Set payout item to processing status
      const batch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(batch).toBeDefined();
      const itemIndex = batch!.items.findIndex(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(itemIndex).not.toBe(-1);
      const item = batch!.items[itemIndex];
      expect(item).toBeDefined();
      if (!item) return; // Type guard
      item.status = 'processing';
      await batch!.save();

      // Act
      const response = await request(app)
        .post(`/revenue/payouts/${payoutItemId}/retry`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
    });

    it('T40.5 - should return 403 for non-admin user (403 Forbidden)', async () => {
      // Act
      const response = await request(app)
        .post(`/revenue/payouts/${payoutItemId}/retry`)
        .set('Authorization', `Bearer ${creatorToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should return 404 for non-existent payout item', async () => {
      // Act
      const fakeId = new mongoose.Types.ObjectId().toString();
      const response = await request(app)
        .post(`/revenue/payouts/${fakeId}/retry`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).post(`/revenue/payouts/${payoutItemId}/retry`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should fail with invalid payout item ID format (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/payouts/invalid_id_format/retry')
        .set('Authorization', `Bearer ${adminToken}`);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });
  });

  describe('Service: handlePayoutFailure', () => {
    it('T40.2 - should escalate to admin when MAX_ATTEMPTS reached', async () => {
      // Arrange - Set payout item to failed with MAX_ATTEMPTS - 1 attempts
      const batch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(batch).toBeDefined();
      const itemIndex = batch!.items.findIndex(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(itemIndex).not.toBe(-1);
      const item = batch!.items[itemIndex];
      expect(item).toBeDefined();
      if (!item) return; // Type guard
      item.status = 'failed';
      item.attempts = 4; // One less than MAX_ATTEMPTS (5)
      await batch!.save();

      // Act - Handle failure (should escalate)
      await revenueService.handlePayoutFailure(payoutItemId, 'Test failure reason');

      // Assert
      const updatedBatch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(updatedBatch).toBeDefined();
      const updatedItem = updatedBatch!.items.find(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(updatedItem).toBeDefined();
      expect(updatedItem!.status).toBe('failed');
      expect(updatedItem!.attempts).toBe(5);
      expect(updatedItem!.failureReason).toContain('Permanent failure after 5 attempts');
    });

    it('should retry payout when attempts < MAX_ATTEMPTS', async () => {
      // Arrange - Set payout item to failed with 1 attempt
      const batch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(batch).toBeDefined();
      const itemIndex = batch!.items.findIndex(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(itemIndex).not.toBe(-1);
      const item = batch!.items[itemIndex];
      expect(item).toBeDefined();
      if (!item) return; // Type guard
      item.status = 'failed';
      item.attempts = 1;
      await batch!.save();

      // Act - Handle failure (should retry)
      await revenueService.handlePayoutFailure(payoutItemId, 'Test failure reason');

      // Assert
      const updatedBatch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(updatedBatch).toBeDefined();
      const updatedItem = updatedBatch!.items.find(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(updatedItem).toBeDefined();
      expect(updatedItem!.status).toBe('scheduled'); // Should be scheduled for retry
      expect(updatedItem!.attempts).toBe(2); // Incremented
      expect(updatedItem!.failureReason).toBe('Test failure reason');
    });

    it('should not retry if payout is already paid', async () => {
      // Arrange - Set payout item to paid
      const batch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(batch).toBeDefined();
      const itemIndex = batch!.items.findIndex(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(itemIndex).not.toBe(-1);
      const item = batch!.items[itemIndex];
      expect(item).toBeDefined();
      if (!item) return; // Type guard
      item.status = 'paid';
      item.attempts = 1;
      await batch!.save();

      // Act - Handle failure (should do nothing)
      await revenueService.handlePayoutFailure(payoutItemId, 'Test failure reason');

      // Assert - Status should remain paid
      const updatedBatch = await PayoutBatchModel.findOne({ 'items._id': new mongoose.Types.ObjectId(payoutItemId) });
      expect(updatedBatch).toBeDefined();
      const updatedItem = updatedBatch!.items.find(i => i._id?.equals(new mongoose.Types.ObjectId(payoutItemId)));
      expect(updatedItem).toBeDefined();
      expect(updatedItem!.status).toBe('paid'); // Should remain paid
    });
  });
});

