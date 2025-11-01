import { canonicalizeJson, computeLogHash } from '../../src/utils/hashChain.utility';
import { IAuditLog } from '../../src/models/auditLog.model';
import { Types } from 'mongoose';

describe('Hash Chain Utility Unit Tests', () => {
  describe('canonicalizeJson', () => {
    it('T60.4 - should produce identical hash for same data with different key order', () => {
      // Arrange: Two objects with same data, different key order
      const obj1 = { b: 2, a: 1, c: 3 };
      const obj2 = { c: 3, a: 1, b: 2 };

      // Act
      const canonical1 = canonicalizeJson(obj1);
      const canonical2 = canonicalizeJson(obj2);

      // Assert: Should be identical
      expect(canonical1).toBe(canonical2);
    });

    it('should handle nested objects', () => {
      // Arrange
      const obj1 = { a: { z: 1, y: 2 }, b: 3 };
      const obj2 = { b: 3, a: { y: 2, z: 1 } };

      // Act
      const canonical1 = canonicalizeJson(obj1);
      const canonical2 = canonicalizeJson(obj2);

      // Assert
      expect(canonical1).toBe(canonical2);
    });

    it('should handle arrays', () => {
      // Arrange
      const obj1 = { items: [1, 2, 3] };
      const obj2 = { items: [1, 2, 3] };

      // Act
      const canonical1 = canonicalizeJson(obj1);
      const canonical2 = canonicalizeJson(obj2);

      // Assert
      expect(canonical1).toBe(canonical2);
    });

    it('should handle null and undefined', () => {
      // Arrange
      const obj1 = { a: null, b: undefined };
      const obj2 = { b: undefined, a: null };

      // Act
      const canonical1 = canonicalizeJson(obj1);
      const canonical2 = canonicalizeJson(obj2);

      // Assert
      expect(canonical1).toBe(canonical2);
    });
  });

  describe('computeLogHash', () => {
    it('T60.1 - should create genesis hash with all-zero previous hash', () => {
      // Arrange: Genesis log (first log ever)
      const logData: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'> = {
        auditId: 'audit_genesis',
        resourceType: 'system',
        action: 'system.initialized',
        timestamp: new Date('2025-01-01T00:00:00Z'),
        details: { message: 'System initialized' },
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      // Act
      const hash = computeLogHash(logData, '0000000000000000000000000000000000000000000000000000000000000000');

      // Assert: Should be a valid SHA256 hash (64 hex characters)
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).not.toBe('0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('T60.2 - should create chained hash using previous log hash', () => {
      // Arrange: First log
      const logData1: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'> = {
        auditId: 'audit_001',
        resourceType: 'user',
        action: 'user.created',
        timestamp: new Date('2025-01-01T00:00:00Z'),
        details: { userId: 'user_123' },
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const hash1 = computeLogHash(logData1, '0000000000000000000000000000000000000000000000000000000000000000');

      // Arrange: Second log (chained to first)
      const logData2: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'> = {
        auditId: 'audit_002',
        resourceType: 'user',
        action: 'user.updated',
        timestamp: new Date('2025-01-01T01:00:00Z'),
        details: { userId: 'user_123', changes: { name: 'John' } },
        previousHash: hash1, // Chain to previous log
      };

      // Act
      const hash2 = computeLogHash(logData2, hash1);

      // Assert: Hash2 should be different from hash1
      expect(hash2).toMatch(/^[a-f0-9]{64}$/);
      expect(hash2).not.toBe(hash1);
      expect(hash2).not.toBe('0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('should produce different hashes for different data with same previous hash', () => {
      // Arrange: Two logs with same previous hash but different data
      const previousHash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

      const logData1: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'> = {
        auditId: 'audit_001',
        resourceType: 'user',
        action: 'user.created',
        timestamp: new Date('2025-01-01T00:00:00Z'),
        details: { userId: 'user_123' },
        previousHash,
      };

      const logData2: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'> = {
        auditId: 'audit_002',
        resourceType: 'user',
        action: 'user.deleted',
        timestamp: new Date('2025-01-01T00:00:00Z'),
        details: { userId: 'user_456' },
        previousHash,
      };

      // Act
      const hash1 = computeLogHash(logData1, previousHash);
      const hash2 = computeLogHash(logData2, previousHash);

      // Assert: Should be different
      expect(hash1).not.toBe(hash2);
    });

    it('should include ObjectId conversion in hash', () => {
      // Arrange: Log with ObjectIds
      const userId = new Types.ObjectId();
      const resourceId = new Types.ObjectId();

      const logData: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'> = {
        auditId: 'audit_001',
        resourceType: 'user',
        resourceId,
        action: 'user.updated',
        actorId: userId,
        timestamp: new Date('2025-01-01T00:00:00Z'),
        details: {},
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      // Act
      const hash = computeLogHash(logData, logData.previousHash);

      // Assert: Should produce valid hash
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});

