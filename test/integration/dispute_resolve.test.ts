import request from 'supertest';
import app from '../../src/server';
import { DisputeRecordModel } from '../../src/models/disputeRecord.model';
import { EscrowModel } from '../../src/models/escrow.model';
import { AuditLogModel } from '../../src/models/auditLog.model';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import mongoose from 'mongoose';
import { Types } from 'mongoose';

describe('Dispute Resolution & Manual Escrow Action API Integration Tests (Task 65)', () => {
  let adminToken: string;
  let creatorToken: string;
  let adminUserId: string;
  let payerUserId: string;
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
    await DisputeRecordModel.deleteMany({});
    await EscrowModel.deleteMany({});
    await AuditLogModel.deleteMany({});
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});

    // Create admin user (signup as creator, then update role)
    await request(app).post('/auth/signup').send({
      email: 'admin@test.com',
      password: 'Admin123!',
      preferredName: 'Admin User',
      fullName: 'Admin User',
      role: 'creator',
    });
    // Get adminUserId from database
    const adminUser = await UserModel.findOne({ email: 'admin@test.com' });
    expect(adminUser).toBeDefined();
    adminUserId = adminUser!._id!.toString();

    // Update to admin role
    await UserModel.updateOne({ email: 'admin@test.com' }, { $set: { role: 'admin' } });

    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@test.com',
      password: 'Admin123!',
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.data?.token || adminLogin.body.accessToken;
    expect(adminToken).toBeDefined();

    // Create payer user
    await request(app).post('/auth/signup').send({
      email: 'payer@test.com',
      password: 'Payer123!',
      preferredName: 'Payer User',
      fullName: 'Payer User',
      role: 'creator',
    });
    // Get payerUserId from database
    const payerUser = await UserModel.findOne({ email: 'payer@test.com' });
    expect(payerUser).toBeDefined();
    payerUserId = payerUser!._id!.toString();

    // Create escrow for disputes
    const escrow = await EscrowModel.create({
      escrowId: 'esc_test_001',
      projectId: new Types.ObjectId(),
      milestoneId: new Types.ObjectId(),
      payerId: new Types.ObjectId(payerUserId),
      amount: 1000,
      currency: 'USD',
      provider: 'stripe',
      providerEscrowId: 'pi_test_001',
      status: 'disputed',
      transactions: [],
    });
    escrowId = escrow.escrowId;

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

  describe('GET /admin/disputes/queue', () => {
    it('T65.1 - should successfully retrieve dispute queue (200 OK)', async () => {
      // Arrange: Create dispute records
      await DisputeRecordModel.create([
        {
          disputeId: 'dsp_test_1',
          projectId: new Types.ObjectId(),
          escrowId: (await EscrowModel.findOne({ escrowId }))!._id!,
          milestoneId: new Types.ObjectId(),
          raisedBy: new Types.ObjectId(payerUserId),
          reason: 'Milestone not completed as specified in agreement.',
          status: 'open',
        },
        {
          disputeId: 'dsp_test_2',
          projectId: new Types.ObjectId(),
          escrowId: (await EscrowModel.findOne({ escrowId }))!._id!,
          milestoneId: new Types.ObjectId(),
          raisedBy: new Types.ObjectId(payerUserId),
          reason: 'Quality of work does not meet expectations.',
          status: 'under_review',
        },
        {
          disputeId: 'dsp_test_3',
          projectId: new Types.ObjectId(),
          escrowId: (await EscrowModel.findOne({ escrowId }))!._id!,
          milestoneId: new Types.ObjectId(),
          raisedBy: new Types.ObjectId(payerUserId),
          reason: 'Already resolved.',
          status: 'resolved',
        },
      ]);

      // Act
      const response = await request(app)
        .get('/admin/disputes/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(response.body.meta).toHaveProperty('total');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0]).toHaveProperty('disputeId');
      expect(response.body.data[0]).toHaveProperty('status');
      expect(response.body.data[0]).toHaveProperty('reason');
    });

    it('T65.1 - should filter by status', async () => {
      // Arrange: Create disputes with different statuses
      await DisputeRecordModel.create([
        {
          disputeId: 'dsp_status_1',
          projectId: new Types.ObjectId(),
          escrowId: (await EscrowModel.findOne({ escrowId }))!._id!,
          milestoneId: new Types.ObjectId(),
          raisedBy: new Types.ObjectId(payerUserId),
          reason: 'Open dispute.',
          status: 'open',
        },
        {
          disputeId: 'dsp_status_2',
          projectId: new Types.ObjectId(),
          escrowId: (await EscrowModel.findOne({ escrowId }))!._id!,
          milestoneId: new Types.ObjectId(),
          raisedBy: new Types.ObjectId(payerUserId),
          reason: 'Under review dispute.',
          status: 'under_review',
        },
      ]);

      // Act: Filter by status=open
      const response = await request(app)
        .get('/admin/disputes/queue')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ status: 'open', page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.every((d: any) => d.status === 'open')).toBe(true);
    });

    it('should return 403 for unauthorized access', async () => {
      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .get('/admin/disputes/queue')
        .set('Authorization', `Bearer ${creatorToken}`)
        .query({ page: 1, per_page: 20 });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });
  });

  describe('POST /admin/disputes/:disputeId/resolve', () => {
    let testDisputeId: string;

    beforeEach(async () => {
      // Create escrow for dispute
      const escrow = await EscrowModel.create({
        escrowId: 'esc_dispute_test',
        projectId: new Types.ObjectId(),
        milestoneId: new Types.ObjectId(),
        payerId: new Types.ObjectId(payerUserId),
        amount: 5000,
        currency: 'USD',
        provider: 'stripe',
        providerEscrowId: 'pi_dispute_test',
        status: 'disputed',
        transactions: [],
      });
      testEscrowId = escrow.escrowId;

      // Create test dispute
      const dispute = await DisputeRecordModel.create({
        disputeId: 'dsp_resolve_test',
        projectId: new Types.ObjectId(),
        escrowId: escrow._id!,
        milestoneId: new Types.ObjectId(),
        raisedBy: new Types.ObjectId(payerUserId),
        reason: 'Milestone deliverables were not met according to project requirements.',
        status: 'open',
      });
      testDisputeId = dispute.disputeId;
    });

    it('T65.2 - should successfully resolve dispute with release (200 OK)', async () => {
      // Arrange
      const payload = {
        resolution: 'release',
        notes: 'Milestone has been completed satisfactorily. Releasing full escrow amount to creator.',
      };

      // Act
      const response = await request(app)
        .post(`/admin/disputes/${testDisputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('disputeId', testDisputeId);
      expect(response.body.data).toHaveProperty('status', 'resolved');
      expect(response.body.data).toHaveProperty('resolution');
      expect(response.body.data.resolution).toHaveProperty('outcome', 'release');
      expect(response.body.data).toHaveProperty('message');

      // Verify dispute was updated
      const dispute = await DisputeRecordModel.findOne({ disputeId: testDisputeId });
      expect(dispute).toBeDefined();
      expect(dispute!.status).toBe('resolved');
      expect(dispute!.resolution).toBeDefined();
      expect(dispute!.resolution!.outcome).toBe('release');

      // Verify audit log was written
      const auditLog = await AuditLogModel.findOne({
        action: 'dispute.resolved.release',
        'details.disputeId': testDisputeId,
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.actorId?.toString()).toBe(adminUserId);
      expect(auditLog!.actorRole).toBe('admin');
    });

    it('T65.3 - should successfully resolve dispute with refund (200 OK)', async () => {
      // Arrange
      const payload = {
        resolution: 'refund',
        notes: 'Milestone was not completed. Refunding full escrow amount to payer.',
      };

      // Act
      const response = await request(app)
        .post(`/admin/disputes/${testDisputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('resolved');
      expect(response.body.data.resolution.outcome).toBe('refund');

      // Verify audit log was written
      const auditLog = await AuditLogModel.findOne({
        action: 'dispute.resolved.refund',
        'details.disputeId': testDisputeId,
      });
      expect(auditLog).toBeDefined();
    });

    it('T65.4 - should successfully resolve dispute with split (200 OK)', async () => {
      // Arrange: Split resolution - release partial and refund partial
      const payload = {
        resolution: 'split',
        releaseAmount: 3000,
        refundAmount: 2000,
        notes: 'Milestone partially completed. Releasing 60% to creator and refunding 40% to payer.',
      };

      // Act
      const response = await request(app)
        .post(`/admin/disputes/${testDisputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('resolved');
      expect(response.body.data.resolution.outcome).toBe('split');
      expect(response.body.data.resolution.resolvedAmount).toBe(3000);
      expect(response.body.data.resolution.refundAmount).toBe(2000);

      // Verify audit log was written
      const auditLog = await AuditLogModel.findOne({
        action: 'dispute.resolved.split',
        'details.disputeId': testDisputeId,
      });
      expect(auditLog).toBeDefined();
    });

    it('should successfully resolve dispute with deny (200 OK)', async () => {
      // Arrange: Deny resolution - no financial action
      const payload = {
        resolution: 'deny',
        notes: 'Dispute is invalid. No financial action required.',
      };

      // Act
      const response = await request(app)
        .post(`/admin/disputes/${testDisputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('resolved');
      expect(response.body.data.resolution.outcome).toBe('deny');
    });

    it('T65.5 - should return 403 for unauthorized access', async () => {
      // Arrange
      const payload = {
        resolution: 'release',
        notes: 'Attempting unauthorized resolution.',
      };

      // Act: Try to access as creator (non-admin)
      const response = await request(app)
        .post(`/admin/disputes/${testDisputeId}/resolve`)
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('permission_denied');
    });

    it('T65.6 - should return 404 for already resolved dispute', async () => {
      // Arrange: Mark dispute as already resolved
      await DisputeRecordModel.updateOne(
        { disputeId: testDisputeId },
        {
          $set: {
            status: 'resolved',
            resolution: {
              outcome: 'release',
              notes: 'Already resolved',
              resolvedBy: new Types.ObjectId(adminUserId),
              resolvedAt: new Date(),
            },
          },
        }
      );

      const payload = {
        resolution: 'release',
        notes: 'Attempting to resolve already resolved dispute.',
      };

      // Act
      const response = await request(app)
        .post(`/admin/disputes/${testDisputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('dispute_not_found');
    });

    it('should return 422 for invalid resolution', async () => {
      // Arrange
      const payload = {
        resolution: 'invalid_resolution',
        notes: 'Invalid resolution attempt.',
      };

      // Act
      const response = await request(app)
        .post(`/admin/disputes/${testDisputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 422 for notes too short', async () => {
      // Arrange
      const payload = {
        resolution: 'release',
        notes: 'Short', // Less than 10 characters
      };

      // Act
      const response = await request(app)
        .post(`/admin/disputes/${testDisputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 404 for non-existent dispute', async () => {
      // Arrange
      const payload = {
        resolution: 'release',
        notes: 'Resolving non-existent dispute.',
      };

      // Act
      const response = await request(app)
        .post('/admin/disputes/non_existent_dispute/resolve')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('dispute_not_found');
    });
  });
});

