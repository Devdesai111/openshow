import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { PayoutBatchModel } from '../../src/models/payout.model';

describe('Payout Scheduling Integration Tests', () => {
  let adminToken: string;
  let ownerToken: string;
  let ownerId: string;
  let creatorToken: string;
  let creatorId: string;
  let projectId: string;
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
    await PayoutBatchModel.deleteMany({});

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerToken = ownerSignup.body.accessToken;
    ownerId = ownerSignup.body.user.id;

    // Create creator user
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Creator User',
    });
    creatorToken = creatorSignup.body.accessToken;
    creatorId = creatorSignup.body.user.id;

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

    // Create project with revenue model (with real user IDs for payout)
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
            { userId: ownerId, percentage: 60 },
            { userId: creatorId, percentage: 40 },
          ],
        },
      });
    projectId = projectResponse.body.projectId;

    // Generate a mock escrow ID
    escrowId = new mongoose.Types.ObjectId().toString();
  });

  describe('POST /revenue/schedule-payouts', () => {
    it('T32.1 - should successfully schedule payout batch (happy path)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId,
          projectId,
          milestoneId: new mongoose.Types.ObjectId().toString(),
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('batchId');
      expect(response.body).toHaveProperty('status', 'scheduled');
      expect(response.body).toHaveProperty('itemsCount');
      expect(response.body).toHaveProperty('estimatedTotalPayout');
      expect(response.body.itemsCount).toBeGreaterThan(0);
      expect(response.body.message).toContain('scheduled and execution job queued');

      // Verify batch in database
      const savedBatch = await PayoutBatchModel.findOne({ escrowId });
      expect(savedBatch).toBeDefined();
      expect(savedBatch?.batchId).toBe(response.body.batchId);
      expect(savedBatch?.status).toBe('scheduled');
      expect(savedBatch?.items.length).toBe(response.body.itemsCount);

      // Verify payout items match Task 31 calculation
      // Amount: 10000, Platform Fee: 500 (5%), Net: 9500
      // Split: 60/40 = 5700 / 3800
      expect(savedBatch?.totalNet).toBe(9500);
      expect(savedBatch?.items.length).toBe(2);

      // Check items match calculation
      const ownerItem = savedBatch?.items.find(item => item.userId.toString() === ownerId);
      const creatorItem = savedBatch?.items.find(item => item.userId.toString() === creatorId);
      expect(ownerItem).toBeDefined();
      expect(creatorItem).toBeDefined();
      expect(ownerItem?.netAmount).toBe(5700); // 60% of 9500
      expect(creatorItem?.netAmount).toBe(3800); // 40% of 9500
      expect((ownerItem?.netAmount || 0) + (creatorItem?.netAmount || 0)).toBe(9500);
    });

    it('T32.2 - should fail when payout already scheduled for escrow (idempotency - 409)', async () => {
      // Arrange - Schedule first payout
      await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId,
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Act - Try to schedule again with same escrowId
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId, // Same escrowId
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already scheduled');

      // Verify only one batch exists
      const batches = await PayoutBatchModel.find({ escrowId });
      expect(batches).toHaveLength(1);
    });

    it('T32.3 - should fail when non-admin tries to schedule (403)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${ownerToken}`) // Owner (not admin)
        .send({
          escrowId,
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');

      // Verify no batch was created
      const batch = await PayoutBatchModel.findOne({ escrowId });
      expect(batch).toBeNull();
    });

    it('should fail when creator tries to schedule (403)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${creatorToken}`) // Creator (not admin)
        .send({
          escrowId,
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('T32.4 - should fail when project has invalid revenue splits (422)', async () => {
      // Arrange - Create a new project that bypasses validation (we'll test the calculation directly)
      // Since the project model validation prevents saving invalid splits, we'll use bypassValidation
      const invalidProject = new ProjectModel({
        title: 'Invalid Project',
        category: 'Film Production',
        ownerId: new mongoose.Types.ObjectId(ownerId),
        visibility: 'private',
        revenueSplits: [{ _id: new mongoose.Types.ObjectId(), percentage: 90 }], // Only 90%
      });
      // Bypass validation for testing
      await ProjectModel.collection.insertOne(invalidProject.toObject());

      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId: new mongoose.Types.ObjectId().toString(),
          projectId: invalidProject._id.toString(),
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      // The error message might be "Revenue model validation failed during scheduling." or "Revenue splits must sum to 100%."
      expect(
        response.body.error.message.includes('Revenue model validation failed') ||
          response.body.error.message.includes('sum to 100%')
      ).toBe(true);

      // Cleanup
      await ProjectModel.deleteOne({ _id: invalidProject._id });
    });

    it('should fail when project not found (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId,
          projectId: new mongoose.Types.ObjectId().toString(),
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when escrowId is invalid format (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId: 'invalid-id',
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when amount is invalid (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId,
          projectId,
          amount: -1000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate currency is 3-letter ISO code (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId,
          projectId,
          amount: 10000,
          currency: 'US',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .send({
          escrowId,
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should match Task 31 calculation results', async () => {
      // Act - Schedule payout
      const scheduleResponse = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId,
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      expect(scheduleResponse.status).toBe(201);

      // Act - Calculate preview for same amount
      const previewResponse = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      expect(previewResponse.status).toBe(200);

      // Assert - Verify payout items match calculation breakdown
      const batch = await PayoutBatchModel.findOne({ escrowId });
      expect(batch).toBeDefined();

      const previewBreakdown = previewResponse.body.breakdown;
      expect(batch?.items.length).toBe(previewBreakdown.length);

      // Verify net amounts match
      batch?.items.forEach((item) => {
        const matchingBreakdown = previewBreakdown.find((b: any) => b.recipientId === item.userId.toString());
        expect(matchingBreakdown).toBeDefined();
        expect(item.netAmount).toBe(matchingBreakdown.netAmount);
      });

      // Verify total net matches
      const batchTotalNet = batch?.items.reduce((sum, item) => sum + item.netAmount, 0);
      const previewTotalNet = previewResponse.body.totalDistributed;
      expect(batchTotalNet).toBe(previewTotalNet);
    });

    it('should handle project with placeholder splits (filters them out)', async () => {
      // Arrange - Create project with placeholder
      const projectWithPlaceholder = await request(app)
        .post('/projects')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Placeholder Project',
          category: 'Film Production',
          visibility: 'private',
          roles: [{ title: 'Director', slots: 1 }],
          revenueModel: {
            splits: [
              { userId: ownerId, percentage: 60 },
              { placeholder: 'Team Pool', percentage: 40 },
            ],
          },
        });

      const placeholderProjectId = projectWithPlaceholder.body.projectId;
      const placeholderEscrowId = new mongoose.Types.ObjectId().toString();

      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId: placeholderEscrowId,
          projectId: placeholderProjectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(201);
      const batch = await PayoutBatchModel.findOne({ escrowId: placeholderEscrowId });
      expect(batch).toBeDefined();

      // Should only have one item (owner), placeholder is filtered out
      expect(batch?.items.length).toBe(1);
      expect(batch?.items[0]?.userId.toString()).toBe(ownerId);
    });

    it('should fail when all splits are placeholders (no recipients)', async () => {
      // Arrange - Create project with only placeholders
      const projectWithOnlyPlaceholders = await request(app)
        .post('/projects')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Placeholder Only Project',
          category: 'Film Production',
          visibility: 'private',
          roles: [{ title: 'Director', slots: 1 }],
          revenueModel: {
            splits: [
              { placeholder: 'Team Pool', percentage: 60 },
              { placeholder: 'Director Pool', percentage: 40 },
            ],
          },
        });

      const placeholderOnlyProjectId = projectWithOnlyPlaceholders.body.projectId;
      const placeholderOnlyEscrowId = new mongoose.Types.ObjectId().toString();

      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId: placeholderOnlyEscrowId,
          projectId: placeholderOnlyProjectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(
        response.body.error.message.includes('No valid recipients') ||
          response.body.error.message.includes('NoRecipientsForPayout')
      ).toBe(true);
    });
  });
});
