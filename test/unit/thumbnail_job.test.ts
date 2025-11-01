import { handleThumbnailJob } from '../../src/jobs/handlers/thumbnailHandler';
import { IJob } from '../../src/models/job.model';
import { AssetModel } from '../../src/models/asset.model';
import mongoose from 'mongoose';

describe('Thumbnail Job Handler Unit Tests', () => {
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
    await AssetModel.deleteMany({});
  });

  describe('handleThumbnailJob', () => {
    it('T54.5 - should successfully process thumbnail job and call markAssetProcessed', async () => {
      // Arrange: Create a source asset
      const sourceAsset = await AssetModel.create({
        uploaderId: new mongoose.Types.ObjectId(),
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        versions: [{
          versionNumber: 1,
          storageKey: 'test-key',
          sha256: 'test-hash',
          size: 1000,
          uploaderId: new mongoose.Types.ObjectId(),
        }],
      });

      const job: IJob = {
        jobId: 'job_123',
        type: 'thumbnail.create',
        payload: {
          assetId: sourceAsset._id.toString(),
          versionNumber: 1,
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act
      const result = await handleThumbnailJob(job);

      // Assert
      expect(result).toBeDefined();
      expect(result).toHaveProperty('newAssetId');
      expect(typeof result.newAssetId).toBe('string');
      // Mock ID is a valid ObjectId string
      expect(result.newAssetId).toMatch(/^[0-9a-fA-F]{24}$/);
      
      // Verify source asset was updated
      const updatedAsset = await AssetModel.findById(sourceAsset._id);
      expect(updatedAsset).toBeDefined();
      expect(updatedAsset!.processed).toBe(true);
      expect(updatedAsset!.thumbnailAssetId).toBeDefined();
    });

    it('should throw error when assetId is missing', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_123',
        type: 'thumbnail.create',
        payload: {
          versionNumber: 1,
          // Missing assetId
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act & Assert
      await expect(handleThumbnailJob(job)).rejects.toThrow('JobDataMissing: Missing assetId or versionNumber.');
    });

    it('should throw error when versionNumber is missing', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_123',
        type: 'thumbnail.create',
        payload: {
          assetId: 'asset_456',
          // Missing versionNumber
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act & Assert
      await expect(handleThumbnailJob(job)).rejects.toThrow('JobDataMissing: Missing assetId or versionNumber.');
    });

  });
});

