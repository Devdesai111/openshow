// src/config/rankingWeights.ts

// --- Core Ranking DTO ---
export interface IRankingWeights {
  // Relevance (alpha - Text Match Score, typically from Search Engine)
  alpha: number;
  // Trust (beta - Verified status, Rating.avg, Completed projects)
  beta: number;
  // Recency (gamma - Last Active Date)
  gamma: number;
  // Activity (delta - Response Time, recent messages)
  delta: number;
  // Boost (epsilon - Manual Boosts/Sponsored)
  epsilon: number;
}

export interface IExperimentConfig {
  experimentId: string;
  weights: IRankingWeights;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Default Weights (Sum to 1.0 for normalized scoring)
export const DEFAULT_WEIGHTS: IRankingWeights = {
  alpha: 0.45, // Relevance
  beta: 0.25, // Trust
  gamma: 0.15, // Recency
  delta: 0.1, // Activity
  epsilon: 0.05, // Boost
};

// Mock Storage for current active weights/experiment config
// PRODUCTION: This would live in a secure, high-read performance config service (Redis/DB)
let currentExperiment: IExperimentConfig = {
  experimentId: 'default_v1',
  weights: DEFAULT_WEIGHTS,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Retrieves the currently active A/B experiment weights.
 * @param _experimentId - Optional experiment ID (for A/B variant selection, not yet implemented)
 * @returns Current ranking weights
 */
export function getCurrentRankingWeights(_experimentId?: string): IRankingWeights {
  // In a full A/B system, experimentId would map to a user ID or session cookie for variant checking
  return currentExperiment.weights;
}

/**
 * Validates and updates the active ranking weights (Admin-only).
 * @param newWeights - New ranking weights
 * @param experimentId - Experiment ID
 * @returns Updated experiment config
 * @throws {Error} - 'WeightValidationFailed'
 */
export function updateRankingWeights(newWeights: IRankingWeights, experimentId: string): IExperimentConfig {
  const sum = Object.values(newWeights).reduce((acc, val) => acc + val, 0);

  // Validation: ensure weights are non-negative and sum to a reasonable number (e.g., close to 1.0)
  if (sum < 0.99 || sum > 1.01 || Object.values(newWeights).some(v => v < 0)) {
    throw new Error('WeightValidationFailed');
  }

  currentExperiment = {
    experimentId: experimentId,
    weights: newWeights,
    isActive: true,
    createdAt: currentExperiment.experimentId === experimentId ? currentExperiment.createdAt : new Date(),
    updatedAt: new Date(),
  };

  return currentExperiment;
}

/**
 * Retrieves the current experiment config (for testing/admin purposes).
 * @internal This should only be used in tests or admin endpoints
 */
export function _getCurrentExperiment(): IExperimentConfig {
  return currentExperiment;
}

/**
 * Resets the current experiment to defaults (for testing purposes).
 * @internal This should only be used in tests
 */
export function _resetRankingWeights(): void {
  currentExperiment = {
    experimentId: 'default_v1',
    weights: DEFAULT_WEIGHTS,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

