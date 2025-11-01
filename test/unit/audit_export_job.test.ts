import { handleAuditExportJob } from '../../src/jobs/handlers/auditExportHandler';
import { IJob } from '../../src/models/job.model';
import { AuditLogModel } from '../../src/models/auditLog.model';
import { AssetModel } from '../../src/models/asset.model';
import { NotificationModel } from '../../src/models/notification.model';
import mongoose from 'mongoose';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

describe('Audit Export Job Handler (Task 62)', () => {
  let testJob: IJob;
  let requesterId: string;

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
    await AssetModel.deleteMany({});
    await NotificationModel.deleteMany({});

    requesterId = new Types.ObjectId().toString();
    testJob = {
      jobId: 'job_test_export',
      type: 'export.audit',
      priority: 20,
      status: 'leased',
      payload: {
        exportFilters: {},
        format: 'csv',
        requesterId,
        requesterEmail: 'admin@example.com',
      },
      attempt: 1,
      maxAttempts: 3,
      nextRunAt: new Date(),
      createdBy: new Types.ObjectId(requesterId),
      createdAt: new Date(),
    } as IJob;
  });

  describe('T62.1 - Happy Path: Full Export', () => {
    it('should successfully export audit logs and register asset', async () => {
      // Arrange: Create audit log records
      let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
      const records = [];
      for (let i = 1; i <= 5; i++) {
        const hash = `hash_${i}_${crypto.randomBytes(16).toString('hex')}`;
        records.push({
          auditId: `audit_${i}`,
          resourceType: 'user',
          action: 'user.created',
          actorId: new Types.ObjectId(requesterId),
          actorRole: 'admin',
          timestamp: new Date(),
          details: { userId: `user_${i}` },
          previousHash,
          hash,
        });
        previousHash = hash;
      }
      await AuditLogModel.create(records);

      // Act
      const result = await handleAuditExportJob(testJob);

      // Assert
      expect(result).toHaveProperty('exportAssetId');
      expect(result).toHaveProperty('recordCount', 5);
      expect(result.exportAssetId).toBeDefined();

      // Verify asset was created
      const asset = await AssetModel.findById(result.exportAssetId);
      expect(asset).toBeDefined();
      expect(asset!.filename).toContain('audit_export_job_test_export');
      expect(asset!.mimeType).toBe('text/csv');
      expect(asset!.processed).toBe(true);
      expect(asset!.versions).toHaveLength(1);
      expect(asset!.versions[0]).toBeDefined();
      if (asset!.versions[0]) {
        expect(asset!.versions[0].size).toBeGreaterThan(0);
        expect(asset!.versions[0].sha256).toBeDefined();
      }

      // Verify notification was created
      const notification = await NotificationModel.findOne({
        'recipients.userId': new Types.ObjectId(requesterId),
      });
      expect(notification).toBeDefined();
      expect(notification!.content).toBeDefined();
      expect(notification!.content.in_app).toBeDefined();
      if (notification!.content.in_app) {
        expect(notification!.content.in_app.title).toBe('Audit Export Ready');
      }
    });

    it('should export in CSV format', async () => {
      // Arrange
      await AuditLogModel.create({
        auditId: 'audit_csv_1',
        resourceType: 'user',
        action: 'user.created',
        actorId: new Types.ObjectId(requesterId),
        actorRole: 'admin',
        timestamp: new Date(),
        details: { userId: 'user_1' },
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: 'hash_csv_1',
      });

      testJob.payload.format = 'csv';

      // Act
      const result = await handleAuditExportJob(testJob);

      // Assert
      expect(result.recordCount).toBe(1);
      const asset = await AssetModel.findById(result.exportAssetId);
      expect(asset!.mimeType).toBe('text/csv');
      expect(asset!.filename).toMatch(/\.csv$/);
    });

    it('should export in NDJSON format', async () => {
      // Arrange
      await AuditLogModel.create({
        auditId: 'audit_ndjson_1',
        resourceType: 'user',
        action: 'user.created',
        actorId: new Types.ObjectId(requesterId),
        actorRole: 'admin',
        timestamp: new Date(),
        details: { userId: 'user_1' },
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: 'hash_ndjson_1',
      });

      testJob.payload.format = 'ndjson';

      // Act
      const result = await handleAuditExportJob(testJob);

      // Assert
      expect(result.recordCount).toBe(1);
      const asset = await AssetModel.findById(result.exportAssetId);
      expect(asset!.mimeType).toBe('application/x-ndjson');
      expect(asset!.filename).toMatch(/\.ndjson$/);
    });

    it('should export in PDF format (simplified)', async () => {
      // Arrange
      await AuditLogModel.create({
        auditId: 'audit_pdf_1',
        resourceType: 'user',
        action: 'user.created',
        actorId: new Types.ObjectId(requesterId),
        actorRole: 'admin',
        timestamp: new Date(),
        details: { userId: 'user_1' },
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: 'hash_pdf_1',
      });

      testJob.payload.format = 'pdf';

      // Act
      const result = await handleAuditExportJob(testJob);

      // Assert
      expect(result.recordCount).toBe(1);
      const asset = await AssetModel.findById(result.exportAssetId);
      expect(asset!.mimeType).toBe('application/pdf');
      expect(asset!.filename).toMatch(/\.pdf$/);
    });

    it('should apply filters correctly', async () => {
      // Arrange: Create records with different actions
      await AuditLogModel.create([
        {
          auditId: 'audit_1',
          resourceType: 'user',
          action: 'user.created',
          actorId: new Types.ObjectId(requesterId),
          actorRole: 'admin',
          timestamp: new Date(),
          details: {},
          previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
          hash: 'hash_1',
        },
        {
          auditId: 'audit_2',
          resourceType: 'user',
          action: 'user.suspended',
          actorId: new Types.ObjectId(requesterId),
          actorRole: 'admin',
          timestamp: new Date(),
          details: {},
          previousHash: 'hash_1',
          hash: 'hash_2',
        },
      ]);

      // Filter by action
      testJob.payload.exportFilters = { action: 'user.created' };

      // Act
      const result = await handleAuditExportJob(testJob);

      // Assert
      expect(result.recordCount).toBe(1);
    });
  });

  describe('T62.2 - Fail: No Records', () => {
    it('should throw NoRecordsFound when no records match filters', async () => {
      // Arrange: No records in database
      testJob.payload.exportFilters = { action: 'nonexistent.action' };

      // Act & Assert
      await expect(handleAuditExportJob(testJob)).rejects.toThrow('NoRecordsFound');

      // Verify no asset was created
      const assets = await AssetModel.find({});
      expect(assets).toHaveLength(0);
    });
  });

  describe('T62.3 - Success Data Check', () => {
    it('should return exportAssetId in result payload', async () => {
      // Arrange
      await AuditLogModel.create({
        auditId: 'audit_1',
        resourceType: 'user',
        action: 'user.created',
        actorId: new Types.ObjectId(requesterId),
        actorRole: 'admin',
        timestamp: new Date(),
        details: {},
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: 'hash_1',
      });

      // Act
      const result = await handleAuditExportJob(testJob);

      // Assert
      expect(result).toHaveProperty('exportAssetId');
      expect(result.exportAssetId).toBeDefined();
      expect(typeof result.exportAssetId).toBe('string');

      // Verify asset exists with this ID
      const asset = await AssetModel.findById(result.exportAssetId);
      expect(asset).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw JobDataMissing for missing exportFilters', async () => {
      // Arrange
      testJob.payload = {
        format: 'csv',
        requesterId,
      };

      // Act & Assert
      await expect(handleAuditExportJob(testJob)).rejects.toThrow('JobDataMissing');
    });

    it('should throw JobDataMissing for missing format', async () => {
      // Arrange
      testJob.payload = {
        exportFilters: {},
        requesterId,
      };

      // Act & Assert
      await expect(handleAuditExportJob(testJob)).rejects.toThrow('JobDataMissing');
    });

    it('should throw JobDataMissing for missing requesterId', async () => {
      // Arrange
      testJob.payload = {
        exportFilters: {},
        format: 'csv',
      };

      // Act & Assert
      await expect(handleAuditExportJob(testJob)).rejects.toThrow('JobDataMissing');
    });
  });

  describe('Date Range Filtering', () => {
    it('should filter by date range', async () => {
      // Arrange: Create records with different dates
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const today = new Date();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await AuditLogModel.create([
        {
          auditId: 'audit_yesterday',
          resourceType: 'user',
          action: 'user.created',
          actorId: new Types.ObjectId(requesterId),
          actorRole: 'admin',
          timestamp: yesterday,
          details: {},
          previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
          hash: 'hash_yesterday',
        },
        {
          auditId: 'audit_today',
          resourceType: 'user',
          action: 'user.created',
          actorId: new Types.ObjectId(requesterId),
          actorRole: 'admin',
          timestamp: today,
          details: {},
          previousHash: 'hash_yesterday',
          hash: 'hash_today',
        },
        {
          auditId: 'audit_tomorrow',
          resourceType: 'user',
          action: 'user.created',
          actorId: new Types.ObjectId(requesterId),
          actorRole: 'admin',
          timestamp: tomorrow,
          details: {},
          previousHash: 'hash_today',
          hash: 'hash_tomorrow',
        },
      ]);

      // Filter from today onwards
      testJob.payload.exportFilters = {
        from: today.toISOString().split('T')[0],
      };

      // Act
      const result = await handleAuditExportJob(testJob);

      // Assert: Should include today and tomorrow (2 records)
      expect(result.recordCount).toBe(2);
    });
  });
});

