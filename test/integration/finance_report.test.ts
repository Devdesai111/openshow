import request from 'supertest';
import app from '../../src/server';
import { PaymentTransactionModel } from '../../src/models/paymentTransaction.model';
import { PayoutBatchModel } from '../../src/models/payout.model';
import { AuditLogModel } from '../../src/models/auditLog.model';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import mongoose from 'mongoose';
import { Types } from 'mongoose';

describe('Accounting Integration & Ledger Exports API Integration Tests (Task 67)', () => {
  let adminToken: string;
  let creatorToken: string;
  let adminUserId: string;

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
    await PaymentTransactionModel.deleteMany({});
    await PayoutBatchModel.deleteMany({});
    await AuditLogModel.deleteMany({});
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});

    // Create admin user
    await request(app).post('/auth/signup').send({
      email: 'admin@test.com',
      password: 'Admin123!',
      preferredName: 'Admin User',
      fullName: 'Admin User',
      role: 'creator',
    });

    const adminUser = await UserModel.findOne({ email: 'admin@test.com' });
    expect(adminUser).toBeDefined();
    adminUserId = adminUser!._id!.toString();

    await UserModel.updateOne({ email: 'admin@test.com' }, { $set: { role: 'admin' } });

    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@test.com',
      password: 'Admin123!',
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.data?.token || adminLogin.body.accessToken;
    expect(adminToken).toBeDefined();

    // Create creator user
    await request(app).post('/auth/signup').send({
      email: 'creator@test.com',
      password: 'Creator123!',
      preferredName: 'Creator User',
      fullName: 'Creator User',
      role: 'creator',
    });

    const creatorLogin = await request(app).post('/auth/login').send({
      email: 'creator@test.com',
      password: 'Creator123!',
    });
    expect(creatorLogin.status).toBe(200);
    creatorToken = creatorLogin.body.data?.token || creatorLogin.body.accessToken;
    expect(creatorToken).toBeDefined();
  });

  describe('GET /admin/reports/finance', () => {
    it('T67.1 - should successfully generate finance report with aggregation (200 OK)', async () => {
      // Arrange: Create test payment transactions and payout batches
      const testDate1 = new Date('2025-01-01T00:00:00Z');

      // Create successful escrow_lock transactions
      await PaymentTransactionModel.create([
        {
          intentId: 'payint_test_1',
          projectId: new Types.ObjectId(),
          milestoneId: new Types.ObjectId(),
          payerId: new Types.ObjectId(),
          provider: 'stripe',
          type: 'escrow_lock',
          amount: 10000, // $100.00
          currency: 'USD',
          status: 'succeeded',
          createdAt: testDate1,
        },
        {
          intentId: 'payint_test_2',
          projectId: new Types.ObjectId(),
          milestoneId: new Types.ObjectId(),
          payerId: new Types.ObjectId(),
          provider: 'stripe',
          type: 'escrow_lock',
          amount: 5000, // $50.00
          currency: 'USD',
          status: 'succeeded',
          createdAt: testDate1,
        },
        {
          intentId: 'payint_test_3',
          projectId: new Types.ObjectId(),
          milestoneId: new Types.ObjectId(),
          payerId: new Types.ObjectId(),
          provider: 'stripe',
          type: 'refund',
          amount: 2000, // $20.00
          currency: 'USD',
          status: 'succeeded',
          createdAt: testDate1,
        },
      ]);

      // Create payout batch with paid items
      await PayoutBatchModel.create({
        batchId: 'batch_test_1',
        escrowId: new Types.ObjectId(),
        scheduledBy: new Types.ObjectId(),
        currency: 'USD',
        items: [
          {
            userId: new Types.ObjectId(),
            amount: 10000, // $100.00
            fees: 500, // $5.00 platform fee
            taxWithheld: 0,
            netAmount: 9500, // $95.00
            status: 'paid',
            attempts: 1,
          },
          {
            userId: new Types.ObjectId(),
            amount: 5000, // $50.00
            fees: 250, // $2.50 platform fee
            taxWithheld: 0,
            netAmount: 4750, // $47.50
            status: 'paid',
            attempts: 1,
          },
        ],
        totalNet: 14250,
        createdAt: testDate1,
      });

      // Act
      const response = await request(app)
        .get('/admin/reports/finance')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({
          from: '2025-01-01T00:00:00Z',
          to: '2025-01-31T23:59:59Z',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      const report = response.body.data;
      expect(report).toHaveProperty('period');
      expect(report).toHaveProperty('totalVolumeCollected');
      expect(report.totalVolumeCollected).toHaveProperty('amount');
      expect(report.totalVolumeCollected).toHaveProperty('currency', 'USD');
      expect(report).toHaveProperty('totalPlatformFees');
      expect(report).toHaveProperty('totalNetPayouts');
      expect(report).toHaveProperty('transactionCounts');

      // Verify aggregation: escrow_lock transactions should total $150.00
      expect(report.totalVolumeCollected.amount).toBe(15000);
      expect(report.transactionCounts.escrow_lock).toBe(2);
      expect(report.transactionCounts.refund).toBe(1);

      // Verify payout aggregation: fees = $7.50, net = $142.50
      expect(report.totalPlatformFees.amount).toBe(750);
      expect(report.totalNetPayouts.amount).toBe(14250);
    });

    it('T67.2 - should trigger export job when export=true (202 Accepted)', async () => {
      // Arrange: Create test data
      const testDate1 = new Date('2025-01-01T00:00:00Z');

      await PaymentTransactionModel.create({
        intentId: 'payint_export_test',
        projectId: new Types.ObjectId(),
        milestoneId: new Types.ObjectId(),
        payerId: new Types.ObjectId(),
        provider: 'stripe',
        type: 'escrow_lock',
        amount: 10000,
        currency: 'USD',
        status: 'succeeded',
        createdAt: testDate1,
      });

      // Act: Request with export=true
      const response = await request(app)
        .get('/admin/reports/finance')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({
          from: '2025-01-01T00:00:00Z',
          to: '2025-01-31T23:59:59Z',
          export: 'true',
        });

      // Assert: Should return 202 Accepted
      expect(response.status).toBe(202);
    });

    it('T67.3 - should return 403 for unauthorized access', async () => {
      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .get('/admin/reports/finance')
        .set('Authorization', `Bearer ${creatorToken}`)
        .query({
          from: '2025-01-01T00:00:00Z',
          to: '2025-01-31T23:59:59Z',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('T67.4 - should return 422 for invalid date format', async () => {
      // Act: Request with invalid date format
      const response = await request(app)
        .get('/admin/reports/finance')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({
          from: 'invalid-date',
          to: '2025-01-31T23:59:59Z',
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should audit log report generation', async () => {
      // Arrange
      const testDate1 = new Date('2025-01-01T00:00:00Z');

      await PaymentTransactionModel.create({
        intentId: 'payint_audit_test',
        projectId: new Types.ObjectId(),
        milestoneId: new Types.ObjectId(),
        payerId: new Types.ObjectId(),
        provider: 'stripe',
        type: 'escrow_lock',
        amount: 10000,
        currency: 'USD',
        status: 'succeeded',
        createdAt: testDate1,
      });

      // Act
      await request(app)
        .get('/admin/reports/finance')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({
          from: '2025-01-01T00:00:00Z',
          to: '2025-01-31T23:59:59Z',
        });

      // Assert: Verify audit log was created
      const auditLog = await AuditLogModel.findOne({
        action: 'report.finance.generated',
        actorId: new Types.ObjectId(adminUserId),
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.actorId?.toString()).toBe(adminUserId);
      expect(auditLog!.actorRole).toBe('admin');
    });

    it('should handle empty result set gracefully', async () => {
      // Act: Request report for period with no data
      const response = await request(app)
        .get('/admin/reports/finance')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({
          from: '2025-01-01T00:00:00Z',
          to: '2025-01-31T23:59:59Z',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('period');
      expect(response.body.data.totalVolumeCollected.amount).toBe(0);
      expect(response.body.data.totalPlatformFees.amount).toBe(0);
      expect(response.body.data.totalNetPayouts.amount).toBe(0);
      expect(Object.keys(response.body.data.transactionCounts)).toHaveLength(0);
    });

    it('should filter by date range correctly', async () => {
      // Arrange: Create transactions in and out of range
      const insideRange = new Date('2025-01-15T00:00:00Z');
      const outsideRange = new Date('2025-02-15T00:00:00Z');

      await PaymentTransactionModel.create([
        {
          intentId: 'payint_inside_1',
          projectId: new Types.ObjectId(),
          milestoneId: new Types.ObjectId(),
          payerId: new Types.ObjectId(),
          provider: 'stripe',
          type: 'escrow_lock',
          amount: 10000,
          currency: 'USD',
          status: 'succeeded',
          createdAt: insideRange,
        },
        {
          intentId: 'payint_outside_1',
          projectId: new Types.ObjectId(),
          milestoneId: new Types.ObjectId(),
          payerId: new Types.ObjectId(),
          provider: 'stripe',
          type: 'escrow_lock',
          amount: 50000,
          currency: 'USD',
          status: 'succeeded',
          createdAt: outsideRange,
        },
      ]);

      // Act: Request report only for January
      const response = await request(app)
        .get('/admin/reports/finance')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({
          from: '2025-01-01T00:00:00Z',
          to: '2025-01-31T23:59:59Z',
        });

      // Assert: Should only include inside-range transaction
      expect(response.status).toBe(200);
      expect(response.body.data.totalVolumeCollected.amount).toBe(10000);
      expect(response.body.data.transactionCounts.escrow_lock).toBe(1);
    });
  });
});

