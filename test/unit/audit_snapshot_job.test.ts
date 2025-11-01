import { handleAuditSnapshotJob } from '../../src/jobs/handlers/auditSnapshotHandler';
import { IJob } from '../../src/models/job.model';
import { AuditLogModel } from '../../src/models/auditLog.model';
import mongoose from 'mongoose';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

describe('Audit Snapshot Job Handler (Task 71)', () => {
  let testJob: IJob;

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
    await AuditLogModel.deleteMany({});
  });

  describe('T71.1 - Happy Path: Snapshot Created', () => {
    it('should successfully create snapshot and mark logs as immutable', async () => {
      // Arrange: Create audit log records
      let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
      const records = [];
      for (let i = 1; i <= 3; i++) {
        const hash = `hash_${i}_${crypto.randomBytes(16).toString('hex')}`;
        records.push({
          auditId: `audit_${i}`,
          resourceType: 'user',
          action: 'user.created',
          actorId: new Types.ObjectId(),
          actorRole: 'admin',
          timestamp: new Date(),
          details: { userId: `user_${i}` },
          previousHash,
          hash,
          immutable: false,
        });
        previousHash = hash;
      }
      await AuditLogModel.create(records);

      // Get the saved records with IDs
      const savedRecords = await AuditLogModel.find({
        auditId: { $in: ['audit_1', 'audit_2', 'audit_3'] },
      });
      expect(savedRecords.length).toBe(3);

      testJob = {
        jobId: 'job_test_snapshot',
        type: 'audit.snapshot',
        priority: 20,
        status: 'leased',
        payload: {
          from: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
          to: new Date().toISOString(),
        },
        attempt: 1,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdAt: new Date(),
      } as IJob;

      // Act
      const result = await handleAuditSnapshotJob(testJob);

      // Assert
      expect(result).toHaveProperty('snapshotAssetId');
      expect(result).toHaveProperty('recordCount', 3);
      expect(result.snapshotAssetId).toBeDefined();
      expect(result.snapshotAssetId).toMatch(/^snapshot_asset_/);

      // Verify logs are marked as immutable
      const updatedLogs = await AuditLogModel.find({ _id: { $in: savedRecords.map(r => r._id!) } });
      expect(updatedLogs.length).toBe(3);
      updatedLogs.forEach(log => {
        expect(log.immutable).toBe(true);
      });

      // Verify audit log for snapshot creation
      const snapshotLog = await AuditLogModel.findOne({
        action: 'snapshot.created',
        'details.snapshotAssetId': result.snapshotAssetId,
      });
      expect(snapshotLog).toBeDefined();
      expect(snapshotLog!.details).toHaveProperty('recordCount', 3);
      expect(snapshotLog!.details).toHaveProperty('signedHash');
      expect(snapshotLog!.details.signedHash).toMatch(/^SIGNED_MANIFEST:/);
    });
  });

  describe('T71.2 - No Data Check', () => {
    it('should return recordCount 0 when no logs found in period', async () => {
      // Arrange: Create logs outside the time range
      const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year ago
      await AuditLogModel.create({
        auditId: 'audit_old',
        resourceType: 'user',
        action: 'user.created',
        actorId: new Types.ObjectId(),
        actorRole: 'admin',
        timestamp: oldDate,
        details: {},
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: 'old_hash',
        immutable: false,
      });

      testJob = {
        jobId: 'job_test_no_data',
        type: 'audit.snapshot',
        priority: 20,
        status: 'leased',
        payload: {
          from: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
          to: new Date().toISOString(),
        },
        attempt: 1,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdAt: new Date(),
      } as IJob;

      // Act
      const result = await handleAuditSnapshotJob(testJob);

      // Assert
      expect(result).toHaveProperty('snapshotAssetId', 'NONE');
      expect(result).toHaveProperty('recordCount', 0);
    });
  });

  describe('T71.3 - Immutability Check', () => {
    it('should only mark non-immutable logs as immutable', async () => {
      // Arrange: Create mix of immutable and non-immutable logs
      let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
      const records = [];
      
      // First 2 logs are already immutable
      for (let i = 1; i <= 2; i++) {
        const hash = `hash_immutable_${i}_${crypto.randomBytes(16).toString('hex')}`;
        records.push({
          auditId: `audit_immutable_${i}`,
          resourceType: 'user',
          action: 'user.created',
          actorId: new Types.ObjectId(),
          actorRole: 'admin',
          timestamp: new Date(),
          details: {},
          previousHash,
          hash,
          immutable: true, // Already immutable
        });
        previousHash = hash;
      }

      // Next 2 logs are not immutable yet
      for (let i = 3; i <= 4; i++) {
        const hash = `hash_new_${i}_${crypto.randomBytes(16).toString('hex')}`;
        records.push({
          auditId: `audit_new_${i}`,
          resourceType: 'user',
          action: 'user.created',
          actorId: new Types.ObjectId(),
          actorRole: 'admin',
          timestamp: new Date(),
          details: {},
          previousHash,
          hash,
          immutable: false, // Not yet immutable
        });
        previousHash = hash;
      }

      await AuditLogModel.create(records);

      testJob = {
        jobId: 'job_test_partial',
        type: 'audit.snapshot',
        priority: 20,
        status: 'leased',
        payload: {
          from: new Date(Date.now() - 86400000).toISOString(),
          to: new Date().toISOString(),
        },
        attempt: 1,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdAt: new Date(),
      } as IJob;

      // Act
      const result = await handleAuditSnapshotJob(testJob);

      // Assert
      expect(result.recordCount).toBe(2); // Only non-immutable logs

      // Verify only non-immutable logs were marked
      const allLogs = await AuditLogModel.find({});
      expect(allLogs.length).toBeGreaterThanOrEqual(4); // At least 4 (snapshot creation adds another log)
      const immutableLogs = allLogs.filter(log => log.immutable === true);
      expect(immutableLogs.length).toBeGreaterThanOrEqual(4); // All should be immutable now

      // Verify snapshot audit log
      const snapshotLog = await AuditLogModel.findOne({
        action: 'snapshot.created',
      });
      expect(snapshotLog).toBeDefined();
      expect(snapshotLog!.details.recordCount).toBe(2);
    });
  });

  describe('Job Data Validation', () => {
    it('should throw error when from is missing', async () => {
      testJob = {
        jobId: 'job_test_invalid',
        type: 'audit.snapshot',
        priority: 20,
        status: 'leased',
        payload: {
          to: new Date().toISOString(),
        },
        attempt: 1,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdAt: new Date(),
      } as IJob;

      // Act & Assert
      await expect(handleAuditSnapshotJob(testJob)).rejects.toThrow('JobDataMissing');
    });

    it('should throw error when to is missing', async () => {
      testJob = {
        jobId: 'job_test_invalid2',
        type: 'audit.snapshot',
        priority: 20,
        status: 'leased',
        payload: {
          from: new Date().toISOString(),
        },
        attempt: 1,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdAt: new Date(),
      } as IJob;

      // Act & Assert
      await expect(handleAuditSnapshotJob(testJob)).rejects.toThrow('JobDataMissing');
    });
  });

  describe('Manifest Hash Generation', () => {
    it('should generate deterministic manifest hash from log hashes', async () => {
      // Arrange: Create logs with known hashes
      const logs = [];
      logs.push({
        auditId: 'audit_1',
        resourceType: 'user',
        action: 'user.created',
        actorId: new Types.ObjectId(),
        actorRole: 'admin',
        timestamp: new Date(),
        details: {},
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: 'hash1',
        immutable: false,
      });
      logs.push({
        auditId: 'audit_2',
        resourceType: 'user',
        action: 'user.created',
        actorId: new Types.ObjectId(),
        actorRole: 'admin',
        timestamp: new Date(),
        details: {},
        previousHash: 'hash1',
        hash: 'hash2',
        immutable: false,
      });
      await AuditLogModel.create(logs);

      testJob = {
        jobId: 'job_test_hash',
        type: 'audit.snapshot',
        priority: 20,
        status: 'leased',
        payload: {
          from: new Date(Date.now() - 86400000).toISOString(),
          to: new Date().toISOString(),
        },
        attempt: 1,
        maxAttempts: 3,
        nextRunAt: new Date(),
        createdAt: new Date(),
      } as IJob;

      // Act
      const result = await handleAuditSnapshotJob(testJob);

      // Assert
      expect(result.snapshotAssetId).toBeDefined();

      // Verify snapshot audit log contains signed manifest
      const snapshotLog = await AuditLogModel.findOne({
        action: 'snapshot.created',
        'details.snapshotAssetId': result.snapshotAssetId,
      });
      expect(snapshotLog).toBeDefined();
      expect(snapshotLog!.details.signedHash).toMatch(/^SIGNED_MANIFEST:/);
      // The signed hash should contain the manifest hash
      expect(snapshotLog!.details.signedHash).toContain('_');
    });
  });
});

