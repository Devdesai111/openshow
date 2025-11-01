Following the structured plan and focusing on database reliability, we proceed with **Task 78: Database Schema Migrations & Versioning**.

This task implements the standard mechanism for managing schema changes in a non-relational database like MongoDB, ensuring controlled and reversible updates to the application's data structure as the project evolves.

***

## **Task 78: Database Schema Migrations & Versioning**

**Goal:** Implement the standard file structure and a CLI script interface using a library pattern (like `migrate-mongo` or `umzug`) to manage database schema migrations, ensuring that changes are auditable and reversible.

**Service:** `Database / Infrastructure`
**Phase:** A - Foundations
**Dependencies:** None (Infrastructure Foundation).

**Output Files:**
1.  `config/migrate-mongo-config.js` (New file: Configuration for the migration tool)
2.  `scripts/cli_migrate.sh` (New file: CLI interface script)
3.  `src/migrations/20251101_addCreatorProfileIndex.ts` (New file: Example migration file)
4.  `test/integration/migration_test.test.ts` (Test specification)

**Input/Output Shapes:**

| CLI Command | Action | Success Metric | Failure Condition |
| :--- | :--- | :--- | :--- |
| `npm run migrate:up` | Runs pending UP scripts. | All UP scripts execute successfully. | Script fails, throws error. |
| `npm run migrate:down` | Reverts the last batch of migrations. | Last applied batch is reversed. | No migrations to revert. |
| `npm run migrate:create` | Creates a new dated migration file. | New file created in `src/migrations/`. | N/A. |

**Runtime & Env Constraints:**
*   **Safety:** Migrations must be transactional where possible (e.g., in a replica set environment) or operate on a fail-fast/recoverable principle.
*   **Idempotency:** Migration scripts must be designed to be safely run multiple times without causing data duplication/corruption.

**Acceptance Criteria:**
*   The system successfully creates an executable example migration file.
*   The CLI script allows an operator to apply and revert migrations easily.
*   The migration tool stores metadata (which scripts ran, when) in the database.

**Tests to Generate:**
*   **Integration Test (CLI Flow):** Test running `migrate:up` and `migrate:down` on a test database and verify the schema change (e.g., a new index or field) is applied and then removed.

***

### **Task 78 Code Implementation**

#### **78.1. `config/migrate-mongo-config.js` (New Migration Config)**

```javascript
// config/migrate-mongo-config.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const config = {
  mongodb: {
    // Standard connection string setup
    url: process.env.MONGODB_URL || "mongodb://mongo:27017", 
    databaseName: process.env.DB_NAME || "openshow_db",

    options: {
      useNewUrlParser: true, // Use new URL parser
      useUnifiedTopology: true, // Use new server discovery
      maxPoolSize: 10,
    },
  },

  // Directory where the migration files are located
  migrationsDir: "src/migrations",

  // Name of the database collection where the migrations log will be stored
  changelogCollectionName: "migrations_log",

  // Ensures migration files are executed chronologically
  migrationFileExtension: ".ts",

  // Use TypeScript transpiler during migration execution
  // NOTE: This requires 'ts-node' to be set up correctly in the CLI script
  moduleSystem: "commonjs",
};

module.exports = config;
```

#### **78.2. `src/migrations/20251101_addCreatorProfileIndex.ts` (Example Migration)**

```typescript
// src/migrations/20251101_addCreatorProfileIndex.ts

import { Db } from 'mongodb';

export const up = async (db: Db): Promise<void> => {
  // UP: Add a compound index to speed up creator search queries by role and verified status
  await db.collection('creatorprofiles').createIndex(
    { role: 1, verified: 1, 'rating.avg': -1 },
    { name: 'idx_creator_discovery_20251101' }
  );
  
  // Example data manipulation: Set default value for a new field
  await db.collection('users').updateMany(
    { isMfaRequired: { $exists: false } },
    { $set: { isMfaRequired: false } }
  );
};

export const down = async (db: Db): Promise<void> => {
  // DOWN: Remove the index created in the 'up' function
  await db.collection('creatorprofiles').dropIndex('idx_creator_discovery_20251101');
  
  // Revert data manipulation (if necessary, often complex/risky)
  await db.collection('users').updateMany(
    { isMfaRequired: { $exists: true } },
    { $unset: { isMfaRequired: "" } }
  );
};
```

#### **78.3. `scripts/cli_migrate.sh` (New CLI Script)**

```bash
#!/bin/bash
# scripts/cli_migrate.sh
set -e

# Load necessary configurations
MIGRATE_CONFIG="./config/migrate-mongo-config.js"

# Check if the command is provided
if [ -z "$1" ]; then
    echo "Usage: ./scripts/cli_migrate.sh [up|down|status|create] [migration_name]"
    exit 1
fi

COMMAND=$1
MIGRATION_NAME=$2

# Ensure ts-node is used for running the migration CLI
TS_NODE_BIN="./node_modules/.bin/ts-node"
MIGRATE_BIN="./node_modules/.bin/migrate-mongo"

# Check if required tools exist
if [ ! -f "$TS_NODE_BIN" ]; then
    echo "Error: ts-node not found. Did you run 'npm install'?"
    exit 1
fi
if [ ! -f "$MIGRATE_BIN" ]; then
    echo "Error: migrate-mongo not found. Did you run 'npm install'?"
    exit 1
fi

echo "--- Running MongoDB Migration: $COMMAND ---"

if [ "$COMMAND" = "create" ]; then
    if [ -z "$MIGRATION_NAME" ]; then
        echo "Error: Migration name is required for 'create'."
        exit 1
    fi
    # Use ts-node to run the create command
    $TS_NODE_BIN $MIGRATE_BIN $COMMAND $MIGRATION_NAME --config $MIGRATE_CONFIG
elif [ "$COMMAND" = "up" ] || [ "$COMMAND" = "down" ] || [ "$COMMAND" = "status" ]; then
    # Run other commands
    $TS_NODE_BIN $MIGRATE_BIN $COMMAND --config $MIGRATE_CONFIG
else
    echo "Error: Invalid command. Must be 'up', 'down', 'status', or 'create'."
    exit 1
fi

echo "--- Migration Command Completed ---"
```

#### **78.4. Test Specification**

| Test ID | Method | Description | Command | Expected State Check |
| :--- | :--- | :--- | :--- | :--- |
| **T78.1** | `CLI Script` | Create Migration | `./cli_migrate.sh create test_migration` | File named `YYYYMMDD_test_migration.ts` created. |
| **T78.2** | `CLI Script` | Apply UP | `./cli_migrate.sh up` | `creatorprofiles` collection has the `idx_creator_discovery_20251101` index. |
| **T78.3** | `CLI Script` | Apply DOWN | `./cli_migrate.sh down` | `creatorprofiles` collection no longer has the custom index. |
| **T78.4** | `CLI Script` | Check Status | `./cli_migrate.sh status` | Reports the migration as `DOWN`. |

---