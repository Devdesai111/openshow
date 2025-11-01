Following the structured plan, we proceed with **Task 41: Marketplace / Discovery Indexing API**.

This task establishes the essential API for asynchronous indexing, allowing domain services (Projects, User Profile) to push data to the dedicated search index (simulated for Phase 1), which is the source of truth for the `GET /creators` and `GET /market/projects` endpoints (Tasks 10 and 16).

***

## **Task 41: Marketplace / Discovery Indexing API**

**Goal:** Implement the internal-only indexing API endpoint (`POST /search/index-update`) used by other services (via event handlers) to create or update single documents in the search index, ensuring eventual consistency.

**Service:** `Marketplace / Discovery / Search API`
**Phase:** I - Search, Ranking, Advanced features & ML hooks
**Dependencies:** Task 10, 16 (Discovery Service structure), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/discovery.service.ts` (Updated: `indexDocument`)
2.  `src/controllers/discovery.controller.ts` (Updated: `indexUpdateController`)
3.  `src/routes/discovery.routes.ts` (Updated: new protected route)
4.  `test/unit/indexing_logic.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /search/index-update** | `{ docType: 'creator'|'project', docId: string, payload: any, updatedAt: string }` | `{ docId: string, status: 'indexed' }` | Auth (Internal/System Only) |

**Internal Payload (Creator Update Example):**
```json
{
  "docType": "creator",
  "docId": "60f1a2b3...",
  "payload": {
    "headline": "AI Video Editor (Freelance)",
    "skills": ["video-editing", "prompt-engineering"]
  },
  "updatedAt": "2025-11-01T15:00:00Z"
}
```

**Runtime & Env Constraints:**
*   **Security:** This endpoint is highly privileged; it must be restricted to internal services or Admin/System tokens (`ADMIN_DASHBOARD` RBAC required).
*   **Idempotency & Ordering:** The logic must be idempotent (using `docId`) and account for out-of-order events using the `updatedAt` timestamp (only index if incoming timestamp is newer than current index time).
*   **Search Engine Mock:** We simulate the search engine interaction by just updating a cache/DB entry or logging the final index document.

**Acceptance Criteria:**
*   A non-Admin accessing the endpoint returns **403 Forbidden**.
*   The service correctly combines the incoming `payload` with the existing data and updates the final "index document" (simulated in service logic).
*   The system must ignore an update if the incoming `updatedAt` is older than the current indexed record.

**Tests to Generate:**
*   **Unit Test (Idempotency):** Verify the `indexDocument` method rejects an older `updatedAt` timestamp.
*   **Integration Test (Security):** Test unauthorized access (403).

***

### **Task 41 Code Implementation**

#### **41.1. `src/services/discovery.service.ts` (Updates)**

```typescript
// src/services/discovery.service.ts (partial update)
// ... (Imports, DiscoveryService class definition, searchCreators, searchProjects methods) ...

// Placeholder for the Index Document (Simulating a document in ElasticSearch/OpenSearch)
// PRODUCTION: This would be the actual ES/OpenSearch client interaction.
const MockSearchIndexStore = new Map<string, any>(); 

interface IIndexDocumentRequest {
    docType: 'creator' | 'project';
    docId: string;
    payload: Record<string, any>;
    updatedAt: string;
}

export class DiscoveryService {
    // ... (searchCreators and searchProjects methods) ...

    /**
     * Updates or creates a document in the search index with out-of-order protection.
     * @throws {Error} - 'StaleUpdate' if incoming updatedAt is older than the current index record.
     */
    public async indexDocument(data: IIndexDocumentRequest): Promise<void> {
        const { docType, docId, payload, updatedAt } = data;
        const indexKey = `${docType}_${docId}`;
        const newUpdatedAt = new Date(updatedAt);
        
        // 1. Check for Stale/Out-of-Order Update (CRITICAL)
        const currentDoc = MockSearchIndexStore.get(indexKey);

        if (currentDoc && currentDoc.updatedAt && newUpdatedAt <= new Date(currentDoc.updatedAt)) {
            // New update is older or same as current indexed document, ignore.
            console.warn(`[Index] Stale update rejected for ${indexKey}. Current: ${currentDoc.updatedAt}, Incoming: ${updatedAt}`);
            throw new Error('StaleUpdate'); 
        }

        // 2. Merge/Upsert Logic (Simulate partial update and indexing)
        const newDoc = {
            ...currentDoc,
            ...payload,
            docId,
            docType,
            updatedAt: newUpdatedAt.toISOString(),
        };

        MockSearchIndexStore.set(indexKey, newDoc);

        // PRODUCTION: Call ElasticSearch/OpenSearch Client:
        // esClient.update({ index: docType, id: docId, body: { doc: payload, doc_as_upsert: true } });

        console.log(`[Index] Document ${indexKey} successfully indexed/updated.`);
    }
}
```

#### **41.2. `src/controllers/discovery.controller.ts` (Updates)**

```typescript
// src/controllers/discovery.controller.ts (partial update)
// ... (Imports, discoveryService initialization, previous controllers) ...
import { body, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const indexUpdateValidation = [
    body('docType').isIn(['creator', 'project']).withMessage('Invalid document type.'),
    body('docId').isMongoId().withMessage('Document ID must be a valid Mongo ID.'),
    body('updatedAt').isISO8601().toDate().withMessage('Updated date is required and must be ISO 8601 format.'),
    body('payload').isObject().withMessage('Payload must be an object with fields to update.'),
];


// --- Internal Indexing Controller ---

/** Internal endpoint for indexing updates. POST /search/index-update */
export const indexUpdateController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        // 2. Service Call (handles out-of-order check)
        await discoveryService.indexDocument(req.body);

        // 3. Success (200 OK)
        return res.status(200).json({ 
            docId: req.body.docId, 
            status: 'indexed', 
            updatedAt: req.body.updatedAt 
        });

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'StaleUpdate') {
             // Return 200/204 to the message broker/service to acknowledge the event was processed (even if skipped)
             return res.status(200).json({ status: 'ignored', message: 'Update ignored as it is older than the current indexed document.' });
        }
        
        return res.status(500).json({ error: { code: 'indexing_fail', message: 'Internal server error during indexing process.' } });
    }
};
```

#### **41.3. `src/routes/discovery.routes.ts` (Updates)**

```typescript
// src/routes/discovery.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 10/16) ...
import { indexUpdateController, indexUpdateValidation } from '../controllers/discovery.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const internalAccess = [PERMISSIONS.ADMIN_DASHBOARD]; // Simulating Internal Service Token access


// ... (GET /creators and GET /projects from Task 10/16) ...


// --- Internal Indexing Endpoints (Task 41) ---

// POST /search/index-update - Internal endpoint for atomic document updates
router.post(
    '/index-update',
    authenticate,
    authorize(internalAccess), // RBAC check: System/Admin access only
    indexUpdateValidation,
    indexUpdateController
);


export default router;
```

#### **41.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T41.1** | `POST /index-update` | Happy Path: New Document | Auth Admin, Valid Payload | **200 OK** | Document is stored in `MockSearchIndexStore`. |
| **T41.2** | `POST /index-update` | Security: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T41.3** | `POST /index-update` | Idempotency: Stale Data | Incoming `updatedAt` is older than current record | **200 OK** | Status is `ignored`; store content is NOT updated. |
| **T41.4** | `POST /index-update` | Fail: Missing UpdatedAt | Valid Payload, Missing `updatedAt` | **422 Unprocessable** | `validation_error` |

---

