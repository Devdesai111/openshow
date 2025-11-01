Following the structured plan, we proceed with **Task 56: Background Job: Reindex Batch**.

This task implements the batch job necessary for maintaining the consistency and data quality of the search index, providing the mechanism for periodic full reindexing or recovery reindexing.

***

## **Task 56: Background Job: Reindex Batch**

**Goal:** Implement the worker handler logic for the `reindex.batch` job type, which processes a collection of document IDs (`creator` or `project`), retrieves their latest state from the domain services, and pushes individual updates to the internal Indexing API (Task 41).

**Service:** `Jobs & Worker Queue Service` / `Marketplace / Discovery / Search API` (logic)
**Phase:** I - Search, Ranking, Advanced features & ML hooks
**Dependencies:** Task 54 (Job Reporting Logic), Task 41 (Discovery Service Indexing API), Task 8/12 (Source Models: CreatorProfile, Project).

**Output Files:**
1.  `src/jobs/handlers/reindexHandler.ts` (New file: Worker business logic)
2.  `src/jobs/jobRegistry.ts` (Updated: Register `reindex.batch` job type)
3.  `test/unit/reindex_job.test.ts` (Test specification)

**Input/Output Shapes (Worker Logic):**
*   Input: `{ docType: 'creator'|'project', docIds: string[] }`
*   Simulated Success: Calls `DiscoveryService.indexDocument` (Task 41) for each ID $\rightarrow$ Calls `POST /jobs/:id/succeed`.

**Runtime & Env Constraints:**
*   **Source Fetching:** The handler must simulate fetching the full document state from the primary domain database (e.g., fetching a `CreatorProfile` and its linked `User` model).
*   **Decoupling:** The handler must use the `DiscoveryService` to push the update, maintaining the decoupling between the Job worker and the underlying search engine.
*   **Idempotency:** This job is inherently idempotent due to the `updatedAt` check in the Indexing API (Task 41).

**Acceptance Criteria:**
*   The job successfully processes the list of `docIds` and completes without error.
*   The handler logs a call to the `DiscoveryService.indexDocument` for every item in the batch.
*   The `reindex.batch` job type is correctly registered in the `jobRegistry.ts`.

**Tests to Generate:**
*   **Unit Test (Handler Logic):** Test the handler's success path, ensuring the correct number of calls to the mock `DiscoveryService.indexDocument` are made.

***

### **Task 56 Code Implementation**

#### **56.1. `src/jobs/jobRegistry.ts` (Updates)**

```typescript
// src/jobs/jobRegistry.ts (partial update)
// ... (All previous imports and schemas) ...

// --- Schemas for Core Job Types ---
const REINDEX_BATCH_SCHEMA: IJobSchema = {
    type: 'reindex.batch',
    required: ['docType', 'docIds'],
    properties: {
        docType: 'string', // 'creator' or 'project'
        docIds: 'array',
    },
};

// --- Job Policies ---
const REINDEX_BATCH_POLICY: IJobPolicy = {
    type: REINDEX_BATCH_SCHEMA.type,
    maxAttempts: 3,
    timeoutSeconds: 3600, // 1 hour for long batch processes
};

// --- Registry Setup ---
const JOB_REGISTRY: Record<string, { schema: IJobSchema, policy: IJobPolicy }> = {
    // ... (Existing entries)
    [REINDEX_BATCH_SCHEMA.type]: { schema: REINDEX_BATCH_SCHEMA, policy: REINDEX_BATCH_POLICY },
};
// ... (Export functions)
```

#### **56.2. `src/jobs/handlers/reindexHandler.ts` (New Handler File)**

```typescript
// src/jobs/handlers/reindexHandler.ts
import { IJob } from '../../models/job.model';
import { DiscoveryService } from '../../services/discovery.service'; // Task 41 dependency
import { CreatorProfileModel } from '../../models/creatorProfile.model'; // Source data
import { ProjectModel } from '../../models/project.model'; // Source data
import { Types } from 'mongoose';

const discoveryService = new DiscoveryService();

/**
 * Worker Logic Handler for the 'reindex.batch' job type.
 * Pulls source data and pushes updates to the search indexing API (Task 41).
 */
export async function handleReindexJob(job: IJob): Promise<{ totalIndexed: number }> {
    const { docType, docIds } = job.payload;
    
    let SourceModel: any;
    let totalIndexed = 0;

    // 1. Determine Source Model and Fields to Fetch
    if (docType === 'creator') {
        SourceModel = CreatorProfileModel;
        // In a real app, this would deeply populate User for full profile/name data
    } else if (docType === 'project') {
        SourceModel = ProjectModel;
    } else {
        throw new Error(`InvalidDocType: ${docType}`);
    }

    // 2. Fetch Data from Primary Source (Batch read)
    const documents = await SourceModel.find({ _id: { $in: docIds.map((id: string) => new Types.ObjectId(id)) } }).lean();

    // 3. Process and Push to Indexing API (Task 41)
    for (const doc of documents) {
        // Build the simplified indexing payload
        const indexingPayload = {
            docType,
            docId: doc._id.toString(),
            // CRITICAL: Send only the denormalized/search-ready fields
            payload: {
                title: doc.title || doc.preferredName || 'Untitled',
                skills: doc.skills,
                verified: doc.verified,
                status: doc.status,
                // Add more denormalized fields here (e.g., ownerName, roleCounts)
            },
            updatedAt: doc.updatedAt.toISOString(),
        };

        try {
            // Push update to Discovery Service's internal API (Task 41)
            await discoveryService.indexDocument(indexingPayload);
            totalIndexed++;
        } catch (e: any) {
            // Log failure to index a single document but continue the batch (soft failure)
            console.error(`Failed to index ${docType} ${doc._id}: ${e.message}`);
        }
    }

    // 4. Return summary
    return { totalIndexed };
}
```

#### **56.3. `src/routes/job.routes.ts` (Updates - No API Changes)**

*(No external API changes for this task. It relies entirely on the existing job report endpoints from Task 54.)*

#### **56.4. Test Specification**

| Test ID | Method | Description | Condition | Expected Final Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T56.1** | `handleReindexJob` | Happy Path: Creator Reindex | Valid `docIds` for `docType: 'creator'` | N/A | `discoveryService.indexDocument` is called for every ID. |
| **T56.2** | `handleReindexJob` | Partial Failure Tolerance | One `docId` causes a transient error in `indexDocument` | N/A | Job handler continues and reports `totalIndexed = N-1`. |
| **T56.3** | `handleReindexJob` | Fail: Invalid Type | `docType: 'invalid'` | N/A | Handler throws `InvalidDocType` error; Job Service reports failure. |

---