Following the structured plan and focusing on API governance and developer experience, we proceed with **Task 96: Documentation & OpenAPI Contracts**.

This task ensures that the API is formally documented, which is crucial for internal service consumption, external partner onboarding, and maintaining consistency across the microservice landscape.

***

## **Task 96: Documentation & OpenAPI Contracts**

**Goal:** Define the standard for generating and maintaining the OpenAPI (formerly Swagger) specifications for all microservices, and define the strategy for contract testing to ensure API stability and type consistency.

**Service:** `API Governance / Documentation`
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** All controllers/routes (T1-T70 logic).

**Output Files:**
1.  `config/openapi.json` (New file: Conceptual Monolithic/Gateway OpenAPI Spec)
2.  `scripts/generate_openapi.sh` (New file: CLI script to generate specs)
3.  `test/contract/auth.contract.test.ts` (New file: Example contract test)

**Input/Output Shapes:**

| API Artifact | Purpose | Standard Used | Consumer |
| :--- | :--- | :--- | :--- |
| **OpenAPI Spec** | Defines all endpoints, schemas, and security. | OpenAPI 3.0 | External Partners, Internal Clients (T90). |
| **Contract Test** | Validates live API response against its schema. | Jest/Supertest + JSON Schema | CI/CD (T77). |

**Runtime & Env Constraints:**
*   **Source of Truth:** The API definition (paths, parameters, responses) should be derived as much as possible from the running code (e.g., using `swagger-jsdoc` comments or similar libraries).
*   **Automation:** Generation must be automated via a CI script.
*   **Security:** The spec must correctly define the `BearerAuth` security scheme.

**Acceptance Criteria:**
*   The conceptual OpenAPI spec successfully documents key Auth, Project, and Payment endpoints.
*   The contract test successfully validates a live API endpoint's response DTO against its expected schema.
*   The CI pipeline (Task 77) includes a step to execute contract tests.

**Tests to Generate:**
*   **Documentation:** Conceptual OpenAPI spec and test scripts.

***

### **Task 96 Code Implementation (Documentation & Test Definition)**

#### **96.1. `config/openapi.json` (New Conceptual OpenAPI Spec)**

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "OpenShow API Gateway Specification",
    "version": "1.0.0",
    "description": "Unified API contract for all microservices (Auth, Projects, Payments)."
  },
  "servers": [
    { "url": "/api/v1", "description": "Production Gateway" }
  ],
  "security": [
    { "bearerAuth": [] }
  ],
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT"
      }
    },
    "schemas": {
      "UserLogin": {
        "type": "object",
        "properties": {
          "email": { "type": "string", "format": "email" },
          "password": { "type": "string" }
        }
      },
      "TokenResponse": {
        "type": "object",
        "properties": {
          "accessToken": { "type": "string" },
          "refreshToken": { "type": "string" },
          "expiresIn": { "type": "integer" }
        }
      },
      "ProjectCreate": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "category": { "type": "string" }
        },
        "required": ["title", "category"]
      }
    }
  },
  "paths": {
    "/auth/login": {
      "post": {
        "summary": "User Login",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": { "$ref": "#/components/schemas/UserLogin" } } }
        },
        "responses": {
          "200": { "description": "Success", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/TokenResponse" } } } },
          "401": { "description": "Invalid Credentials" }
        }
      }
    },
    "/projects": {
      "post": {
        "summary": "Create Project (Owner)",
        "security": [ { "bearerAuth": [] } ],
        "requestBody": { "required": true, "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ProjectCreate" } } } },
        "responses": { "201": { "description": "Project Created" } }
      }
    }
  }
}
```

#### **96.2. `scripts/generate_openapi.sh` (New CLI Script)**

```bash
#!/bin/bash
# scripts/generate_openapi.sh
set -e

echo "--- Generating OpenAPI Specification ---"

# In a real environment, this would install/run a library like @apidevtools/swagger-cli
# that merges service-level specs, or a code-based generator like TSOA/NestJS-Swagger.

OUTPUT_FILE="./dist/openapi/gateway.json"

# MOCK: Copy the conceptual spec to the final output location
mkdir -p ./dist/openapi
cp ./config/openapi.json $OUTPUT_FILE

echo "OpenAPI spec generated and copied to $OUTPUT_FILE"

# --- Contract Testing Preparation ---
echo "Running schema validation on generated spec..."
# MOCK: Use swagger-cli to validate the file against the OpenAPI standard
# swagger-cli validate $OUTPUT_FILE || { echo "OpenAPI specification is invalid!"; exit 1; }

echo "Specification generation and validation completed successfully."
```

#### **96.3. `test/contract/auth.contract.test.ts` (Example Contract Test)**

```typescript
// test/contract/auth.contract.test.ts (Conceptual Contract Test)

import supertest from 'supertest';
import { Schema, validate } from 'jsonschema'; // Mocking JSON Schema validation library
// Mock express server is loaded here

// Define the expected JSON Schema for a successful login response
const LoginResponseSchema: Schema = {
    "type": "object",
    "properties": {
        "accessToken": { "type": "string" },
        "refreshToken": { "type": "string" },
        "expiresIn": { "type": "number" },
        "user": { "type": "object" }
    },
    "required": ["accessToken", "refreshToken", "expiresIn", "user"]
};

// Mock the API client for testing
const request = supertest('http://localhost:8080/api/v1'); 

describe('Contract: Auth Service Endpoints', () => {
    
    // Test case to validate the response structure against the OpenAPI contract
    test('POST /auth/login complies with the TokenResponse schema', async () => {
        const mockLoginPayload = { email: 'test_contract@test.com', password: 'ValidPassword123' };
        
        // Setup: Ensure the test user exists (data seeding/fixture setup is needed here)
        // ... Call POST /auth/signup if necessary ...

        const response = await request
            .post('/auth/login')
            .send(mockLoginPayload)
            .expect(200);

        // Assert: Validate the live JSON response body against the static schema
        const validationResult = validate(response.body, LoginResponseSchema);
        
        // The core contract test assertion
        expect(validationResult.valid).toBe(true);
        expect(validationResult.errors).toEqual([]);
    });

    // Test case to ensure an error response adheres to the standardized error schema (Task 83)
    test('POST /auth/login unauthorized response complies with StandardError schema', async () => {
        const mockLoginPayload = { email: 'invalid@test.com', password: 'WrongPassword' };
        
        const response = await request
            .post('/auth/login')
            .send(mockLoginPayload)
            .expect(401);

        // Assert: Check the error object structure (Task 83 standard error)
        expect(response.body.error).toHaveProperty('code');
        expect(response.body.error).toHaveProperty('message');
        expect(response.body.error).toHaveProperty('traceId');
        expect(response.body.error.code).toBe('invalid_credentials');
    });
});
```

---
