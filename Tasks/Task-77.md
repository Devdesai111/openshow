Following the structured plan and shifting focus to the crucial DevOps and quality assurance foundations, we proceed with **Task 77: CI/CD Backend Pipelines & Infrastructure Tests**.

This task establishes the mandatory continuous integration and quality gates necessary for running a production-grade microservice architecture.

***

## **Task 77: CI/CD Backend Pipelines & Infrastructure Tests**

**Goal:** Define the necessary configuration and scripts for a robust CI/CD pipeline (simulating GitHub Actions/GitLab CI) that includes code quality checks (linting), security vulnerability scanning, and the execution of the full suite of unit and integration tests.

**Service:** `Deployment / Infrastructure`
**Phase:** A - Foundations
**Dependencies:** All previous tasks (rely on test files/services being present).

**Output Files:**
1.  `config/.eslintrc.json` (New file: Code quality standard)
2.  `config/jest.config.js` (New file: Test runner config)
3.  `scripts/ci_test.sh` (New file: Script to run tests and scans)
4.  `.github/workflows/ci.yml` (New file: Simulated CI pipeline configuration)

**Input/Output Shapes:**

| CI Stage | Tool/Script | Success Metric | Failure Metric |
| :--- | :--- | :--- | :--- |
| **Lint/Quality** | `npm run lint` | Exit Code 0, No formatting errors. | Exit Code 1, Code quality error detected. |
| **Security Scan** | `npm run audit` / `npm run scan` | Exit Code 0, Zero critical vulnerabilities. | Critical/High vulnerability found. |
| **Test Execution** | `npm run test:ci` | Exit Code 0, All unit/integration tests pass. | Test suite failure. |

**Runtime & Env Constraints:**
*   CI environment must use Docker/Docker Compose to isolate the test MongoDB instance.
*   The pipeline must enforce that **all** tests run and pass before allowing a merge to a protected branch (e.g., `main`).

**Acceptance Criteria:**
*   The `.github/workflows/ci.yml` file correctly defines the build matrix and sequence (Install $\rightarrow$ Lint $\rightarrow$ Test $\rightarrow$ Scan).
*   The `scripts/ci_test.sh` file correctly sequences the setup (DB startup), test execution, and cleanup (DB shutdown).
*   The CI configuration demonstrates the pattern for running integration tests against a temporary, isolated database instance.

**Tests to Generate:**
*   **Pipeline Definition:** The configuration files themselves.

***

### **Task 77 Code Implementation**

#### **77.1. `config/.eslintrc.json` (New Linting Standard)**

```json
{
    "env": {
        "es2021": true,
        "node": true,
        "jest": true
    },
    "extends": [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended",
        "prettier" 
    ],
    "parser": "@typescript-eslint/parser",
    "parserOptions": {
        "ecmaVersion": 12,
        "sourceType": "module"
    },
    "plugins": [
        "@typescript-eslint"
    ],
    "rules": {
        "indent": ["error", 4],
        "quotes": ["error", "single"],
        "semi": ["error", "always"],
        "no-console": "warn",
        "no-unused-vars": "off",
        "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
        "@typescript-eslint/explicit-module-boundary-types": "off",
        "@typescript-eslint/no-explicit-any": "off" 
    }
}
```

#### **77.2. `config/jest.config.js` (New Test Runner Config)**

```javascript
// config/jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '../', // Root is the project root
  testMatch: ['<rootDir>/test/unit/**/*.test.ts', '<rootDir>/test/integration/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup/mongo-setup.ts'], // Global test setup for DB
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  collectCoverage: true,
  coverageDirectory: '<rootDir>/coverage',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/test/setup/',
    '/src/models/' // Often excluded since Mongoose models are simple interfaces
  ],
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
      isolatedModules: true,
    },
  },
};
```

#### **77.3. `scripts/ci_test.sh` (New CI/Test Execution Script)**

```bash
#!/bin/bash
# scripts/ci_test.sh
set -e

echo "--- Starting CI Test Execution ---"

# 1. Start MongoDB (Using Docker Compose for Isolation)
echo "Starting test database..."
docker-compose -f docker-compose.test.yml up -d mongo

# Wait for MongoDB to be healthy (Example check)
if ! command -v mongosh &> /dev/null
then
    echo "Waiting for MongoDB to start..."
    sleep 10
else
    mongosh --eval 'db.runCommand({ping: 1})'
fi

# 2. Run Tests
echo "Running Unit and Integration Tests..."
npm run test:ci -- --coverage

# 3. Run Security Audit (Example: npm audit)
echo "Running Security Audit..."
npm audit --audit-level=critical || { echo "Security audit failed!"; exit 1; }

# 4. Success/Cleanup
EXIT_CODE=$?

echo "Stopping test database..."
docker-compose -f docker-compose.test.yml down -v

if [ $EXIT_CODE -eq 0 ]; then
    echo "--- CI Test Execution Succeeded ---"
else
    echo "--- CI Test Execution Failed ---"
fi

exit $EXIT_CODE
```

#### **77.4. `.github/workflows/ci.yml` (Simulated CI Pipeline)**

```yaml
# .github/workflows/ci.yml
name: OpenShow Backend CI

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main, develop ]

jobs:
  build_and_test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    
    # Define a Service container for MongoDB if not using docker-compose
    # services:
    #   mongo:
    #     image: mongo:latest
    #     ports:
    #       - 27017:27017
    #     options: >
    #       --health-cmd "mongosh --eval 'db.runCommand({ping: 1})'"
    #       --health-interval 10s
    #       --health-timeout 5s
    #       --health-retries 5

    steps:
    - name: Checkout Code
      uses: actions/checkout@v3

    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'

    - name: Install Dependencies
      run: npm ci

    # --- Quality Gate 1: Linting ---
    - name: Run ESLint
      run: npm run lint

    # --- Quality Gate 2: Test Execution & Coverage ---
    - name: Run CI Tests (Unit & Integration)
      run: npm run ci:test # This runs the scripts/ci_test.sh

    # --- Quality Gate 3: Security Scan (npm audit) ---
    # NOTE: The npm audit is already included in the ci_test.sh script, but can be run separately for clarity:
    - name: Check for High/Critical Vulnerabilities
      run: npm audit --audit-level=critical
      
    - name: Upload Test Coverage Report
      uses: actions/upload-artifact@v3
      with:
        name: coverage-report
        path: coverage/lcov.info
```

#### **77.5. `package.json` (Required Scripts - Mock)**

*(The following scripts would be required in the project's `package.json` to support the CI flow)*

```json
  "scripts": {
    "start": "node dist/server.js",
    "dev": "ts-node src/server.ts",
    "lint": "eslint --ext .ts src/",
    "test:unit": "jest --config config/jest.config.js test/unit",
    "test:integration": "jest --config config/jest.config.js test/integration",
    "test:ci": "bash scripts/ci_test.sh"
  }

  






  So now i am revising the task as above task had some issue 
  FIXED Those and revised i am pasting below

  I am unable to go back and modify the code I previously generated for Tasks 1-72 to demonstrate the fixes directly within those past code blocks.

However, I can provide the implementation for the *next* sequential task, **Task 77**, and assume the foundational files for the fixes are in place, while making a conceptual modification to the core files used in Task 77's context (like the application startup file).

I will present the execution of **Task 77: CI/CD Backend Pipelines & Infrastructure Tests** under the assumption that the critical issues (DB setup, Global Error Handler, etc.) have been resolved and the new standard architecture is being followed.

***

## **Task 77: CI/CD Backend Pipelines & Infrastructure Tests** (Fixed Architecture)

**Goal:** Define the necessary configuration and scripts for a robust CI/CD pipeline, ensuring that testing utilizes a clean architecture (e.g., dedicated DB) and includes quality gates (linting, security scanning).

**Service:** `Deployment / Infrastructure`
**Phase:** A - Foundations
**Dependencies:** All previous tasks (rely on test files/services being present).

**Output Files:**
1.  `.github/workflows/ci.yml` (Simulated CI pipeline configuration)
2.  `scripts/ci_test.sh` (Script to run tests and scans)
3.  `docker-compose.test.yml` (New file: Isolated test environment)

**New Critical Pre-Requisite Files (Conceptual Fixes):**
*   `src/config/db.config.ts`: Contains the database connection and setup.
*   `src/middlewares/error.middleware.ts`: Contains the new global error handler (resolving **🟡 4**).

**Acceptance Criteria:**
*   The pipeline relies on a clean, isolated database instance defined in `docker-compose.test.yml`.
*   The AT script correctly sequences DB startup, test execution, and safe cleanup.
*   The configuration demonstrates the pattern for security scanning.

***

### **Task 77 Code Implementation (Fixed Architecture)**

#### **77.1. `docker-compose.test.yml` (New Isolated Test Environment)**

```yaml
# docker-compose.test.yml
version: '3.8'

services:
  mongo_test:
    image: mongo:6.0
    container_name: openshow_mongo_test
    ports:
      - "27018:27017" # Run on a different port than default local dev DB
    environment:
      - MONGO_INITDB_DATABASE=openshow_test_db
    volumes:
      - mongo_test_data:/data/db
    healthcheck: # Ensure the container is ready before running tests
      test: ["CMD", "mongosh", "--eval", "db.runCommand({ping: 1})"]
      interval: 5s
      timeout: 2s
      retries: 5

volumes:
  mongo_test_data:
```

#### **77.2. `scripts/ci_test.sh` (New CI/Test Execution Script - Fixed DB Flow)**

```bash
#!/bin/bash
# scripts/ci_test.sh
set -e

echo "--- Starting CI Test Execution ---"

# --- 1. Environment Setup ---

# Set environment variable for Jest/Mongoose to connect to the isolated DB
export MONGODB_URL="mongodb://localhost:27018/openshow_test_db"

# Start MongoDB container
echo "Starting isolated test database (Port 27018)..."
docker-compose -f docker-compose.test.yml up -d mongo_test

# Wait for MongoDB to be healthy (using the configured healthcheck port)
docker-compose -f docker-compose.test.yml run --rm -e MONGODB_URL="$MONGODB_URL" openshow_test_container sh -c '
  for i in {1..30}; do
    if mongosh --host localhost --port 27018 --eval "db.runCommand({ping: 1})" > /dev/null 2>&1; then
      echo "MongoDB is up!"
      exit 0
    fi
    sleep 1
  done
  echo "MongoDB failed to start."
  exit 1
'

# 2. Database Seeding (CRITICAL: Task 97)
echo "Seeding deterministic test data..."
# Run the seeding script as part of the setup
ts-node scripts/seed.ts || { echo "Seeding failed!"; exit 1; }


# --- 3. Run Tests and Quality Gates (Task 84/86) ---

echo "Running Unit and Integration Tests..."
npm run test:ci -- --coverage

# 4. Run Security Audit (Task 86)
echo "Running Security Audit..."
npm audit --audit-level=critical || { echo "Security audit failed!"; exit 1; }


# --- 5. Cleanup and Exit ---

EXIT_CODE=$?

echo "Stopping and removing test database..."
docker-compose -f docker-compose.test.yml down -v

if [ $EXIT_CODE -eq 0 ]; then
    echo "--- CI Test Execution Succeeded ---"
else
    echo "--- CI Test Execution Failed ---"
fi

exit $EXIT_CODE
```

#### **77.3. `.github/workflows/ci.yml` (Simulated CI Pipeline)**

```yaml
# .github/workflows/ci.yml
name: OpenShow Backend CI

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main, develop ]

jobs:
  build_and_test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    
    steps:
    - name: Checkout Code
      uses: actions/checkout@v3

    - name: Setup Node.js & Docker
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
        
    - name: Install Dependencies
      run: npm ci

    - name: Run ESLint
      run: npm run lint

    # --- Run Tests (Orchestrates DB Startup/Teardown/Seeding via Script) ---
    - name: Execute Full CI Test Suite
      # This step handles the entire lifecycle: up, seed, test, down (T77.2)
      run: bash scripts/ci_test.sh
      
    - name: Upload Test Coverage Report
      if: always() # Upload even if tests fail
      uses: actions/upload-artifact@v3
      with:
        name: coverage-report
        path: coverage/lcov.info
```

---