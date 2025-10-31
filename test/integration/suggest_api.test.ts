import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';

describe('Search Suggestions API Integration Tests', () => {
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

  describe('GET /market/suggestions', () => {
    it('T43.1 - should return suggestions for basic query (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'ai', limit: 2 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('query', 'ai');
      expect(response.body).toHaveProperty('suggestions');
      expect(Array.isArray(response.body.suggestions)).toBe(true);
      expect(response.body.suggestions.length).toBeLessThanOrEqual(2);

      // Verify suggestions contain expected items
      const texts = response.body.suggestions.map((s: any) => s.text.toLowerCase());
      expect(texts.some((text: string) => text.includes('ai video editor'))).toBe(true);
      expect(texts.some((text: string) => text.includes('ai music composer'))).toBe(true);
    });

    it('T43.2 - should filter suggestions by type (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'p', type: 'project' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('query', 'p');
      expect(response.body).toHaveProperty('suggestions');
      expect(Array.isArray(response.body.suggestions)).toBe(true);

      // Verify all suggestions are projects
      response.body.suggestions.forEach((suggestion: any) => {
        expect(suggestion.type).toBe('project');
        expect(suggestion.text.toLowerCase()).toMatch(/^p/);
      });
    });

    it('T43.3 - should return 422 for missing q parameter', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ limit: 5 });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('T43.4 - should complete quickly (latency check)', async () => {
      const startTime = Date.now();

      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'prompt' });

      const endTime = Date.now();
      const latency = endTime - startTime;

      // Assert
      expect(response.status).toBe(200);
      // In a real scenario, we'd verify p95 < 50ms, but for testing we'll check it's reasonable
      expect(latency).toBeLessThan(1000); // Less than 1 second for test environment
    });

    it('should return suggestions sorted by score (descending)', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'prompt', limit: 10 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBeGreaterThan(0);

      // Verify suggestions are sorted by score (descending)
      const scores = response.body.suggestions.map((s: any) => s.score);
      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
      }
    });

    it('should return empty suggestions for no matches', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'xyz123nonexistent' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('query', 'xyz123nonexistent');
      expect(response.body).toHaveProperty('suggestions');
      expect(Array.isArray(response.body.suggestions)).toBe(true);
      expect(response.body.suggestions.length).toBe(0);
    });

    it('should respect limit parameter', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'a', limit: 3 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBeLessThanOrEqual(3);
    });

    it('should filter by creator type', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'dev', type: 'creator' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBeGreaterThan(0);
      response.body.suggestions.forEach((suggestion: any) => {
        expect(suggestion.type).toBe('creator');
      });
    });

    it('should filter by skill type', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'prompt', type: 'skill' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBeGreaterThan(0);
      response.body.suggestions.forEach((suggestion: any) => {
        expect(suggestion.type).toBe('skill');
      });
    });

    it('should return 422 for invalid type filter', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'test', type: 'invalid_type' });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for limit > 10', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'test', limit: 15 });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should work without authentication (public endpoint)', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'test' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('query');
      expect(response.body).toHaveProperty('suggestions');
    });

    it('should not return id for skill suggestions', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'prompt', type: 'skill' });

      // Assert
      expect(response.status).toBe(200);
      response.body.suggestions.forEach((suggestion: any) => {
        if (suggestion.type === 'skill') {
          expect(suggestion.id).toBeUndefined();
        }
      });
    });

    it('should return id for creator and project suggestions', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'dev', limit: 10 });

      // Assert
      expect(response.status).toBe(200);
      response.body.suggestions.forEach((suggestion: any) => {
        if (suggestion.type === 'creator' || suggestion.type === 'project') {
          expect(suggestion.id).toBeDefined();
        }
      });
    });

    it('should handle case-insensitive queries', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'PROMPT' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBeGreaterThan(0);
      // Should match "Prompt Engineer" and "PrompTech Innovations"
      const texts = response.body.suggestions.map((s: any) => s.text.toLowerCase());
      expect(texts.some((text: string) => text.includes('prompt'))).toBe(true);
    });

    it('should use default limit of 5 when limit is not provided', async () => {
      // Act
      const response = await request(app)
        .get('/market/suggestions')
        .query({ q: 'a' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.suggestions.length).toBeLessThanOrEqual(5);
    });
  });
});

