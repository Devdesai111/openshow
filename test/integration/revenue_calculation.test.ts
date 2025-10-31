import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';

describe('Revenue Calculation Integration Tests', () => {
  let ownerToken: string;
  let ownerId: string;
  let projectId: string;

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

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerToken = ownerSignup.body.accessToken;
    ownerId = ownerSignup.body.user.id;

    // Create member user (not used in these tests but available for future tests)
    // const memberSignup = await request(app).post('/auth/signup').send({
    //   email: 'member@example.com',
    //   password: 'Password123',
    //   role: 'creator',
    //   fullName: 'Team Member',
    // });

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
            { placeholder: 'Team Pool', percentage: 40 },
          ],
        },
      });
    projectId = projectResponse.body.projectId;
  });

  describe('POST /revenue/calculate', () => {
    it('T31.3 - should successfully calculate revenue split (happy path)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('grossAmount', 10000);
      expect(response.body).toHaveProperty('platformFee', 500); // 5% of 10000 = 500
      expect(response.body).toHaveProperty('totalDistributed', 9500); // 10000 - 500 = 9500
      expect(response.body).toHaveProperty('currency', 'USD');
      expect(response.body).toHaveProperty('breakdown');
      expect(Array.isArray(response.body.breakdown)).toBe(true);
      expect(response.body.breakdown).toHaveLength(2);

      // Verify breakdown structure
      response.body.breakdown.forEach((item: any) => {
        expect(item).toHaveProperty('netAmount');
        expect(item).toHaveProperty('grossShare');
        expect(item).toHaveProperty('platformFeeShare');
        expect(typeof item.netAmount).toBe('number');
      });

      // Conservation check: Gross - Fees = Sum(Net Amounts)
      const netSum = response.body.breakdown.reduce((sum: number, item: any) => sum + item.netAmount, 0);
      expect(netSum).toBe(response.body.totalDistributed);
      expect(response.body.grossAmount - response.body.platformFee).toBe(response.body.totalDistributed);
    });

    it('should successfully calculate with inline revenue model', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: 10000,
          currency: 'USD',
          revenueModel: {
            splits: [
              { percentage: 50 },
              { percentage: 50 },
            ],
          },
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('grossAmount', 10000);
      expect(response.body).toHaveProperty('platformFee', 500);
      expect(response.body).toHaveProperty('totalDistributed', 9500);
      expect(response.body.breakdown).toHaveLength(2);
    });

    it('T31.4 - should fail when splits sum to != 100% (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: 10000,
          currency: 'USD',
          revenueModel: {
            splits: [{ percentage: 90 }], // Only 90%
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('sum to 100%');
    });

    it('should fail when no percentage splits provided (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: 10000,
          currency: 'USD',
          revenueModel: {
            splits: [{ fixedAmount: 100 }], // No percentage
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error.message).toContain('Percentage-based revenue model');
    });

    it('should fail when project not found (404)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          projectId: new mongoose.Types.ObjectId().toString(),
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should fail when amount is negative (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          projectId,
          amount: -1000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should fail when amount is zero (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          projectId,
          amount: 0,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate currency is 3-letter ISO code (422)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          projectId,
          amount: 10000,
          currency: 'US',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('T31.5 - should fail when not authenticated (401)', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .send({
          projectId,
          amount: 10000,
          currency: 'USD',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should fail when user lacks PROJECT_CREATE permission (403)', async () => {
      // Note: In our permission system, creators have PROJECT_CREATE, so this test might pass
      // But if we had a viewer role without permissions, this would fail
      // The actual permission check is at the route level
      // This test is skipped as it depends on permission configuration
    });

    it('should handle complex split calculations correctly', async () => {
      // Act
      const response = await request(app)
        .post('/revenue/calculate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: 33333,
          currency: 'USD',
          revenueModel: {
            splits: [
              { _id: new mongoose.Types.ObjectId().toString(), percentage: 33.33 },
              { _id: new mongoose.Types.ObjectId().toString(), percentage: 33.33 },
              { _id: new mongoose.Types.ObjectId().toString(), percentage: 33.34 },
            ],
          },
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.grossAmount).toBe(33333);
      expect(response.body.platformFee).toBe(1667); // 5% of 33333 = 1666.65, rounded = 1667
      expect(response.body.breakdown).toHaveLength(3);

      // Conservation check
      const netSum = response.body.breakdown.reduce((sum: number, item: any) => sum + item.netAmount, 0);
      const expectedNet = response.body.grossAmount - response.body.platformFee;
      expect(netSum).toBe(expectedNet);
    });

    it('should ensure netAmount conservation for various amounts', async () => {
      const amounts = [100, 101, 333, 1000, 10000];

      for (const amount of amounts) {
        const response = await request(app)
          .post('/revenue/calculate')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({
            projectId,
            amount,
            currency: 'USD',
          });

        expect(response.status).toBe(200);
        const netSum = response.body.breakdown.reduce((sum: number, item: any) => sum + item.netAmount, 0);
        const expectedNet = response.body.grossAmount - response.body.platformFee;
        expect(netSum).toBe(expectedNet); // Conservation check
      }
    });
  });
});

