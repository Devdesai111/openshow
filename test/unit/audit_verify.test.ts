import { AuditService } from '../../src/services/audit.service';
import { AuditLogModel } from '../../src/models/auditLog.model';
import mongoose from 'mongoose';
import { Types } from 'mongoose';

describe('Audit Chain Verification (Task 72)', () => {
  let auditService: AuditService;

  beforeAll(async () => {
    const testDbUri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/openshow-test';
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    await mongoose.connect(testDbUri);
    auditService = new AuditService();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await AuditLogModel.deleteMany({});
  });

  describe('T72.1 - Happy Path: Integrity OK', () => {
    it('should verify integrity of untouched logs', async () => {
      // Arrange: Create a chain of logs using the service method
      const systemUserId = '000000000000000000000001';
      for (let i = 1; i <= 5; i++) {
        await auditService.logAuditEntry({
          resourceType: 'user',
          resourceId: new Types.ObjectId().toString(),
          action: 'user.created',
          actorId: systemUserId,
          actorRole: 'system',
          details: { userId: `user_${i}` },
        });
      }

      // Act
      const report = await auditService.verifyAuditChainIntegrity();

      // Assert
      expect(report.status).toBe('INTEGRITY_OK');
      expect(report.tamperDetected).toBe(false);
      expect(report.firstMismatchId).toBeNull();
      expect(report.checkedLogsCount).toBe(5);
      expect(report.verificationHash).toBeDefined();
    });
  });

  describe('T72.2 - Tamper Detection', () => {
    it('should detect tampering when a log is manually altered', async () => {
      // Arrange: Create a chain of logs using the service method
      const systemUserId = '000000000000000000000001';
      for (let i = 1; i <= 3; i++) {
        await auditService.logAuditEntry({
          resourceType: 'user',
          resourceId: new Types.ObjectId().toString(),
          action: 'user.created',
          actorId: systemUserId,
          actorRole: 'system',
          details: { userId: `user_${i}` },
        });
      }

      // Get the second log's auditId
      const logs = await AuditLogModel.find({}).sort({ timestamp: 1 });
      expect(logs.length).toBe(3);
      const log2AuditId = logs[1]!.auditId;

      // Manually tamper with log 2 (alter the stored hash)
      await AuditLogModel.updateOne(
        { auditId: log2AuditId },
        { $set: { hash: 'TAMPERED_HASH_VALUE_12345' } }
      );

      // Act
      const report = await auditService.verifyAuditChainIntegrity();

      // Assert
      expect(report.status).toBe('TAMPER_DETECTED');
      expect(report.tamperDetected).toBe(true);
      expect(report.firstMismatchId).toBe(log2AuditId); // First log where tampering was detected
      expect(report.checkedLogsCount).toBeGreaterThan(0); // At least one log was verified before tampering was detected
      expect(report.verificationHash).toBeDefined();
    });

    it('should detect tampering when log details are altered', async () => {
      // Arrange: Create a chain of logs using the service method
      const systemUserId = '000000000000000000000001';
      for (let i = 1; i <= 3; i++) {
        await auditService.logAuditEntry({
          resourceType: 'user',
          resourceId: new Types.ObjectId().toString(),
          action: 'user.created',
          actorId: systemUserId,
          actorRole: 'system',
          details: { userId: `user_${i}` },
        });
      }

      // Get the second log's auditId
      const logs = await AuditLogModel.find({}).sort({ timestamp: 1 });
      expect(logs.length).toBe(3);
      const log2AuditId = logs[1]!.auditId;

      // Manually tamper with log 2's details (which changes the expected hash)
      await AuditLogModel.updateOne(
        { auditId: log2AuditId },
        { $set: { details: { userId: 'user_2_TAMPERED' } } }
      );

      // Act
      const report = await auditService.verifyAuditChainIntegrity();

      // Assert
      expect(report.status).toBe('TAMPER_DETECTED');
      expect(report.tamperDetected).toBe(true);
      expect(report.firstMismatchId).toBe(log2AuditId); // First log where tampering was detected
      expect(report.checkedLogsCount).toBeGreaterThan(0); // At least one log was verified
    });
  });

  describe('T72.4 - Chain Logic', () => {
    it('should correctly compute chain where calculated hash of Log 2 equals Log 3 expected previousHash', async () => {
      // Arrange: Create a chain of 3 logs using the service method
      const systemUserId = '000000000000000000000001';
      for (let i = 1; i <= 3; i++) {
        await auditService.logAuditEntry({
          resourceType: 'user',
          resourceId: new Types.ObjectId().toString(),
          action: 'user.created',
          actorId: systemUserId,
          actorRole: 'system',
          details: { userId: `user_${i}` },
        });
      }

      // Act: Verify chain
      const report = await auditService.verifyAuditChainIntegrity();

      // Assert
      expect(report.status).toBe('INTEGRITY_OK');
      expect(report.tamperDetected).toBe(false);
      expect(report.checkedLogsCount).toBe(3);

      // Verify the chain logic: Each log's previousHash should equal the previous log's hash
      const savedLogs = await AuditLogModel.find({}).sort({ timestamp: 1 });
      expect(savedLogs.length).toBe(3);
      expect(savedLogs[0]).toBeDefined();
      expect(savedLogs[1]).toBeDefined();
      expect(savedLogs[2]).toBeDefined();

      // Log 2's stored previousHash should equal Log 1's hash (chain link)
      expect(savedLogs[1]!.previousHash).toBe(savedLogs[0]!.hash);
      // Log 3's previousHash should equal Log 2's hash (chain link)
      expect(savedLogs[2]!.previousHash).toBe(savedLogs[1]!.hash);

      // The verification report should confirm integrity
      expect(report.verificationHash).toBe(savedLogs[2]!.hash); // Last log's hash
    });
  });

  describe('Date Range Filtering', () => {
    it('should verify only logs within date range', async () => {
      // Arrange: Create logs using the service method (they will have recent timestamps)
      const systemUserId = '000000000000000000000001';
      
      // Create recent logs
      for (let i = 1; i <= 2; i++) {
        await auditService.logAuditEntry({
          resourceType: 'user',
          resourceId: new Types.ObjectId().toString(),
          action: 'user.created',
          actorId: systemUserId,
          actorRole: 'system',
          details: { userId: `user_${i}` },
        });
      }

      // Act: Verify only recent logs (from 10 days ago to now)
      const fromDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const now = new Date();
      const report = await auditService.verifyAuditChainIntegrity(fromDate, now);

      // Assert
      expect(report.status).toBe('INTEGRITY_OK');
      expect(report.checkedLogsCount).toBeGreaterThanOrEqual(2); // At least the recent logs
      expect(report.tamperDetected).toBe(false);
    });
  });

  describe('No Data Scenario', () => {
    it('should return NO_DATA status when no logs exist', async () => {
      // Act
      const report = await auditService.verifyAuditChainIntegrity();

      // Assert
      expect(report.status).toBe('NO_DATA');
      expect(report.checkedLogsCount).toBe(0);
      expect(report.tamperDetected).toBe(false);
      expect(report.firstMismatchId).toBeNull();
      expect(report.verificationHash).toBe('0x0');
    });

    it('should return NO_DATA status when no logs in date range', async () => {
      // Arrange: Create logs (they will have recent timestamps from service method)
      const systemUserId = '000000000000000000000001';
      await auditService.logAuditEntry({
        resourceType: 'user',
        resourceId: new Types.ObjectId().toString(),
        action: 'user.created',
        actorId: systemUserId,
        actorRole: 'system',
        details: {},
      });

      // Act: Verify logs from future date range (no logs should match)
      const fromDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year in future
      const toDate = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000); // 1 year + 1 day in future
      const report = await auditService.verifyAuditChainIntegrity(fromDate, toDate);

      // Assert
      expect(report.status).toBe('NO_DATA');
      expect(report.checkedLogsCount).toBe(0);
    });
  });
});

