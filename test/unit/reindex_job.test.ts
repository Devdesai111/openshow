import { handleReindexJob } from '../../src/jobs/handlers/reindexHandler';
import { DiscoveryService } from '../../src/services/discovery.service';
import { CreatorProfileModel } from '../../src/models/creatorProfile.model';
import { ProjectModel } from '../../src/models/project.model';
import { UserModel } from '../../src/models/user.model';
import { IJob } from '../../src/models/job.model';
import mongoose from 'mongoose';

describe('Reindex Job Handler Unit Tests', () => {
  let discoveryService: DiscoveryService;

  beforeAll(async () => {
    const testDbUri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/openshow-test';
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    await mongoose.connect(testDbUri);
    discoveryService = new DiscoveryService();
    // Clear mock index store before tests
    discoveryService._clearMockIndexStore();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await CreatorProfileModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await UserModel.deleteMany({});
    discoveryService._clearMockIndexStore();
  });

  describe('handleReindexJob', () => {
    it('T56.1 - should successfully process creator reindex job', async () => {
      // Arrange: Create a user and creator profile
      const user = await UserModel.create({
        email: 'creator@test.com',
        preferredName: 'Test Creator',
        role: 'creator',
        status: 'active',
      });

      const creatorProfile = await CreatorProfileModel.create({
        userId: user._id,
        skills: ['AI', 'Video Editing'],
        verified: true,
        availability: 'open',
      });

      const job: IJob = {
        jobId: 'job_123',
        type: 'reindex.batch',
        payload: {
          docType: 'creator',
          docIds: [creatorProfile._id!.toString()],
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act
      const result = await handleReindexJob(job);

      // Assert
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalIndexed', 1);

      // Verify document was indexed by checking mock store
      const indexStore = discoveryService._getMockIndexStore();
      const indexKey = `creator_${creatorProfile._id!.toString()}`;
      const indexedDoc = indexStore.get(indexKey);
      expect(indexedDoc).toBeDefined();
      expect(indexedDoc.title).toBe('Test Creator');
      expect(indexedDoc.skills).toEqual(['AI', 'Video Editing']);
      expect(indexedDoc.verified).toBe(true);
    });

    it('T56.1 - should successfully process project reindex job', async () => {
      // Arrange: Create a project
      const project = await ProjectModel.create({
        ownerId: new mongoose.Types.ObjectId(),
        title: 'Test Project',
        category: 'AI',
        status: 'active',
        visibility: 'public',
        collaborationType: 'open',
        roles: [],
        revenueSplits: [],
        milestones: [],
        teamMemberIds: [],
      });

      const job: IJob = {
        jobId: 'job_456',
        type: 'reindex.batch',
        payload: {
          docType: 'project',
          docIds: [project._id!.toString()],
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act
      const result = await handleReindexJob(job);

      // Assert
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalIndexed', 1);

      // Verify document was indexed
      const indexStore = discoveryService._getMockIndexStore();
      const indexKey = `project_${project._id!.toString()}`;
      const indexedDoc = indexStore.get(indexKey);
      expect(indexedDoc).toBeDefined();
      expect(indexedDoc.title).toBe('Test Project');
      expect(indexedDoc.category).toBe('AI');
      expect(indexedDoc.status).toBe('active');
    });

    it('T56.2 - should tolerate partial failures and continue batch', async () => {
      // Arrange: Create multiple creator profiles
      const user1 = await UserModel.create({
        email: 'creator1@test.com',
        preferredName: 'Creator 1',
        role: 'creator',
        status: 'active',
      });

      const user2 = await UserModel.create({
        email: 'creator2@test.com',
        preferredName: 'Creator 2',
        role: 'creator',
        status: 'active',
      });

      const creator1 = await CreatorProfileModel.create({
        userId: user1._id,
        skills: ['AI'],
        verified: true,
        availability: 'open',
      });

      const creator2 = await CreatorProfileModel.create({
        userId: user2._id,
        skills: ['Video'],
        verified: false,
        availability: 'busy',
      });

      // The handler creates its own DiscoveryService instance, so we can't easily mock it
      // Instead, we'll pre-index creator1 with an older document, then create a newer document
      // This should cause a StaleUpdate error when the handler tries to index with the older updatedAt
      
      // First, wait a bit to ensure creator1's updatedAt is older
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Pre-index creator1 with a future date to cause StaleUpdate when handler tries with current updatedAt
      await discoveryService.indexDocument({
        docType: 'creator',
        docId: creator1._id!.toString(),
        payload: { title: 'Creator 1', skills: [], verified: false, status: 'open' },
        updatedAt: new Date(Date.now() + 10000).toISOString(), // Future date
      });

      const job: IJob = {
        jobId: 'job_789',
        type: 'reindex.batch',
        payload: {
          docType: 'creator',
          docIds: [creator1._id!.toString(), creator2._id!.toString()],
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act
      const result = await handleReindexJob(job);

      // Assert: Should have indexed only creator2 (1 out of 2, creator1 failed with StaleUpdate)
      expect(result).toBeDefined();
      expect(result).toHaveProperty('totalIndexed', 1);

      // Verify creator2 was indexed
      const indexStore = discoveryService._getMockIndexStore();
      const indexKey2 = `creator_${creator2._id!.toString()}`;
      const indexedDoc2 = indexStore.get(indexKey2);
      expect(indexedDoc2).toBeDefined();
      expect(indexedDoc2.title).toBe('Creator 2');
    });

    it('T56.3 - should throw error for invalid docType', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_999',
        type: 'reindex.batch',
        payload: {
          docType: 'invalid',
          docIds: ['doc_123'],
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act & Assert
      await expect(handleReindexJob(job)).rejects.toThrow('InvalidDocType: invalid');
    });

    it('should throw error when docType is missing', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_888',
        type: 'reindex.batch',
        payload: {
          // Missing docType
          docIds: ['doc_123'],
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act & Assert
      await expect(handleReindexJob(job)).rejects.toThrow('JobDataMissing: Missing docType or docIds array.');
    });

    it('should throw error when docIds is missing', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_777',
        type: 'reindex.batch',
        payload: {
          docType: 'creator',
          // Missing docIds
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act & Assert
      await expect(handleReindexJob(job)).rejects.toThrow('JobDataMissing: Missing docType or docIds array.');
    });

    it('should handle empty docIds array gracefully', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_666',
        type: 'reindex.batch',
        payload: {
          docType: 'creator',
          docIds: [],
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 3,
        priority: 50,
        nextRunAt: new Date(),
      };

      // Act & Assert
      await expect(handleReindexJob(job)).rejects.toThrow('JobDataMissing: Missing docType or docIds array.');
    });
  });
});

