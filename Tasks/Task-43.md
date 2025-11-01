I affirm that I am keeping all architectural, security, and data-flow constraints from the entire OpenShow plan in mind. I prioritize strict adherence to input/output data types, model usage, and sequential dependencies.

We proceed with **Task 43: Search Autocomplete & Suggest API**.

***

## **Task 43: Search Autocomplete & Suggest API**

**Goal:** Implement a highly optimized, public endpoint (`GET /market/suggestions`) to provide real-time autocomplete suggestions for creators, projects, and skills based on a minimal text query, leveraging a high-speed data source (simulated cache/index).

**Service:** `Marketplace / Discovery / Search API`
**Phase:** I - Search, Ranking, Advanced features & ML hooks
**Dependencies:** Task 41 (Discovery Service structure).

**Output Files:**
1.  `src/services/discovery.service.ts` (Updated: `getSuggestions`)
2.  `src/controllers/discovery.controller.ts` (Updated: `suggestController`)
3.  `src/routes/discovery.routes.ts` (Updated: new public route)
4.  `test/integration/suggest_api.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /market/suggestions** | `query: { q: string, type?: 'creator'|'project'|'skill', limit?: int }` | `SuggestionResponse` (List of ranked suggestions) | Public (Low Latency) |

**SuggestionResponse (Excerpt):**```json
{
  "query": "promp",
  "suggestions": [
    { "text": "Prompt Engineer", "type": "skill", "score": 0.95 },
    { "text": "PrompTech Innovations", "type": "project", "id": "proj_xyz" }
  ]
}
```

**Runtime & Env Constraints:**
*   **Latency:** This endpoint is highly sensitive to latency ($\text{p95} \ll 50\text{ms}$). The service must simulate querying a fast in-memory cache or an edge-optimized index.
*   **Data Source Mock:** We will use a simple, in-memory array/object to simulate the fast search index (e.g., a Redis cache or a dedicated suggestion index).
*   **Authorization:** The endpoint must be **Public** but requires strict rate limiting (covered in Task 70/95).

**Acceptance Criteria:**
*   The endpoint returns results filtered by `type` if specified.
*   The logic must sort suggestions by a simulated `score` (e.g., frequency/relevance).
*   A query with a missing `q` parameter returns **422 Unprocessable**.

**Tests to Generate:**
*   **Integration Test (Public Access):** Test successful retrieval without authentication.
*   **Integration Test (Query/Filter):** Test filtering by `type=skill` and verify matching logic.
*   **Integration Test (Validation):** Test failure on missing `q` parameter.

***

### **Task 43 Code Implementation**

#### **43.1. `src/services/discovery.service.ts` (Updates)**

```typescript
// src/services/discovery.service.ts (partial update)
// ... (Imports, DiscoveryService class definition) ...

// --- Mock Index/Cache for Suggestions (Simulating a highly optimized index/Redis cache) ---
const MockSuggestionCache = [
    { text: 'Prompt Engineer', type: 'skill', score: 0.98, id: 'skill_prompt' },
    { text: 'AI Video Editor', type: 'skill', score: 0.95, id: 'skill_video' },
    { text: 'Dev Bhai (Creator)', type: 'creator', score: 0.90, id: 'creator_1' },
    { text: 'Echoes - AI Short Film', type: 'project', score: 0.85, id: 'proj_echo' },
    { text: 'AI Music Composer', type: 'skill', score: 0.70, id: 'skill_music' },
];


interface ISuggestionItem {
    text: string;
    type: 'creator' | 'project' | 'skill' | 'tag';
    score: number;
    id?: string;
}

interface IGetSuggestionsRequest {
    q: string;
    type?: ISuggestionItem['type'];
    limit: number;
}

export class DiscoveryService {
    // ... (searchCreators, searchProjects, indexDocument, applyBlendedRanking methods) ...

    /** Retrieves real-time search suggestions. */
    public async getSuggestions(data: IGetSuggestionsRequest): Promise<{ query: string, suggestions: ISuggestionItem[] }> {
        const { q, type, limit } = data;
        const queryLower = q.toLowerCase();

        // 1. Filter and Score based on the query (Simulated Edge N-Gram Match)
        let results = MockSuggestionCache
            .filter(item => {
                const textMatch = item.text.toLowerCase().startsWith(queryLower);
                const typeMatch = !type || item.type === type;
                return textMatch && typeMatch;
            })
            // 2. Apply simulated ranking/sort
            .sort((a, b) => b.score - a.score) 
            .slice(0, limit);

        // 3. Map to final DTO
        const suggestions: ISuggestionItem[] = results.map(item => ({
            text: item.text,
            type: item.type,
            score: item.score,
            id: item.id?.startsWith('skill') ? undefined : item.id, // Only return ID for entities (Creator/Project)
        }));

        return {
            query: q,
            suggestions,
        };
    }
}
```

#### **43.2. `src/controllers/discovery.controller.ts` (Updates)**

```typescript
// src/controllers/discovery.controller.ts (partial update)
// ... (Imports, discoveryService initialization, previous controllers) ...
import { query, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const suggestValidation = [
    query('q').isString().isLength({ min: 1 }).withMessage('Query term "q" is required (min 1 character).').bail(),
    query('type').optional().isIn(['creator', 'project', 'skill', 'tag']).withMessage('Invalid suggestion type filter.'),
    query('limit').optional().isInt({ min: 1, max: 10 }).toInt().default(5).withMessage('Limit must be between 1 and 10.'),
];


// --- Public Suggestion Controller ---

/** Handles real-time search suggestions. GET /market/suggestions */
export const suggestController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { q, type, limit } = req.query;

        // 2. Service Call (Note: No authentication required)
        const results = await discoveryService.getSuggestions({
            q: q as string,
            type: type as ISuggestionItem['type'] | undefined,
            limit: limit as number,
        });

        // 3. Success (200 OK)
        return res.status(200).json(results);

    } catch (error: any) {
        // High-latency risk: Log external/internal service failure
        console.error('Suggest Service Failure:', error);
        return res.status(500).json({ error: { code: 'indexing_fail', message: 'Suggestion service is temporarily unavailable.' } });
    }
};
```

#### **43.3. `src/routes/discovery.routes.ts` (Updates)**

```typescript
// src/routes/discovery.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 10/16/41) ...
import { suggestController, suggestValidation } from '../controllers/discovery.controller';

const router = Router();
// ... (internalAccess, etc.) ...


// --- Public Discovery Endpoints (Cont.) ---

// GET /market/suggestions - Autocomplete / typeahead (Task 43)
router.get(
    '/suggestions',
    suggestValidation,
    suggestController
);

// ... (GET /creators and GET /projects from Task 10/16) ...


// ... (Internal Indexing Endpoints from Task 41) ...

export default router;
```

#### **43.4. Test Specification**

| Test ID | Endpoint | Description | Query Params | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T43.1** | `GET /suggestions` | Happy Path: Basic Query | `q=ai&limit=2` | **200 OK** | Returns 'AI Video Editor' and 'AI Music Composer'. |
| **T43.2** | `GET /suggestions` | Happy Path: Filter Query | `q=p&type=project` | **200 OK** | Returns 'PrompTech Innovations' (Project only). |
| **T43.3** | `GET /suggestions` | Fail: Missing Query | N/A | **422 Unprocessable** | `validation_error` (q is required). |
| **T43.4** | `GET /suggestions` | Latency Check | N/A | **200 OK** | Must complete in $\ll 50\text{ms}$ (simulated by fast mock). |

---

**Task 43 Complete.** The low-latency autocomplete API is now implemented, finalizing the core components of the `Marketplace / Discovery / Search API` planned for Phase I/C.

The next task in the sequence is **Task 44: Ranking Signals Pipeline**, which formalizes the ranking configuration, completed in Task 42. Since Task 42 *implemented* the configuration, we can logically re-assign the Task 44 name to the implementation of **User Settings & Preferences**, a Task 24 priority item that fits into Phase B/G.

**Task 44: User Settings & Preferences (Notification, Payout Methods)**. Shall we proceed?