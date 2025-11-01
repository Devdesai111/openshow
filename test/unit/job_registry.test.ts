import { validateJobPayload, getJobPolicy } from '../../src/jobs/jobRegistry';

describe('Job Registry Unit Tests', () => {
  describe('validateJobPayload', () => {
    it('T53.1 - should validate valid payload for thumbnail.create', () => {
      // Arrange
      const payload = {
        assetId: 'asset_123',
        versionNumber: 1,
        sizes: ['small', 'medium', 'large'],
      };

      // Act & Assert (should not throw)
      expect(() => validateJobPayload('thumbnail.create', payload)).not.toThrow();
    });

    it('T53.2 - should throw SchemaValidationFailed for missing required field', () => {
      // Arrange
      const payload = {
        versionNumber: 1,
        // Missing assetId
      };

      // Act & Assert
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('SchemaValidationFailed');
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('Missing required field: assetId');
    });

    it('should throw SchemaValidationFailed for missing multiple required fields', () => {
      // Arrange
      const payload = {
        // Missing both assetId and versionNumber
        sizes: ['small'],
      };

      // Act & Assert
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('SchemaValidationFailed');
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('Missing required field: assetId');
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('Missing required field: versionNumber');
    });

    it('T53.3 - should throw JobTypeNotFound for unknown job type', () => {
      // Arrange
      const payload = { assetId: 'asset_123' };

      // Act & Assert
      expect(() => validateJobPayload('unknown.job', payload)).toThrow('JobTypeNotFound');
    });

    it('should throw SchemaValidationFailed for invalid type (string instead of number)', () => {
      // Arrange
      const payload = {
        assetId: 'asset_123',
        versionNumber: '1', // Should be number, not string
      };

      // Act & Assert
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('SchemaValidationFailed');
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('Invalid type for field versionNumber');
    });

    it('should throw SchemaValidationFailed for invalid type (number instead of string)', () => {
      // Arrange
      const payload = {
        assetId: 123, // Should be string, not number
        versionNumber: 1,
      };

      // Act & Assert
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('SchemaValidationFailed');
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('Invalid type for field assetId');
    });

    it('should throw SchemaValidationFailed for invalid type (object instead of array)', () => {
      // Arrange
      const payload = {
        assetId: 'asset_123',
        versionNumber: 1,
        sizes: { small: true }, // Should be array, not object
      };

      // Act & Assert
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('SchemaValidationFailed');
      expect(() => validateJobPayload('thumbnail.create', payload)).toThrow('Invalid type for field sizes');
    });

    it('should validate valid payload for payout.execute', () => {
      // Arrange
      const payload = {
        batchId: 'batch_123',
        escrowId: 'escrow_456',
        isRetry: false,
      };

      // Act & Assert (should not throw)
      expect(() => validateJobPayload('payout.execute', payload)).not.toThrow();
    });

    it('should validate payout.execute without optional isRetry field', () => {
      // Arrange
      const payload = {
        batchId: 'batch_123',
        escrowId: 'escrow_456',
        // isRetry is optional
      };

      // Act & Assert (should not throw)
      expect(() => validateJobPayload('payout.execute', payload)).not.toThrow();
    });

    it('should throw SchemaValidationFailed for payout.execute with invalid boolean', () => {
      // Arrange
      const payload = {
        batchId: 'batch_123',
        escrowId: 'escrow_456',
        isRetry: 'true', // Should be boolean, not string
      };

      // Act & Assert
      expect(() => validateJobPayload('payout.execute', payload)).toThrow('SchemaValidationFailed');
      expect(() => validateJobPayload('payout.execute', payload)).toThrow('Invalid type for field isRetry');
    });
  });

  describe('getJobPolicy', () => {
    it('T53.4 - should return correct policy for thumbnail.create', () => {
      // Act
      const policy = getJobPolicy('thumbnail.create');

      // Assert
      expect(policy).toBeDefined();
      expect(policy.type).toBe('thumbnail.create');
      expect(policy.maxAttempts).toBe(3);
      expect(policy.timeoutSeconds).toBe(300); // 5 minutes
    });

    it('should return correct policy for payout.execute', () => {
      // Act
      const policy = getJobPolicy('payout.execute');

      // Assert
      expect(policy).toBeDefined();
      expect(policy.type).toBe('payout.execute');
      expect(policy.maxAttempts).toBe(10);
      expect(policy.timeoutSeconds).toBe(60); // 1 minute
      expect(policy.concurrencyLimit).toBe(5);
    });

    it('should throw JobTypeNotFound for unknown job type', () => {
      // Act & Assert
      expect(() => getJobPolicy('unknown.job')).toThrow('JobTypeNotFound');
    });
  });
});

