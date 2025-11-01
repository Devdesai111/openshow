import { handlePdfRenderJob } from '../../src/jobs/handlers/pdfRenderHandler';
import { IJob } from '../../src/models/job.model';
import { AgreementModel } from '../../src/models/agreement.model';
import { AssetModel } from '../../src/models/asset.model';
import mongoose from 'mongoose';

describe('PDF Render Job Handler Unit Tests', () => {
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
    await AssetModel.deleteMany({});
  });

  describe('handlePdfRenderJob', () => {
    it('T55.1 - should successfully process PDF job and create asset', async () => {
      // Arrange: Create a signed agreement
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
      });

      const job: IJob = {
        jobId: 'job_123',
        type: 'pdf.generate',
        payload: {
          agreementId: agreement._id.toString(),
          payloadJson: {
            title: 'Test Agreement',
            terms: 'Test terms',
          },
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 5,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act
      const result = await handlePdfRenderJob(job);

      // Assert
      expect(result).toBeDefined();
      expect(result).toHaveProperty('pdfAssetId');
      expect(typeof result.pdfAssetId).toBe('string');
      expect(result.pdfAssetId).toMatch(/^[0-9a-fA-F]{24}$/); // Valid ObjectId

      // Verify PDF asset was created
      const pdfAsset = await AssetModel.findById(result.pdfAssetId);
      expect(pdfAsset).toBeDefined();
      expect(pdfAsset!.filename).toContain('Agreement');
      expect(pdfAsset!.mimeType).toBe('application/pdf');
      expect(pdfAsset!.processed).toBe(true);
    });

    it('T55.2 - should call updatePdfAssetId on agreement service', async () => {
      // Arrange: Create a signed agreement
      const agreement = await AgreementModel.create({
        agreementId: 'ag_test456',
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
      });

      const job: IJob = {
        jobId: 'job_123',
        type: 'pdf.generate',
        payload: {
          agreementId: agreement._id.toString(),
          payloadJson: {
            title: 'Test Agreement',
            terms: 'Test terms',
          },
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 5,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act
      const result = await handlePdfRenderJob(job);

      // Assert: Verify agreement was updated with pdfAssetId
      const updatedAgreement = await AgreementModel.findById(agreement._id);
      expect(updatedAgreement).toBeDefined();
      expect(updatedAgreement!.pdfAssetId).toBeDefined();
      expect(updatedAgreement!.pdfAssetId!.toString()).toBe(result.pdfAssetId);
    });

    it('T55.3 - should throw error when agreement is not signed', async () => {
      // Arrange: Create an agreement that is NOT signed
      const agreement = await AgreementModel.create({
        agreementId: 'ag_test789',
        projectId: new mongoose.Types.ObjectId(),
        createdBy: new mongoose.Types.ObjectId(),
        title: 'Test Agreement',
        payloadJson: {
          title: 'Test Agreement',
          terms: 'Test terms',
        },
        status: 'pending_signatures', // Not signed
        signers: [],
        signOrderEnforced: false,
        version: 1,
      });

      const job: IJob = {
        jobId: 'job_123',
        type: 'pdf.generate',
        payload: {
          agreementId: agreement._id.toString(),
          payloadJson: {
            title: 'Test Agreement',
            terms: 'Test terms',
          },
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 5,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act & Assert: Should throw error because agreement is not signed
      await expect(handlePdfRenderJob(job)).rejects.toThrow('AgreementNotSignedOrNotFound');
    });

    it('should throw error when agreementId is missing', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_123',
        type: 'pdf.generate',
        payload: {
          // Missing agreementId
          payloadJson: {
            title: 'Test Agreement',
          },
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 5,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act & Assert
      await expect(handlePdfRenderJob(job)).rejects.toThrow('JobDataMissing: Missing agreementId or payloadJson.');
    });

    it('should throw error when payloadJson is missing', async () => {
      // Arrange
      const job: IJob = {
        jobId: 'job_123',
        type: 'pdf.generate',
        payload: {
          agreementId: 'ag_123',
          // Missing payloadJson
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 5,
        priority: 50,
        nextRunAt: new Date(),
        createdBy: new mongoose.Types.ObjectId(),
      };

      // Act & Assert
      await expect(handlePdfRenderJob(job)).rejects.toThrow('JobDataMissing: Missing agreementId or payloadJson.');
    });

    it('should throw error when createdBy is missing', async () => {
      // Arrange: Create a signed agreement
      const agreement = await AgreementModel.create({
        agreementId: 'ag_test999',
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
      });

      const job: IJob = {
        jobId: 'job_123',
        type: 'pdf.generate',
        payload: {
          agreementId: agreement._id.toString(),
          payloadJson: {
            title: 'Test Agreement',
          },
        },
        status: 'leased',
        attempt: 1,
        maxAttempts: 5,
        priority: 50,
        nextRunAt: new Date(),
        // Missing createdBy
      };

      // Act & Assert
      await expect(handlePdfRenderJob(job)).rejects.toThrow('JobDataMissing: Missing createdBy (uploaderId).');
    });
  });
});

