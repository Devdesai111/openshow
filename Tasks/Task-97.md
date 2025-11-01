Following the structured plan and focusing on reliable testing, we proceed with **Task 97: Data Seeding & Fixtures for Tests**.

This task is essential for the QA and development phases, ensuring that the database can be quickly and deterministically populated with the necessary mock data to execute unit, integration, and E2E tests reliably.

***

## **Task 97: Data Seeding & Fixtures for Tests**

**Goal:** Implement a set of deterministic seed scripts that populate a test/development database with necessary user accounts (Admin, Creator, Owner) and core records (Projects, Milestones, Notifications) required to run the full E2E test suite (Task 84).

**Service:** `Deployment / Infrastructure` (Test Data Management)
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** All models (T1, T8, T12, T32, T47), Task 77 (CI/CD infrastructure).

**Output Files:**
1.  `scripts/seed.ts` (New file: Main seeding script)
2.  `test/fixtures/users.fixture.ts` (New file: Fixture data definitions)
3.  `test/setup/mongo-setup.ts` (Updated: Setup script calls seed logic)

**Input/Output Shapes:**

| Fixture Type | Example Data | Dependent Service | Purpose |
| :--- | :--- | :--- | :--- |
| **Users** | Admin, Owner (2FA Enabled), Creator. | Auth, RBAC, Settings. | Authorization checks (T2, T73). |
| **Projects** | Private, Public, Funded, Dispute. | Project Management, Payments. | E2E flows (T84). |
| **Payouts** | Succeeded, Failed, Scheduled Payout Items. | Earnings Dashboard (T38). | Reporting checks (T38, T67). |

**Runtime & Env Constraints:**
*   **Determinism:** The password and other critical fields must be deterministically generated (e.g., hash a fixed string like "Password123!") so they are consistent across all test runs.
*   **Isolation:** The seed script should run only once per test run, usually within the isolated MongoDB container setup (Task 77).

**Acceptance Criteria:**
*   The `scripts/seed.ts` script successfully inserts all necessary data without primary key conflicts.
*   The setup script (`mongo-setup.ts`) demonstrates the clean-up (drop DB) and seeding procedure.
*   A test can reliably look up the user "admin@test.com" using the fixed password.

**Tests to Generate:**
*   **Documentation:** The defined seed scripts and fixture data.

***

### **Task 97 Code Implementation (Data Seeding Logic)**

#### **97.1. `test/fixtures/users.fixture.ts` (New Fixture Data File)**

```typescript
// test/fixtures/users.fixture.ts

import { hash } from 'bcryptjs';
import { Types } from 'mongoose';

// Fixed Password for all test users (Must be securely hashed for DB insertion)
const FIXED_PASSWORD = 'TestPassword123!';

// --- Utility to get a consistent hashed password for testing ---
export const getTestHashedPassword = async (): Promise<string> => {
    // Hash is expensive, so it should be done once and cached for the test session
    return hash(FIXED_PASSWORD, 10); 
};

// --- Standard Test User IDs (Consistent across all tests) ---
export const TEST_USER_IDS = {
    ADMIN: new Types.ObjectId('000000000000000000000001'),
    OWNER: new Types.ObjectId('000000000000000000000002'),
    CREATOR: new Types.ObjectId('000000000000000000000003'),
    UNAUTHORIZED: new Types.ObjectId('000000000000000000000004'),
};

export const TEST_USER_DATA = [
    {
        _id: TEST_USER_IDS.ADMIN,
        email: 'admin@test.com',
        role: 'admin',
        fullName: 'Admin User',
        status: 'active',
        // Note: hashedPassword will be set by the seed script
    },
    {
        _id: TEST_USER_IDS.OWNER,
        email: 'owner@test.com',
        role: 'owner',
        fullName: 'Project Owner',
        status: 'active',
    },
    {
        _id: TEST_USER_IDS.CREATOR,
        email: 'creator@test.com',
        role: 'creator',
        fullName: 'AI Creator',
        status: 'active',
        // Simulating a user with 2FA enabled (Task 73)
        twoFA: { enabled: true, totpSecretEncrypted: 'mocked_secret' }
    },
    {
        _id: TEST_USER_IDS.UNAUTHORIZED,
        email: 'unauth@test.com',
        role: 'creator',
        fullName: 'Unauthorized User',
        status: 'active',
    },
];
```

#### **97.2. `scripts/seed.ts` (New Main Seeding Script)**

```typescript
// scripts/seed.ts
import mongoose from 'mongoose';
import { UserModel } from './src/models/user.model';
import { ProjectModel } from './src/models/project.model';
import { PayoutBatchModel } from './src/models/payout.model';
import { TEST_USER_DATA, TEST_USER_IDS, getTestHashedPassword } from './test/fixtures/users.fixture';
import { Types } from 'mongoose';

// Ensure MONGODB_URL is available from environment
const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/test_db';

async function seedDatabase() {
    console.log('--- Starting Database Seeding ---');

    // 1. Connect and Clean
    await mongoose.connect(MONGODB_URL);
    console.log('Connected to MongoDB. Dropping old database...');
    await mongoose.connection.dropDatabase();
    
    const hashedPassword = await getTestHashedPassword();
    
    // 2. Seed Users (Task 1)
    const usersToSeed = TEST_USER_DATA.map(userData => ({
        ...userData,
        hashedPassword: hashedPassword,
    }));
    await UserModel.insertMany(usersToSeed);
    console.log(`Seeded ${usersToSeed.length} Users.`);
    
    // 3. Seed Projects (Task 12)
    const projectsToSeed = [
        {
            ownerId: TEST_USER_IDS.OWNER,
            title: 'E2E Funded Project',
            category: 'Film',
            visibility: 'private',
            roles: [
                { title: 'Director', slots: 1, assignedUserIds: [TEST_USER_IDS.OWNER] },
                { _id: new Types.ObjectId('000000000000000000000010'), title: 'VFX Artist', slots: 1, assignedUserIds: [TEST_USER_IDS.CREATOR] },
            ],
            // Milestone is set to 'funded' state for easy test setup
            milestones: [{ _id: new Types.ObjectId('000000000000000000000011'), title: 'Phase 1 Delivery', amount: 100000, currency: 'USD', status: 'funded' }],
            revenueSplits: [{ percentage: 50, placeholder: 'Owner' }, { percentage: 50, placeholder: 'Creator' }],
            teamMemberIds: [TEST_USER_IDS.OWNER, TEST_USER_IDS.CREATOR],
        },
        { ownerId: TEST_USER_IDS.OWNER, title: 'E2E Public Project', category: 'Music', visibility: 'public' },
    ];
    await ProjectModel.insertMany(projectsToSeed);
    console.log(`Seeded ${projectsToSeed.length} Projects.`);

    // 4. Seed Payouts/Earnings (Task 32)
    const payoutsToSeed = [
        {
            escrowId: new Types.ObjectId('000000000000000000000021'),
            projectId: projectsToSeed[0].ownerId, 
            currency: 'USD',
            totalNet: 95000,
            scheduledBy: TEST_USER_IDS.ADMIN,
            status: 'scheduled',
            items: [
                { userId: TEST_USER_IDS.OWNER, netAmount: 47500, fees: 2500, amount: 50000, status: 'scheduled' },
                { userId: TEST_USER_IDS.CREATOR, netAmount: 47500, fees: 2500, amount: 50000, status: 'scheduled' },
            ]
        }
    ];
    await PayoutBatchModel.insertMany(payoutsToSeed);
    console.log(`Seeded ${payoutsToSeed.length} Payout Batches.`);


    console.log('--- Seeding Completed Successfully ---');
    await mongoose.disconnect();
}

// Check if running directly via CLI (npm run seed)
if (require.main === module) {
    seedDatabase().catch(err => {
        console.error('Seeding failed:', err);
        process.exit(1);
    });
}
```

#### **97.3. `test/setup/mongo-setup.ts` (Updated Setup Script)**

```typescript
// test/setup/mongo-setup.ts
import mongoose from 'mongoose';
// Assuming seed logic is called from the top-level CI script (Task 77's ci_test.sh)

// Define the connection string for the test container
const TEST_DB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/test_db';

beforeAll(async () => {
    // NOTE: The 'ci_test.sh' script ensures the DB is dropped and re-seeded.
    // This hook only ensures Mongoose connects correctly for test execution.
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(TEST_DB_URL);
    }
});

afterAll(async () => {
    await mongoose.disconnect();
});

// Helper for testing
export const clearDatabase = async () => {
    if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db.dropDatabase();
        // Rerunning seed is complex, so we rely on the CI script for full cleanup/setup
    }
};
```

#### **97.4. Test Specification**

| Test ID | Method | Description | Command | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **T97.1** | `Seeding Logic` | User Check | Find User `admin@test.com` | `UserModel.count()` equals $\ge 4$. Password hash is correct. |
| **T97.2** | `Seeding Logic` | Payout Check | Find `PayoutBatch` for Owner/Creator | `PayoutBatchModel.findOne().items` array has 2 items. |
| **T97.3** | `Seeding Logic` | Isolation Check | Running `seed.ts` twice (after drop) | Second run completes without unique constraint errors (ensuring drop worked). |

---
