import { computeCanonicalHash } from '../../src/services/agreement.service';
import { IAgreement } from '../../src/models/agreement.model';
import { Types } from 'mongoose';

describe('Canonical Hash Computation Unit Tests', () => {
  const baseAgreement: IAgreement = {
    _id: new Types.ObjectId(),
    agreementId: 'ag_test123',
    projectId: new Types.ObjectId(),
    createdBy: new Types.ObjectId(),
    title: 'Test Agreement',
    payloadJson: {
      title: 'Test Agreement',
      licenseType: 'Non-Exclusive (royalty-based)',
      terms: 'Test terms',
      splits: [{ percentage: 100 }],
    },
    status: 'signed',
    signers: [
      {
        signerId: new Types.ObjectId(),
        email: 'signer1@example.com',
        signed: true,
        signedAt: new Date('2024-01-01T10:00:00Z'),
        signatureMethod: 'typed',
      },
      {
        signerId: new Types.ObjectId(),
        email: 'signer2@example.com',
        signed: true,
        signedAt: new Date('2024-01-01T11:00:00Z'),
        signatureMethod: 'typed',
      },
    ],
    signOrderEnforced: false,
    version: 1,
    immutableHash: undefined,
    createdAt: new Date('2024-01-01T09:00:00Z'),
    updatedAt: new Date('2024-01-01T11:00:00Z'),
  };

  it('T28.4 - should produce identical hash for same data with different key orders', () => {
    // Arrange - Create two agreements with same data but different key orders in payloadJson
    const agreement1: IAgreement = {
      ...baseAgreement,
      payloadJson: {
        title: 'Test Agreement',
        licenseType: 'Non-Exclusive (royalty-based)',
        terms: 'Test terms',
        splits: [{ percentage: 100 }],
      },
    };

    // Different key order in payloadJson
    const agreement2: IAgreement = {
      ...baseAgreement,
      payloadJson: {
        splits: [{ percentage: 100 }],
        title: 'Test Agreement',
        terms: 'Test terms',
        licenseType: 'Non-Exclusive (royalty-based)',
      } as any,
    };

    // Act
    const hash1 = computeCanonicalHash(agreement1);
    const hash2 = computeCanonicalHash(agreement2);

    // Assert
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^sha256:[a-f0-9]{64}$/); // SHA256 hash format
  });

  it('should produce different hash for different payload content', () => {
    // Arrange - Same structure, different content
    const agreement1: IAgreement = {
      ...baseAgreement,
      payloadJson: {
        title: 'Test Agreement',
        licenseType: 'Non-Exclusive (royalty-based)',
        terms: 'Test terms',
        splits: [{ percentage: 100 }],
      },
    };

    const agreement2: IAgreement = {
      ...baseAgreement,
      payloadJson: {
        title: 'Different Agreement',
        licenseType: 'Exclusive Ownership',
        terms: 'Different terms',
        splits: [{ percentage: 50 }, { percentage: 50 }],
      },
    };

    // Act
    const hash1 = computeCanonicalHash(agreement1);
    const hash2 = computeCanonicalHash(agreement2);

    // Assert
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hash for different signers', () => {
    // Arrange - Same payload, different signers
    const agreement1: IAgreement = {
      ...baseAgreement,
      signers: [
        {
          signerId: new Types.ObjectId(),
          email: 'signer1@example.com',
          signed: true,
          signedAt: new Date('2024-01-01T10:00:00Z'),
          signatureMethod: 'typed',
        },
      ],
    };

    const agreement2: IAgreement = {
      ...baseAgreement,
      signers: [
        {
          signerId: new Types.ObjectId(),
          email: 'signer2@example.com',
          signed: true,
          signedAt: new Date('2024-01-01T10:00:00Z'),
          signatureMethod: 'typed',
        },
      ],
    };

    // Act
    const hash1 = computeCanonicalHash(agreement1);
    const hash2 = computeCanonicalHash(agreement2);

    // Assert
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hash for different signature times', () => {
    // Arrange - Same data, different signedAt
    const agreement1: IAgreement = {
      ...baseAgreement,
      signers: [
        {
          signerId: new Types.ObjectId(),
          email: 'signer1@example.com',
          signed: true,
          signedAt: new Date('2024-01-01T10:00:00Z'),
          signatureMethod: 'typed',
        },
      ],
    };

    const agreement2: IAgreement = {
      ...baseAgreement,
      signers: [
        {
          signerId: agreement1.signers[0]?.signerId,
          email: 'signer1@example.com',
          signed: true,
          signedAt: new Date('2024-01-01T11:00:00Z'), // Different time
          signatureMethod: 'typed',
        },
      ],
    };

    // Act
    const hash1 = computeCanonicalHash(agreement1);
    const hash2 = computeCanonicalHash(agreement2);

    // Assert
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hash for different agreement versions', () => {
    // Arrange - Same data, different version
    const agreement1: IAgreement = {
      ...baseAgreement,
      version: 1,
    };

    const agreement2: IAgreement = {
      ...baseAgreement,
      version: 2,
    };

    // Act
    const hash1 = computeCanonicalHash(agreement1);
    const hash2 = computeCanonicalHash(agreement2);

    // Assert
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hash for different agreement IDs', () => {
    // Arrange - Same data, different agreementId
    const agreement1: IAgreement = {
      ...baseAgreement,
      agreementId: 'ag_test123',
    };

    const agreement2: IAgreement = {
      ...baseAgreement,
      agreementId: 'ag_test456',
    };

    // Act
    const hash1 = computeCanonicalHash(agreement1);
    const hash2 = computeCanonicalHash(agreement2);

    // Assert
    expect(hash1).not.toBe(hash2);
  });

  it('should handle complex nested objects correctly', () => {
    // Arrange - Complex nested payload
    const agreement: IAgreement = {
      ...baseAgreement,
      payloadJson: {
        title: 'Complex Agreement',
        licenseType: 'Non-Exclusive (royalty-based)',
        terms: 'Complex terms with multiple clauses',
        splits: [
          { userId: 'user1', percentage: 60 },
          { placeholder: 'Director', percentage: 40 },
        ],
        metadata: {
          projectId: 'project123',
          createdAt: '2024-01-01T09:00:00Z',
        },
      } as any,
    };

    // Act
    const hash = computeCanonicalHash(agreement);

    // Assert
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(typeof hash).toBe('string');
    expect(hash.startsWith('sha256:')).toBe(true);
  });

  it('should handle signers with missing optional fields', () => {
    // Arrange - Signer without signedAt
    const agreement: IAgreement = {
      ...baseAgreement,
      signers: [
        {
          email: 'signer1@example.com',
          signed: true,
          signatureMethod: 'typed',
          // Missing signedAt
        },
      ],
    };

    // Act
    const hash = computeCanonicalHash(agreement);

    // Assert
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

