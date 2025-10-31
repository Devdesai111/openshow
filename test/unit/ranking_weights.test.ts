import {
  getCurrentRankingWeights,
  updateRankingWeights,
  DEFAULT_WEIGHTS,
  IRankingWeights,
  _resetRankingWeights,
} from '../../src/config/rankingWeights';

describe('Ranking Weights Utility', () => {
  beforeEach(() => {
    _resetRankingWeights();
  });

  describe('getCurrentRankingWeights', () => {
    it('should return default weights initially', () => {
      // Act
      const weights = getCurrentRankingWeights();

      // Assert
      expect(weights).toEqual(DEFAULT_WEIGHTS);
      expect(weights.alpha).toBe(0.45);
      expect(weights.beta).toBe(0.25);
      expect(weights.gamma).toBe(0.15);
      expect(weights.delta).toBe(0.1);
      expect(weights.epsilon).toBe(0.05);

      // Verify sum is approximately 1.0
      const sum = Object.values(weights).reduce((acc, val) => acc + val, 0);
      expect(sum).toBeCloseTo(1.0, 2);
    });
  });

  describe('updateRankingWeights', () => {
    it('T42.2 - should successfully update weights with valid sum', () => {
      // Arrange
      const newWeights: IRankingWeights = {
        alpha: 0.5,
        beta: 0.2,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const experimentId = 'test_experiment_1';

      // Act
      const updatedConfig = updateRankingWeights(newWeights, experimentId);

      // Assert
      expect(updatedConfig.experimentId).toBe(experimentId);
      expect(updatedConfig.weights).toEqual(newWeights);
      expect(updatedConfig.isActive).toBe(true);
      expect(updatedConfig.updatedAt).toBeInstanceOf(Date);

      // Verify weights are applied
      const currentWeights = getCurrentRankingWeights();
      expect(currentWeights).toEqual(newWeights);
    });

    it('T42.3 - should throw error when weights sum is invalid (< 0.99)', () => {
      // Arrange
      const invalidWeights: IRankingWeights = {
        alpha: 0.2,
        beta: 0.15,
        gamma: 0.1,
        delta: 0.05,
        epsilon: 0.05, // Sum = 0.55
      };

      // Act & Assert
      expect(() => {
        updateRankingWeights(invalidWeights, 'test_experiment');
      }).toThrow('WeightValidationFailed');
    });

    it('should throw error when weights sum is invalid (> 1.01)', () => {
      // Arrange
      const invalidWeights: IRankingWeights = {
        alpha: 0.5,
        beta: 0.3,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.1, // Sum = 1.15
      };

      // Act & Assert
      expect(() => {
        updateRankingWeights(invalidWeights, 'test_experiment');
      }).toThrow('WeightValidationFailed');
    });

    it('should throw error when weights contain negative values', () => {
      // Arrange
      const invalidWeights: IRankingWeights = {
        alpha: 0.5,
        beta: -0.2, // Negative value
        gamma: 0.2,
        delta: 0.3,
        epsilon: 0.2, // Sum = 1.0 but has negative
      };

      // Act & Assert
      expect(() => {
        updateRankingWeights(invalidWeights, 'test_experiment');
      }).toThrow('WeightValidationFailed');
    });

    it('should accept weights with sum exactly 1.0', () => {
      // Arrange
      const validWeights: IRankingWeights = {
        alpha: 0.4,
        beta: 0.3,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05, // Sum = 1.0
      };

      // Act
      const updatedConfig = updateRankingWeights(validWeights, 'test_experiment');

      // Assert
      expect(updatedConfig.weights).toEqual(validWeights);
    });

    it('should accept weights with sum close to 1.0 (0.99)', () => {
      // Arrange
      const validWeights: IRankingWeights = {
        alpha: 0.39,
        beta: 0.3,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05, // Sum = 0.99
      };

      // Act
      const updatedConfig = updateRankingWeights(validWeights, 'test_experiment');

      // Assert
      expect(updatedConfig.weights).toEqual(validWeights);
    });

    it('should accept weights with sum close to 1.0 (1.01)', () => {
      // Arrange
      const validWeights: IRankingWeights = {
        alpha: 0.41,
        beta: 0.3,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05, // Sum = 1.01
      };

      // Act
      const updatedConfig = updateRankingWeights(validWeights, 'test_experiment');

      // Assert
      expect(updatedConfig.weights).toEqual(validWeights);
    });

    it('should update updatedAt when weights change', async () => {
      // Arrange
      const initialWeights: IRankingWeights = {
        alpha: 0.5,
        beta: 0.2,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const firstUpdate = updateRankingWeights(initialWeights, 'experiment_1');
      const firstUpdatedAt = firstUpdate.updatedAt.getTime();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      // Act - Update again
      const secondWeights: IRankingWeights = {
        alpha: 0.4,
        beta: 0.3,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const secondUpdate = updateRankingWeights(secondWeights, 'experiment_1');
      const secondUpdatedAt = secondUpdate.updatedAt.getTime();

      // Assert
      expect(secondUpdatedAt).toBeGreaterThan(firstUpdatedAt);
    });

    it('should preserve createdAt when updating same experimentId', () => {
      // Arrange
      const weights1: IRankingWeights = {
        alpha: 0.5,
        beta: 0.2,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const firstUpdate = updateRankingWeights(weights1, 'same_experiment');
      const createdAt = firstUpdate.createdAt;

      // Act - Update same experiment
      const weights2: IRankingWeights = {
        alpha: 0.4,
        beta: 0.3,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const secondUpdate = updateRankingWeights(weights2, 'same_experiment');

      // Assert
      expect(secondUpdate.createdAt).toEqual(createdAt);
    });

    it('should update createdAt when using different experimentId', async () => {
      // Arrange
      const weights1: IRankingWeights = {
        alpha: 0.5,
        beta: 0.2,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const firstUpdate = updateRankingWeights(weights1, 'experiment_1');
      const createdAt1 = firstUpdate.createdAt;

      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      // Act - Update with different experiment ID
      const weights2: IRankingWeights = {
        alpha: 0.4,
        beta: 0.3,
        gamma: 0.15,
        delta: 0.1,
        epsilon: 0.05,
      };
      const secondUpdate = updateRankingWeights(weights2, 'experiment_2');

      // Assert
      expect(secondUpdate.createdAt.getTime()).toBeGreaterThan(createdAt1.getTime());
    });
  });
});

