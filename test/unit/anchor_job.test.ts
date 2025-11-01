import { handleAnchorJob } from '../../src/jobs/handlers/anchorHandler';
import { IJob } from '../../src/models/job.model';
import { AgreementModel } from '../../src/models/agreement.model';
import mongoose from 'mongoose';

describe('Anchor Job Handler Unit Tests', () => {
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
    await AgreementModel.deleteMany({});
  });

  describe('handleAnchorJob', () => {
    it('T57.1 - should successfully process anchor job and update agreement', async () => {
      // Arrange: Create an agreement
      const agreement = await AgreementModel.create({
        agreementId: 'ag_test123',
        projectId: new mongoose.Types.ObjectId(),
        createdBy: new mongoose.Types.ObjectId(),
        title: 'Test Agreement',
        payloadJson: {
          title: 'Test Agreement',
          terms: 'Test terms',
          licenseType: 'Non-Exclusive (royalty-based)',
          splits: [],
        },
        status: 'signed',
        signers: [],
        signOrderEnforced: false,
        version: 1,
        immutableHash: 'sha256:abc123def456',
      });

      const job: IJob = {
        jobId: 'job_123',
        type: 'blockchain.anchor',
        payload: {
          agreementId: agreement._id.toString(),
          immutableHash: 'sha256:abc123def456',
          chain: 'polygon',
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 10,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act
      const result = await handleAnchorJob(job);

      // Assert
      expect(result).toBeDefined();
      expect(result).toHaveProperty('txId');
      expect(result).toHaveProperty('chain', 'polygon');
      expect(result.txId).toMatch(/^0x[0-9a-f]{64}$/); // Valid hex transaction ID (32 bytes = 64 hex chars)

      // Verify agreement was updated with blockchain anchor
      const updatedAgreement = await AgreementModel.findById(agreement._id);
      expect(updatedAgreement).toBeDefined();
      expect(updatedAgreement!.blockchainAnchors).toBeDefined();
      expect(updatedAgreement!.blockchainAnchors!.length).toBe(1);
      expect(updatedAgreement!.blockchainAnchors![0]).toBeDefined();
      expect(updatedAgreement!.blockchainAnchors![0]!.txId).toBe(result.txId);
      expect(updatedAgreement!.blockchainAnchors![0]!.chain).toBe('polygon');
      expect(updatedAgreement!.blockchainAnchors![0]!.createdAt).toBeDefined();
    });

    it('T57.2 - should throw error when external chain service fails', async () => {
      // Arrange: Create an agreement
      const agreement = await AgreementModel.create({
        agreementId: 'ag_test456',
        projectId: new mongoose.Types.ObjectId(),
        createdBy: new mongoose.Types.ObjectId(),
        title: 'Test Agreement',
        payloadJson: {
          title: 'Test Agreement',
          terms: 'Test terms',
        },
        status: 'signed',
        signers: [],
        signOrderEnforced: false,
        version: 1,
        immutableHash: 'sha256:abc123def456',
      });

      const job: IJob = {
        jobId: 'job_456',
        type: 'blockchain.anchor',
        payload: {
          agreementId: agreement._id.toString(),
          immutableHash: 'sha256:abc123def456',
          chain: 'fail_test', // This will cause ChainNetworkBusy error
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 10,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act & Assert: Should throw error when chain gateway fails
      await expect(handleAnchorJob(job)).rejects.toThrow('ChainNetworkBusy');
    });

    it('T57.3 - should verify job registry policy', async () => {
      // This test verifies the policy is correctly configured
      const { getJobPolicy } = require('../../src/jobs/jobRegistry');
      const policy = getJobPolicy('blockchain.anchor');
      
      expect(policy).toBeDefined();
      expect(policy.maxAttempts).toBe(10);
      expect(policy.timeoutSeconds).toBe(1800);
    });

    it('should throw error when agreementId is missing', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_123',
        type: 'blockchain.anchor',
        payload: {
          // Missing agreementId
          immutableHash: 'sha256:abc123def456',
          chain: 'polygon',
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 10,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act & Assert
      await expect(handleAnchorJob(job)).rejects.toThrow('JobDataMissing: Missing agreementId, immutableHash, or chain.');
    });

    it('should throw error when immutableHash is missing', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_123',
        type: 'blockchain.anchor',
        payload: {
          agreementId: 'ag_123',
          // Missing immutableHash
          chain: 'polygon',
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 10,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act & Assert
      await expect(handleAnchorJob(job)).rejects.toThrow('JobDataMissing: Missing agreementId, immutableHash, or chain.');
    });

    it('should throw error when chain is missing', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_123',
        type: 'blockchain.anchor',
        payload: {
          agreementId: 'ag_123',
          immutableHash: 'sha256:abc123def456',
          // Missing chain
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 10,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act & Assert
      await expect(handleAnchorJob(job)).rejects.toThrow('JobDataMissing: Missing agreementId, immutableHash, or chain.');
    });

    it('should throw error when agreement is not found', async () => {
      // Arrange: Non-existent agreement ID
      const job: IJob = {
        jobId: 'job_123',
        type: 'blockchain.anchor',
        payload: {
          agreementId: new mongoose.Types.ObjectId().toString(), // Non-existent ID
          immutableHash: 'sha256:abc123def456',
          chain: 'polygon',
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 10,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act & Assert: Should throw error because agreement doesn't exist
      await expect(handleAnchorJob(job)).rejects.toThrow('AgreementNotFound');
    });

    it('should append multiple blockchain anchors', async () => {
      // Arrange: Create an agreement with one anchor already
      const agreement = await AgreementModel.create({
        agreementId: 'ag_test789',
        projectId: new mongoose.Types.ObjectId(),
        createdBy: new mongoose.Types.ObjectId(),
        title: 'Test Agreement',
        payloadJson: {
          title: 'Test Agreement',
          terms: 'Test terms',
        },
        status: 'signed',
        signers: [],
        signOrderEnforced: false,
        version: 1,
        immutableHash: 'sha256:abc123def456',
        blockchainAnchors: [{
          txId: '0x1111111111111111111111111111111111111111111111111111111111111111',
          chain: 'polygon',
          createdAt: new Date(),
        }],
      });

      const job: IJob = {
        jobId: 'job_789',
        type: 'blockchain.anchor',
        payload: {
          agreementId: agreement._id.toString(),
          immutableHash: 'sha256:abc123def456',
          chain: 'ipfs', // Different chain
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 10,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act
      const result = await handleAnchorJob(job);

      // Assert: Should have 2 anchors now
      const updatedAgreement = await AgreementModel.findById(agreement._id);
      expect(updatedAgreement).toBeDefined();
      expect(updatedAgreement!.blockchainAnchors).toBeDefined();
      expect(updatedAgreement!.blockchainAnchors!.length).toBe(2);
      expect(updatedAgreement!.blockchainAnchors![1]).toBeDefined();
      expect(updatedAgreement!.blockchainAnchors![1]!.txId).toBe(result.txId);
      expect(updatedAgreement!.blockchainAnchors![1]!.chain).toBe('ipfs');
    });
  });
});

