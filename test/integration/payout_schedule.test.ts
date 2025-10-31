import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { PayoutBatchModel } from '../../src/models/payout.model';

describe('Payout Scheduling Integration Tests', () => {
  let ownerToken: string;
  let ownerId: string;
  let adminToken: string;
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

    // Create project with revenue model
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

    // Create escrow ID
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
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('batchId');
      expect(response.body).toHaveProperty('status', 'scheduled');
      expect(response.body).toHaveProperty('itemsCount', 2); // Owner and creator
      expect(response.body).toHaveProperty('estimatedTotalPayout', 9500); // 10000 - 5% = 9500
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('scheduled and execution job queued');

      // Verify batch record in database
      const savedBatch = await PayoutBatchModel.findOne({ escrowId });
      expect(savedBatch).toBeDefined();
      expect(savedBatch?.status).toBe('scheduled');
      expect(savedBatch?.items).toHaveLength(2);
      expect(savedBatch?.totalNet).toBe(9500);

      // Verify payout items match calculation
      const ownerItem = savedBatch?.items.find(item => item.userId.toString() === ownerId);
      const creatorItem = savedBatch?.items.find(item => item.userId.toString() === creatorId);
      expect(ownerItem).toBeDefined();
      expect(creatorItem).toBeDefined();

      // Verify amounts (60% and 40% of 9500)
      expect(ownerItem?.netAmount).toBe(5700); // 60% of 9500 = 5700
      expect(creatorItem?.netAmount).toBe(3800); // 40% of 9500 = 3800
      expect((ownerItem?.netAmount || 0) + (creatorItem?.netAmount || 0)).toBe(9500); // Conservation check
    });

    it('should successfully schedule with milestone ID', async () => {
      // Act
      const milestoneId = new mongoose.Types.ObjectId().toString();
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId,
          projectId,
          milestoneId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('batchId');

      // Verify milestone ID is stored
      const savedBatch = await PayoutBatchModel.findOne({ escrowId });
      expect(savedBatch?.milestoneId?.toString()).toBe(milestoneId);
    });

    it('T32.2 - should fail when escrow payout is already scheduled (idempotency - 409)', async () => {
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
          escrowId,
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('already scheduled');
    });

    it('T32.3 - should fail when non-admin tries to schedule (403)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${creatorToken}`) // Non-admin user
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
      // Arrange - Create a project with valid splits, then corrupt it in DB
      // (Project creation API rejects invalid splits, so we update after creation)
      const validProjectResponse = await request(app)
        .post('/projects')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Temp Project',
          category: 'Film Production',
          visibility: 'private',
          roles: [{ title: 'Director', slots: 1 }],
          revenueModel: {
            splits: [{ userId: ownerId, percentage: 100 }],
          },
        });
      const tempProjectId = validProjectResponse.body.projectId;

      // Corrupt the revenue splits to make them invalid
      await ProjectModel.updateOne(
        { _id: tempProjectId },
        {
          $set: {
            'revenueSplits.0.percentage': 90, // Change from 100% to 90%
          },
        }
      );

      const invalidEscrowId = new mongoose.Types.ObjectId().toString();

      // Act - Try to schedule with invalid splits
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId: invalidEscrowId,
          projectId: tempProjectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert - Should fail at calculation stage
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('Revenue model validation failed');
    });

    it('should fail when project not found (404)', async () => {
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
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should fail when all splits are placeholders (422)', async () => {
      // Arrange - Create project with only placeholders
      const placeholderProjectResponse = await request(app)
        .post('/projects')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Placeholder Project',
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

      const placeholderEscrowId = new mongoose.Types.ObjectId().toString();

      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId: placeholderEscrowId,
          projectId: placeholderProjectResponse.body.projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('No valid recipients');
    });

    it('should validate escrowId is required and valid Mongo ID', async () => {
      // Act - Missing escrowId
      const response1 = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      expect(response1.status).toBe(422);
      expect(response1.body.error).toHaveProperty('code', 'validation_error');

      // Act - Invalid escrowId
      const response2 = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId: 'invalid-id',
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      expect(response2.status).toBe(422);
      expect(response2.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate amount is positive integer', async () => {
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

    it('should validate currency is 3-letter ISO code', async () => {
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

    it('should verify payout items match revenue calculation', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId,
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(201);

      // Get saved batch
      const savedBatch = await PayoutBatchModel.findOne({ escrowId });
      expect(savedBatch).toBeDefined();

      // Calculate expected breakdown using Task 31 logic
      const calculationResponse = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      const breakdown = calculationResponse.body.breakdown;

      // Verify payout items match calculation breakdown
      expect(savedBatch?.items).toHaveLength(breakdown.length);
      breakdown.forEach((item: any) => {
        const payoutItem = savedBatch?.items.find(
          p => p.userId.toString() === item.recipientId
        );
        expect(payoutItem).toBeDefined();
        expect(payoutItem?.netAmount).toBe(item.netAmount);
        expect(payoutItem?.fees).toBe(item.platformFeeShare);
        expect(payoutItem?.status).toBe('scheduled');
      });
    });

    it('should ensure totalNet matches sum of netAmounts', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/schedule-payouts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          escrowId,
          projectId,
          amount: 33333,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(201);

      // Get saved batch
      const savedBatch = await PayoutBatchModel.findOne({ escrowId });
      expect(savedBatch).toBeDefined();

      // Verify totalNet matches sum of netAmounts
      const sumOfNetAmounts = savedBatch?.items.reduce((sum, item) => sum + item.netAmount, 0) || 0;
      expect(savedBatch?.totalNet).toBe(sumOfNetAmounts);
    });
  });
});

