Following the structured plan and focusing on reliable deployment, we proceed with **Task 98: Migration Strategy for Production Data**.

This task specifies the advanced logic and procedures for deploying large-scale schema changes with zero downtime, which is a key requirement for managing production microservices and avoiding service disruption.

***

## **Task 98: Migration Strategy for Production Data**

**Goal:** Define the strategy for implementing "zero-downtime" data migrations (e.g., refactoring a model, denormalizing a field) using a **shadow-write/read-old-write-new** pattern, ensuring the application remains available while schema changes are applied and backfilled asynchronously.

**Service:** `Deployment / Infrastructure`
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 78 (Migration Infrastructure), Task 52 (Jobs/Worker Queue).

**Output Files:**
1.  `documentation/zero_downtime_migrations.md` (New file: Strategy documentation)
2.  `src/migrations/202511XX_backfill_denormalized_field.ts` (New file: Conceptual backfill migration)
3.  `src/services/job.service.ts` (Updated: `enqueueMigrationJob` utility - conceptual)

**Input/Output Shapes:**

| Migration Step | Application State | Database Logic | Timeframe |
| :--- | :--- | :--- | :--- |
| **Phase 1: Dual Write** | Reads Old/New $\rightarrow$ Writes Old & New | Adds New Field/Collection. | Application Version V1 $\rightarrow$ V2. |
| **Phase 2: Backfill** | Reads Old/New $\rightarrow$ Writes Old & New | Asynchronously updates all existing data to the New format. | Job (Task 52) runs for hours/days. |
| **Phase 3: Switch Read** | Reads ONLY New $\rightarrow$ Writes ONLY New | Removes Old Field/Collection. | Final atomic switch. |

**Runtime & Env Constraints:**
*   **Decoupling:** The backfill process is heavy and **must** be managed by the Jobs Service (Task 52) to run in the background.
*   **Code Change:** The primary migration strategy must involve updating application code to read from two places while writing to two places.

**Acceptance Criteria:**
*   The strategy documentation clearly outlines the three phases (Dual Write, Backfill, Switch Read).
*   The conceptual migration script demonstrates the use of a worker function (Job Service) for backfilling data.

**Tests to Generate:**
*   **Documentation:** The defined strategy document.

***

### **Task 98 Code Implementation (Documentation & Strategy)**

#### **98.1. `documentation/zero_downtime_migrations.md` (New Strategy Document)**

```markdown
# Zero-Downtime Data Migration Strategy (Mongoose/MongoDB)

All schema changes (adding/renaming/splitting fields) must follow a multi-phase, dual-write strategy to ensure the OpenShow API cluster achieves near-zero downtime.

## Primary Goal

Ensure all API endpoints remain fully functional and consistent (both read and write) while data backfilling occurs asynchronously.

## Strategy: Dual-Write / Asynchronous Backfill

This process minimizes the risk associated with MongoDB's schemaless nature, where application code changes can lead to runtime errors on old documents.

### Phase 1: Dual Write (Application-Side)

1.  **Code Change (V2 Deploy):** The new version of the application code (V2) is deployed.
2.  **Read Logic:** Code logic is updated to `Read(New_Field)` OR `Read(Old_Field)` (Coalesce).
3.  **Write Logic:** Code logic is updated to `Write(Old_Field)` AND `Write(New_Field)` (Dual Write).
4.  **Migration Script Action:** A migration script (Task 78) is run to add the new index/field but **without** modifying existing data (non-blocking schema change).

### Phase 2: Asynchronous Backfill (Job-Side)

1.  **Job Enqueue:** The Migration script (Task 78) enqueues a `data.backfill` job for the target model (e.g., `CreatorProfile`).
2.  **Worker Action (Task 52):** A worker processes documents in batches, converting `Old_Field` content to the `New_Field` format.
    *   `Job.payload`: `{ model: 'CreatorProfile', field: 'denormalizedName' }`
3.  **Read Status:** The main application still uses the coalescing read (`Read(New) OR Read(Old)`).

### Phase 3: Switch Read & Cleanup

1.  **Job Completion:** The backfill job finishes (all documents have the `New_Field` populated).
2.  **Code Change (V3 Deploy):** The final version of the code (V3) is deployed.
    *   **Read Logic:** Code logic is switched to **Read ONLY New_Field**.
    *   **Write Logic:** Code logic is switched to **Write ONLY New_Field**.
3.  **Migration Script Action (Final):** A final migration script (Task 78) is run to remove the `Old_Field` from the schema (if necessary) and remove the dual-write code from V3.

---
**Example Use Case:** Renaming `User.fullName` to `User.displayName` for Profile V2.
```
V2 Code Deployment:
- Read: user.displayName || user.fullName
- Write: user.displayName = new_val; user.fullName = new_val;

Backfill Job:
- Process: db.users.updateMany({ fullName: { $exists: true }, displayName: { $exists: false } }, { $set: { displayName: "$fullName" } })

V3 Code Deployment:
- Read: user.displayName
- Write: user.displayName = new_val;
```
```

#### **98.2. `src/migrations/202511XX_backfill_denormalized_field.ts` (Conceptual Backfill)**

```typescript
// src/migrations/202511XX_backfill_denormalized_field.ts

import { Db } from 'mongodb';
import { JobService } from '../services/job.service'; // Internal Service (Job Queue)

// NOTE: We assume a simplified setup for migration script access to internal services.
// In reality, the migration runner would call an HTTP endpoint on the Job Service.
const mockJobService = { 
    enqueueJob: async (data: any) => ({ jobId: `migration_job_${crypto.randomBytes(4).toString('hex')}` }) 
}; 

export const up = async (db: Db): Promise<void> => {
  // Phase 1 Action: Add the new index and any required un-populated fields
  await db.collection('projects').createIndex({ 'ownerName': 1 }, { name: 'idx_owner_name_backfill', background: true });

  // Phase 2 Action: ENQUEUE THE ASYNCHRONOUS BACKFILL JOB
  const job = await mockJobService.enqueueJob({
    type: 'data.backfill',
    payload: { 
        sourceModel: 'Project', 
        targetField: 'ownerName', 
        sourceField: 'ownerId', 
        lookupModel: 'User' 
    },
    priority: 10, // Low priority for heavy DB operation
  });

  console.log(`Backfill job for Project.ownerName enqueued with ID: ${job.jobId}`);
};

export const down = async (db: Db): Promise<void> => {
  // Phase 3 Action (Revert): Drop the index created for the new field
  await db.collection('projects').dropIndex('idx_owner_name_backfill');
  
  // NOTE: Data loss is a risk on down; usually down scripts are data-safe (index/config only)
};
```

#### **98.3. Test Specification**

| Test ID | Method | Description | Command | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **T98.1** | `Migration Up` | Job Enqueue Check | Execute `up` migration | `mockJobService.enqueueJob` called with `type: 'data.backfill'`. |
| **T98.2** | `Strategy Check` | Data Consistency | Simulate V2 code reading after V1 writes. | Read coalesces data correctly (no null/undefined errors). |
| **T98.3** | `Documentation` | Strategy Review | N/A | Documentation is clear, actionable, and references Job Service usage. |

---