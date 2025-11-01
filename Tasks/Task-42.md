Following the structured plan, we proceed with **Task 42: Search Relevance Tuning & A/B Setup**.

This task establishes the configurable foundation for the search engine's ranking algorithm, which is essential for maximizing conversion (hires/project applications). We focus on modeling the scoring logic rather than implementing complex ML, adhering to the plan's specification of weighted components.

***

## **Task 42: Search Relevance Tuning & A/B Setup**

**Goal:** Define the ranking algorithm model and implement a central utility to manage the configurable weights (e.g., for A/B testing) that determine the final search score (blended ranking).

**Service:** `Marketplace / Discovery / Search API`
**Phase:** I - Search, Ranking, Advanced features & ML hooks
**Dependencies:** Task 41 (Discovery Service structure).

**Output Files:**
1.  `src/config/rankingWeights.ts` (New file: Weight definitions and utility)
2.  `src/services/discovery.service.ts` (Updated: `applyBlendedRanking` mock utility)
3.  `src/controllers/admin.controller.ts` (Updated: Admin endpoint to manage weights)
4.  `src/routes/admin.routes.ts` (Updated: new protected route)
5.  `test/unit/ranking_weights.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **PUT /admin/ranking/weights** | `{ experimentId: string, weights: { alpha: number, beta: number, ... } }` | `{ status: 'updated', experimentId: string }` | Auth (Admin/Finance) |

**Ranking Score (Simulated Output):**
$$FinalScore = \alpha \cdot \text{Relevance} + \beta \cdot \text{Trust} + \gamma \cdot \text{Recency} + \dots$$

**Runtime & Env Constraints:**
*   **Security:** Weight configuration must be protected by Admin-level RBAC (`ADMIN_DASHBOARD`).
*   **A/B Readiness:** The system must support loading weights based on an environment/feature flag (simulated by `ExperimentId`).
*   **Calculations:** The utility should ensure weights sum to 1.0 (or whatever is defined as max/norm) before storage/use.

**Acceptance Criteria:**
*   The `rankingWeights.ts` utility correctly defines the standard A/B weighting parameters ($\alpha, \beta, \gamma, \dots$).
*   The Admin endpoint successfully updates the current set of weights (simulated storage).
*   The service logic ensures weights are validated before saving (e.g., non-negative).

**Tests to Generate:**
*   **Unit Test (Weight Validation):** Test utility to check if custom weights are valid (e.g., no negative values).
*   **Integration Test (Update):** Test Admin successfully updating weights and Creator failing (403).

***

### **Task 42 Code Implementation**

#### **42.1. `src/config/rankingWeights.ts` (New Config File)**

```typescript
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
    beta: 0.25,  // Trust
    gamma: 0.15, // Recency
    delta: 0.10, // Activity
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

/** Retrieves the currently active A/B experiment weights. */
export function getCurrentRankingWeights(experimentId?: string): IRankingWeights {
    // In a full A/B system, experimentId would map to a user ID or session cookie for variant checking
    return currentExperiment.weights; 
}

/** Validates and updates the active ranking weights (Admin-only). */
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
```

#### **42.2. `src/services/discovery.service.ts` (Updates - Mock Scorer)**

```typescript
// src/services/discovery.service.ts (partial update)
// ... (Imports, DiscoveryService class definition, searchCreators, searchProjects methods) ...
import { getCurrentRankingWeights, IRankingWeights } from '../config/rankingWeights';

export class DiscoveryService {
    // ... (searchCreators and searchProjects methods) ...

    /** 
     * Applies the current blended ranking formula to a search document. 
     * NOTE: This is a utility function used in search query builder (simulated). 
     */
    public applyBlendedRanking(document: any, textRelevanceScore: number, experimentId?: string): number {
        const weights = getCurrentRankingWeights(experimentId);
        
        // --- Calculate Signals (Mock/Placeholder Logic) ---
        // Trust Signal: Function of Verified + Rating (normalized 0..1)
        const trustSignal = (document.verified ? 1 : 0) * 0.5 + (document.rating?.avg / 5 || 0) * 0.5;
        // Recency Signal: Simple high value for recent update (normalized 0..1)
        const recencySignal = (Date.now() - new Date(document.updatedAt || 0).getTime() < (30 * 24 * 60 * 60 * 1000)) ? 1 : 0.2;
        
        // --- Apply Blended Formula ---
        const finalScore = (
            weights.alpha * textRelevanceScore +
            weights.beta * trustSignal +
            weights.gamma * recencySignal +
            weights.delta * 0.5 + // Mock Activity
            weights.epsilon * (document.sponsoredBoost || 0)
        );

        // Normalize to a 0-100 range for client display
        return Math.min(100, Math.round(finalScore * 100));
    }
}
```

#### **42.3. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update - New Admin Finance Controller)
// ... (Imports, services initialization, previous controllers) ...
import { updateRankingWeights, IRankingWeights } from '../config/rankingWeights';
import { body, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const updateRankingWeightsValidation = [
    body('experimentId').isString().withMessage('Experiment ID is required.'),
    body('weights').isObject().withMessage('Weights object is required.'),
    body('weights.alpha').isFloat({ min: 0 }).withMessage('Alpha weight must be non-negative.'),
    // NOTE: All other weight fields (beta, gamma, delta, epsilon) should have similar validation
];


// --- Admin Ranking Controller ---

/** Admin updates the active ranking weights. PUT /admin/ranking/weights */
export const updateRankingWeightsController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { experimentId, weights } = req.body;

        // 2. Service Call (updates the in-memory/DB config store)
        const updatedConfig = updateRankingWeights(weights as IRankingWeights, experimentId);

        // 3. Success (200 OK)
        return res.status(200).json({
            status: 'updated',
            experimentId: updatedConfig.experimentId,
            updatedAt: updatedConfig.updatedAt.toISOString(),
            activeWeights: updatedConfig.weights,
        });
    } catch (error: any) {
        if (error.message === 'WeightValidationFailed') { return res.status(422).json({ error: { code: 'weight_sum_error', message: 'Weights must be non-negative and sum to 1.0 (or close).' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating ranking weights.' } });
    }
};
```

#### **42.4. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 39) ...
import { updateRankingWeightsController, updateRankingWeightsValidation } from '../controllers/admin.controller';

const router = Router();
const financeAccess = [PERMISSIONS.FINANCE_MANAGE]; // Use high-level access for all admin/config routes

// ... (GET /admin/payments/ledger and GET /admin/payouts/batches from Task 39) ...


// --- Admin Configuration Endpoints (Task 42) ---

// PUT /admin/ranking/weights - Update A/B ranking weights
router.put(
    '/ranking/weights',
    authenticate,
    authorize(financeAccess), // RBAC check
    updateRankingWeightsValidation,
    updateRankingWeightsController
);

export default router;
```

#### **42.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T42.1** | `Unit Test` | Canonical Check | Different key orders, same values (utility) | **N/A** | Output hash must be identical. |
| **T42.2** | `PUT /ranking/weights` | Happy Path: Update | Auth Admin, Valid weights (sum=1.0) | **200 OK** | N/A |
| **T42.3** | `PUT /ranking/weights` | Fail: Weight Sum Invalid | Auth Admin, `weights.alpha=0.2` (sum=0.6) | **422 Unprocessable** | `weight_sum_error` |
| **T42.4** | `PUT /ranking/weights` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |

---
