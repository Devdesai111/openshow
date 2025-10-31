import { DiscoveryService } from '../../src/services/discovery.service';
import mongoose from 'mongoose';

describe('Indexing Logic Unit Tests', () => {
  let discoveryService: DiscoveryService;

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

  beforeEach(() => {
    discoveryService = new DiscoveryService();
    discoveryService._clearMockIndexStore();
  });

  describe('indexDocument', () => {
    it('T41.1 - should successfully index a new document', async () => {
      // Arrange
      const docId = new mongoose.Types.ObjectId().toString();
      const updatedAt = new Date().toISOString();
      const payload = {
        headline: 'AI Video Editor (Freelance)',
        skills: ['video-editing', 'prompt-engineering'],
      };

      // Act
      await discoveryService.indexDocument({
        docType: 'creator',
        docId,
        payload,
        updatedAt,
      });

      // Assert
      const mockStore = discoveryService._getMockIndexStore();
      const indexKey = `creator_${docId}`;
      const storedDoc = mockStore.get(indexKey);

      expect(storedDoc).toBeDefined();
      expect(storedDoc.docId).toBe(docId);
      expect(storedDoc.docType).toBe('creator');
      expect(storedDoc.headline).toBe(payload.headline);
      expect(storedDoc.skills).toEqual(payload.skills);
      expect(storedDoc.updatedAt).toBe(updatedAt);
    });

    it('T41.3 - should reject stale update (out-of-order)', async () => {
      // Arrange - Index a document first
      const docId = new mongoose.Types.ObjectId().toString();
      const firstUpdate = new Date().toISOString();
      const secondUpdate = new Date(Date.now() - 10000).toISOString(); // Older timestamp

      await discoveryService.indexDocument({
        docType: 'creator',
        docId,
        payload: { headline: 'First Update' },
        updatedAt: firstUpdate,
      });

      // Act & Assert - Try to update with older timestamp
      await expect(
        discoveryService.indexDocument({
          docType: 'creator',
          docId,
          payload: { headline: 'Second Update (Stale)' },
          updatedAt: secondUpdate,
        })
      ).rejects.toThrow('StaleUpdate');

      // Verify the document was NOT updated
      const mockStore = discoveryService._getMockIndexStore();
      const indexKey = `creator_${docId}`;
      const storedDoc = mockStore.get(indexKey);

      expect(storedDoc.headline).toBe('First Update'); // Should remain unchanged
      expect(storedDoc.updatedAt).toBe(firstUpdate);
    });

    it('should accept update with newer timestamp', async () => {
      // Arrange - Index a document first
      const docId = new mongoose.Types.ObjectId().toString();
      const firstUpdate = new Date(Date.now() - 10000).toISOString(); // Older timestamp
      const secondUpdate = new Date().toISOString(); // Newer timestamp

      await discoveryService.indexDocument({
        docType: 'creator',
        docId,
        payload: { headline: 'First Update' },
        updatedAt: firstUpdate,
      });

      // Act - Update with newer timestamp
      await discoveryService.indexDocument({
        docType: 'creator',
        docId,
        payload: { headline: 'Second Update (Newer)', skills: ['new-skill'] },
        updatedAt: secondUpdate,
      });

      // Assert - Verify the document was updated
      const mockStore = discoveryService._getMockIndexStore();
      const indexKey = `creator_${docId}`;
      const storedDoc = mockStore.get(indexKey);

      expect(storedDoc.headline).toBe('Second Update (Newer)');
      expect(storedDoc.skills).toEqual(['new-skill']);
      expect(storedDoc.updatedAt).toBe(secondUpdate);
    });

    it('should merge payload with existing document', async () => {
      // Arrange - Index a document first
      const docId = new mongoose.Types.ObjectId().toString();
      const firstUpdate = new Date().toISOString();
      const secondUpdate = new Date(Date.now() + 1000).toISOString();

      await discoveryService.indexDocument({
        docType: 'project',
        docId,
        payload: { title: 'Original Title', category: 'Film' },
        updatedAt: firstUpdate,
      });

      // Act - Update with partial payload
      await discoveryService.indexDocument({
        docType: 'project',
        docId,
        payload: { status: 'active' }, // Only updating status
        updatedAt: secondUpdate,
      });

      // Assert - Verify fields are merged
      const mockStore = discoveryService._getMockIndexStore();
      const indexKey = `project_${docId}`;
      const storedDoc = mockStore.get(indexKey);

      expect(storedDoc.title).toBe('Original Title'); // Preserved
      expect(storedDoc.category).toBe('Film'); // Preserved
      expect(storedDoc.status).toBe('active'); // New field added
      expect(storedDoc.updatedAt).toBe(secondUpdate);
    });

    it('should handle project document type', async () => {
      // Arrange
      const docId = new mongoose.Types.ObjectId().toString();
      const updatedAt = new Date().toISOString();
      const payload = {
        title: 'Test Project',
        category: 'Film Production',
        status: 'active',
      };

      // Act
      await discoveryService.indexDocument({
        docType: 'project',
        docId,
        payload,
        updatedAt,
      });

      // Assert
      const mockStore = discoveryService._getMockIndexStore();
      const indexKey = `project_${docId}`;
      const storedDoc = mockStore.get(indexKey);

      expect(storedDoc).toBeDefined();
      expect(storedDoc.docId).toBe(docId);
      expect(storedDoc.docType).toBe('project');
      expect(storedDoc.title).toBe(payload.title);
      expect(storedDoc.category).toBe(payload.category);
      expect(storedDoc.status).toBe(payload.status);
    });

    it('should handle same timestamp (reject)', async () => {
      // Arrange - Index a document first
      const docId = new mongoose.Types.ObjectId().toString();
      const sameTimestamp = new Date().toISOString();

      await discoveryService.indexDocument({
        docType: 'creator',
        docId,
        payload: { headline: 'First Update' },
        updatedAt: sameTimestamp,
      });

      // Act & Assert - Try to update with same timestamp
      await expect(
        discoveryService.indexDocument({
          docType: 'creator',
          docId,
          payload: { headline: 'Duplicate Update' },
          updatedAt: sameTimestamp,
        })
      ).rejects.toThrow('StaleUpdate');
    });
  });
});
