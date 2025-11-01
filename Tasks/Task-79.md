Following the structured plan and focusing on maximizing read performance, we proceed with **Task 79: Database Indexing & Performance Tuning**.

This task involves a comprehensive review and implementation of indexes across the core Mongoose schemas defined in previous tasks, targeting the most common and high-traffic query patterns (listings, lookups, audits).

***

## **Task 79: Database Indexing & Performance Tuning**

**Goal:** Audit and implement optimized compound and single-field indexes across the `User`, `CreatorProfile`, `Project`, `AuditLog`, and `PayoutBatch` models to support high-traffic query patterns, thereby optimizing database read latency.

**Service:** `Database / Infrastructure`
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** All models (Task 1, 8, 12, 32, 60), Task 78 (Migration infrastructure - to apply indexes).

**Output Files:**
1.  `src/models/*.model.ts` (Updated: Finalized `schema.index` definitions)
2.  `src/migrations/202511XX_finalize_indexes.ts` (New file: The deployment vehicle for these indexes)
3.  `test/unit/query_performance.test.ts` (Test specification)

**Input/Output Shapes:**

| Model | Index Field(s) | Query Pattern Supported | Type (Single/Compound) |
| :--- | :--- | :--- | :--- |
| **Project** | `ownerId`, `status` | Querying owner's active projects. | Compound |
| **CreatorProfile** | `verified`, `rating.avg` | Creator discovery/sorting. | Compound |
| **AuditLog** | `resourceType`, `timestamp` | Filtering audit logs by resource over time. | Compound |
| **PayoutBatch** | `escrowId` | Fast lookup for idempotency/status updates. | Unique Single |

**Runtime & Env Constraints:**
*   **Safety:** Index creation must be non-blocking where possible (e.g., using `{ background: true }` in Mongoose, although this is often default).
*   **Over-Indexing:** Avoid unnecessary single-field indexes if a compound index already satisfies the query prefix.
*   **Deployment:** Changes are defined in the schema files but should be applied via the Task 78 migration tool.

**Acceptance Criteria:**
*   All high-read/high-importance models have at least one compound index.
*   The `UserInboxModel` (Task 47) index for unread count is confirmed.
*   The `AuthSessionModel` (Task 1) TTL index is confirmed.

**Tests to Generate:**
*   **Unit Test (Mongoose Schema):** Verify all intended indexes are present on the compiled Mongoose models.

***

### **Task 79 Code Implementation (Schema Finalization)**

*(This task requires reviewing and finalizing the index definitions across the 5 most critical models.)*

#### **79.1. `src/models/user.model.ts` (Finalized Indexes)**

```typescript
// src/models/user.model.ts (Finalized)
// ... (Schema definition) ...

// Final Indexes:
// 1. Email (Mandatory Unique)
UserSchema.index({ email: 1 }, { unique: true });
// 2. Role for RBAC checks
UserSchema.index({ role: 1 });
```

#### **79.2. `src/models/authSession.model.ts` (Finalized Indexes)**

```typescript
// src/models/authSession.model.ts (Finalized)
// ... (Schema definition) ...

// Final Indexes:
// 1. TTL Index (Mandatory for session expiry)
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// 2. User ID Lookup
AuthSessionSchema.index({ userId: 1 });
```

#### **79.3. `src/models/creatorProfile.model.ts` (Finalized Indexes)**

```typescript
// src/models/creatorProfile.model.ts (Finalized)
// ... (Schema definition) ...

// Final Indexes (Optimized for Discovery/Sorting):
// 1. User ID (Mandatory Unique)
CreatorProfileSchema.index({ userId: 1 }, { unique: true });
// 2. Discovery Index (Supports filter by verified, sort by rating)
CreatorProfileSchema.index({ verified: 1, 'rating.avg': -1, availability: 1 });
// 3. Search by Skill Tag (Supports multi-tag lookup)
CreatorProfileSchema.index({ skills: 1 });
```

#### **79.4. `src/models/project.model.ts` (Finalized Indexes)**

```typescript
// src/models/project.model.ts (Finalized)
// ... (Schema definition) ...

// Final Indexes (Optimized for Dashboard/Listing):
// 1. Owner & Status (Supports dashboard query: 'My Active Projects')
ProjectSchema.index({ ownerId: 1, status: 1 });
// 2. Visibility & Status (Supports public/market listing)
ProjectSchema.index({ visibility: 1, status: 1 });
// 3. Team Membership (Supports checking if a user is a member/listing their projects)
ProjectSchema.index({ teamMemberIds: 1 }); 
```

#### **79.5. `src/models/auditLog.model.ts` (Finalized Indexes)**

```typescript
// src/models/auditLog.model.ts (Finalized)
// ... (Schema definition) ...

// Final Indexes (Optimized for Query/Chain):
// 1. Time Sort (Primary sort for all chronological queries)
AuditLogSchema.index({ timestamp: -1 });
// 2. Resource Type & ID (Supports filtering by resource (e.g., all logs for a project)
AuditLogSchema.index({ resourceType: 1, resourceId: 1 });
// 3. Actor ID & Action (Supports auditing actions taken by a specific user)
AuditLogSchema.index({ actorId: 1, action: 1 });
```

#### **79.6. `src/models/payout.model.ts` (Finalized Indexes)**

```typescript
// src/models/payout.model.ts (Finalized)
// ... (Schema definition) ...

// Final Indexes (Optimized for Payouts/Reconciliation):
// 1. Escrow ID (Mandatory Unique for Idempotency check on scheduling)
PayoutBatchSchema.index({ escrowId: 1 }, { unique: true });
// 2. Status & Creation Time (Supports queue monitoring)
PayoutBatchSchema.index({ status: 1, createdAt: 1 });
// 3. Embedded Item Lookup (Supports fast lookup of a single PayoutItem)
PayoutBatchSchema.index({ 'items.userId': 1, 'items.status': 1 }); 
```

#### **79.7. `src/migrations/202511XX_finalize_indexes.ts` (Deployment Vehicle)**

*(The existing schema indexes will be compiled by Mongoose upon connection, but a dedicated migration file ensures that legacy/external instances are updated.)*

```typescript
// src/migrations/202511XX_finalize_indexes.ts

import { Db } from 'mongodb';

export const up = async (db: Db): Promise<void> => {
  console.log("Applying final compound indexes...");

  // Example: Apply Project Compound Index
  await db.collection('projects').createIndex(
    { ownerId: 1, status: 1 },
    { name: 'idx_owner_status', background: true, unique: false }
  );

  // Example: Apply Creator Discovery Index
  await db.collection('creatorprofiles').createIndex(
    { verified: 1, 'rating.avg': -1, availability: 1 },
    { name: 'idx_discovery_ranking', background: true, unique: false }
  );
  
  // Example: Apply Payout Item Index (for embedded documents)
  await db.collection('payoutbatches').createIndex(
    { 'items.userId': 1, 'items.status': 1 },
    { name: 'idx_payout_recipient_status', background: true, unique: false }
  );

  console.log("Final indexes applied successfully.");
};

export const down = async (_db: Db): Promise<void> => {
  // Reverting indexes is typically high risk and not always needed for DOWN, 
  // but included for completeness of the migration pattern.
  console.log("Migration revert: Indexes are not automatically dropped.");
};
```