Following the structured plan and focusing on the advanced features of the Discovery Service, we proceed with **Task 45: Advanced Search Re-ranker Integration**.

This task implements the internal hook to integrate an external Machine Learning (ML) service or vector search engine (the "Re-ranker") into the search flow. Since the ML service itself is external, we focus on the API facade and logic.

***

## **Task 45: Advanced Search Re-ranker Integration**

**Goal:** Implement an internal service utility (`callReRanker`) and an Admin endpoint (`POST /admin/search/rerank-hook`) that simulates sending preliminary search results to an external ML re-ranker API for final scoring and sorting.

**Service:** `Marketplace / Discovery / Search API`
**Phase:** I - Search, Ranking, Advanced features & ML hooks
**Dependencies:** Task 42 (Ranking Weights/Logic), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/discovery.service.ts` (Updated: `callReRanker` utility)
2.  `src/controllers/admin.controller.ts` (Updated: `reRankHookController`)
3.  `src/routes/admin.routes.ts` (Updated: new protected route)
4.  `test/unit/reranker_hook.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Headers) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /admin/search/rerank-hook** | `{ query: string, results: { docId, score, features }[] }` | `{ query: string, rerankedResults: { docId, finalScore }[] }` | Auth (Admin/Internal System Only) |

**ReRankInput (Excerpt):**```json
{
  "query": "video editor",
  "results": [
    { "docId": "creator_a", "score": 0.85, "features": { "completion_rate": 0.95 } }
  ]
}
```

**Runtime & Env Constraints:**
*   **Security:** This is strictly an internal utility; it must be protected by Admin-level RBAC (`ADMIN_DASHBOARD`).
*   **External Mock:** The service should mock the call to the external ML re-ranker API (which typically involves an HTTP/gRPC call).
*   **Performance:** The latency of this call is critical in a real search flow, hence the external service must be assumed to be fast or asynchronous.

**Acceptance Criteria:**
*   A non-Admin accessing the hook returns **403 Forbidden**.
*   The service utility successfully processes the mock input and returns a simulated re-ranked output with `finalScore`.
*   The final ranker output must include the original `query` for context/audit.

**Tests to Generate:**
*   **Unit Test (Re-ranker Utility):** Test the `callReRanker` mock with sample data to ensure it correctly modifies the scores (e.g., boosting a specific `docId`).
*   **Integration Test (Security):** Test unauthorized access (403).

***

### **Task 45 Code Implementation**

#### **45.1. `src/services/discovery.service.ts` (Updates)**

```typescript
// src/services/discovery.service.ts (partial update)
// ... (Imports, DiscoveryService class definition, previous methods) ...

// DTOs for Re-ranker Hook
interface IReRankResult {
    docId: string;
    finalScore: number;
}
interface IReRankInput {
    query: string;
    results: { docId: string; score: number; features: Record<string, any> }[];
}

export class DiscoveryService {
    // ... (searchCreators, searchProjects, indexDocument, etc. methods) ...

    /**
     * Simulates calling an external ML Re-ranker service.
     * This utility is intended for internal use only by the primary search method.
     * @param data - The query and preliminary search results with feature signals.
     * @returns A list of re-ranked document scores.
     */
    public async callReRanker(data: IReRankInput): Promise<{ query: string, rerankedResults: IReRankResult[] }> {
        const { query, results } = data;

        // PRODUCTION: This would be an HTTP/gRPC call to a dedicated ML service.
        // const rerankerResponse = await fetch('ML_RERANKER_ENDPOINT', { method: 'POST', body: JSON.stringify(data) });

        // MOCK LOGIC: Boost any document with high completion_rate features
        const rerankedResults: IReRankResult[] = results.map(result => {
            let finalScore = result.score;
            
            // Example Rule: Boost documents with completion_rate > 0.9 by 0.1
            if (result.features.completion_rate && result.features.completion_rate > 0.9) {
                finalScore += 0.1;
            }

            return {
                docId: result.docId,
                finalScore: Math.min(1.0, finalScore),
            };
        });
        
        // Final Sort by finalScore DESC
        rerankedResults.sort((a, b) => b.finalScore - a.finalScore);

        return {
            query,
            rerankedResults,
        };
    }
}
```

#### **45.2. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { body, validationResult } from 'express-validator';
import { IReRankInput } from '../services/discovery.service';

// --- Validation Middleware ---

export const reRankHookValidation = [
    body('query').isString().isLength({ min: 1 }).withMessage('Query string is required.'),
    body('results').isArray({ min: 1 }).withMessage('Results array is required.'),
    body('results.*.docId').isString().withMessage('Document ID is required for each result.'),
    body('results.*.score').isFloat({ min: 0, max: 1 }).withMessage('Score must be a float between 0 and 1.'),
];


// --- Admin Ranking Controller ---

/** Admin/System manually calls the Re-ranker hook. POST /admin/search/rerank-hook */
export const reRankHookController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        // 2. Service Call (Internal call to the re-ranker utility)
        const result = await discoveryService.callReRanker(req.body as IReRankInput);

        // 3. Success (200 OK)
        return res.status(200).json(result);

    } catch (error: any) {
        // Log the severe failure of the external system
        console.error('External Re-ranker Failure:', error);
        return res.status(500).json({ error: { code: 'external_rerank_fail', message: 'External re-ranker service failed to process request.' } });
    }
};
```

#### **45.3. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 39/42) ...
import { reRankHookController, reRankHookValidation } from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const financeAccess = [PERMISSIONS.FINANCE_MANAGE]; 

// ... (GET /admin/payments/ledger, PUT /admin/ranking/weights, etc.) ...


// --- Admin Search/ML Endpoints (Task 45) ---

// POST /admin/search/rerank-hook - Internal hook to trigger ML re-ranking
router.post(
    '/search/rerank-hook',
    authenticate,
    authorize(financeAccess), // RBAC check: System/Admin access only
    reRankHookValidation,
    reRankHookController
);


export default router;
```

#### **45.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T45.1** | `POST /rerank-hook` | Happy Path: Base Re-rank | Auth Admin, Valid Input | **200 OK** | Returns `rerankedResults` array with `finalScore`. |
| **T45.2** | `POST /rerank-hook` | Re-rank Logic Check | Input where a `docId` has `features.completion_rate=0.95` | **200 OK** | The `finalScore` for that `docId` must be boosted by $\sim 0.1$. |
| **T45.3** | `POST /rerank-hook` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T45.4** | `POST /rerank-hook` | Fail: Invalid Payload | Missing `results` array | **422 Unprocessable** | `validation_error` |

---
