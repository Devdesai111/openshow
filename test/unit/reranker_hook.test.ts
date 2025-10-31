import { DiscoveryService } from '../../src/services/discovery.service';

describe('Re-ranker Hook Unit Tests', () => {
  let discoveryService: DiscoveryService;

  beforeEach(() => {
    discoveryService = new DiscoveryService();
  });

  describe('callReRanker', () => {
    it('T45.1 - should successfully re-rank results (200 OK)', async () => {
      // Arrange
      const input = {
        query: 'video editor',
        results: [
          { docId: 'creator_a', score: 0.85, features: { completion_rate: 0.8 } },
          { docId: 'creator_b', score: 0.75, features: { completion_rate: 0.7 } },
        ],
      };

      // Act
      const result = await discoveryService.callReRanker(input);

      // Assert
      expect(result).toHaveProperty('query', 'video editor');
      expect(result).toHaveProperty('rerankedResults');
      expect(Array.isArray(result.rerankedResults)).toBe(true);
      expect(result.rerankedResults.length).toBe(2);
      expect(result.rerankedResults[0]).toBeDefined();
      expect(result.rerankedResults[0]).toHaveProperty('docId');
      expect(result.rerankedResults[0]).toHaveProperty('finalScore');
      expect(typeof result.rerankedResults[0]!.finalScore).toBe('number');
    });

    it('T45.2 - should boost scores for high completion_rate (boost by ~0.1)', async () => {
      // Arrange
      const input = {
        query: 'video editor',
        results: [
          { docId: 'creator_a', score: 0.85, features: { completion_rate: 0.95 } }, // Should be boosted
          { docId: 'creator_b', score: 0.75, features: { completion_rate: 0.7 } }, // No boost
        ],
      };

      // Act
      const result = await discoveryService.callReRanker(input);

      // Assert
      const boostedDoc = result.rerankedResults.find(r => r.docId === 'creator_a');
      const normalDoc = result.rerankedResults.find(r => r.docId === 'creator_b');

      expect(boostedDoc).toBeDefined();
      expect(normalDoc).toBeDefined();

      // Boosted doc should have score increased by ~0.1 (but capped at 1.0)
      expect(boostedDoc!.finalScore).toBeGreaterThan(0.85);
      expect(boostedDoc!.finalScore).toBeCloseTo(0.95, 1); // 0.85 + 0.1 = 0.95

      // Normal doc should have original score
      expect(normalDoc!.finalScore).toBe(0.75);
    });

    it('should cap final scores at 1.0', async () => {
      // Arrange - High score that would exceed 1.0 after boost
      const input = {
        query: 'test query',
        results: [
          { docId: 'creator_a', score: 0.95, features: { completion_rate: 0.95 } }, // 0.95 + 0.1 = 1.05, should cap at 1.0
        ],
      };

      // Act
      const result = await discoveryService.callReRanker(input);

      // Assert
      expect(result.rerankedResults[0]).toBeDefined();
      expect(result.rerankedResults[0]!.finalScore).toBe(1.0);
      expect(result.rerankedResults[0]!.finalScore).toBeLessThanOrEqual(1.0);
    });

    it('should sort results by finalScore descending', async () => {
      // Arrange
      const input = {
        query: 'test query',
        results: [
          { docId: 'doc_1', score: 0.5, features: { completion_rate: 0.95 } }, // Will be boosted to ~0.6
          { docId: 'doc_2', score: 0.8, features: { completion_rate: 0.7 } }, // Stays at 0.8
          { docId: 'doc_3', score: 0.6, features: { completion_rate: 0.92 } }, // Will be boosted to ~0.7
        ],
      };

      // Act
      const result = await discoveryService.callReRanker(input);

      // Assert
      expect(result.rerankedResults.length).toBe(3);

      // Results should be sorted by finalScore DESC
      for (let i = 0; i < result.rerankedResults.length - 1; i++) {
        const current = result.rerankedResults[i];
        const next = result.rerankedResults[i + 1];
        if (current && next) {
          expect(current.finalScore).toBeGreaterThanOrEqual(next.finalScore);
        }
      }

      // Highest score should be first
      const first = result.rerankedResults[0];
      const second = result.rerankedResults[1];
      if (first && second) {
        expect(first.finalScore).toBeGreaterThanOrEqual(second.finalScore);
      }
    });

    it('should handle results without completion_rate feature', async () => {
      // Arrange
      const input = {
        query: 'test query',
        results: [
          { docId: 'doc_1', score: 0.8, features: {} }, // No completion_rate
          { docId: 'doc_2', score: 0.6, features: { other_feature: 0.5 } }, // Different feature
        ],
      };

      // Act
      const result = await discoveryService.callReRanker(input);

      // Assert
      expect(result.rerankedResults.length).toBe(2);
      expect(result.rerankedResults[0]).toBeDefined();
      expect(result.rerankedResults[1]).toBeDefined();
      expect(result.rerankedResults[0]!.finalScore).toBe(0.8); // Unchanged
      expect(result.rerankedResults[1]!.finalScore).toBe(0.6); // Unchanged
    });

    it('should preserve query in response', async () => {
      // Arrange
      const input = {
        query: 'preserve this query',
        results: [{ docId: 'doc_1', score: 0.8, features: {} }],
      };

      // Act
      const result = await discoveryService.callReRanker(input);

      // Assert
      expect(result.query).toBe('preserve this query');
    });

    it('should handle empty results array', async () => {
      // Arrange
      const input = {
        query: 'test query',
        results: [],
      };

      // Act
      const result = await discoveryService.callReRanker(input);

      // Assert
      expect(result.rerankedResults.length).toBe(0);
      expect(result.query).toBe('test query');
    });

    it('should only boost completion_rate > 0.9', async () => {
      // Arrange
      const input = {
        query: 'test query',
        results: [
          { docId: 'doc_1', score: 0.8, features: { completion_rate: 0.9 } }, // Exactly 0.9, no boost
          { docId: 'doc_2', score: 0.8, features: { completion_rate: 0.91 } }, // > 0.9, boosted
          { docId: 'doc_3', score: 0.8, features: { completion_rate: 0.89 } }, // < 0.9, no boost
        ],
      };

      // Act
      const result = await discoveryService.callReRanker(input);

      // Assert
      const doc1 = result.rerankedResults.find(r => r.docId === 'doc_1');
      const doc2 = result.rerankedResults.find(r => r.docId === 'doc_2');
      const doc3 = result.rerankedResults.find(r => r.docId === 'doc_3');

      expect(doc1!.finalScore).toBe(0.8); // No boost (exactly 0.9)
      expect(doc2!.finalScore).toBeGreaterThan(0.8); // Boosted (> 0.9)
      expect(doc3!.finalScore).toBe(0.8); // No boost (< 0.9)
    });
  });
});

