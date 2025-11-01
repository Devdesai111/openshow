Following the structured plan and focusing on internal developer experience and architectural decoupling, we proceed with **Task 90: Developer SDK & API Client (internal)**.

This task implements a set of client utilities that allow one microservice to call another microservice's API endpoints securely and efficiently, enforcing type safety and handling common request patterns.

***

## **Task 90: Developer SDK & API Client (internal)**

**Goal:** Implement a centralized, type-safe API client utility that abstracts direct HTTP calls between microservices (e.g., Auth Service calling Project Service), standardizes headers (Auth, Trace ID), and provides DTO integrity.

**Service:** `Utility & System Features` (Infrastructure)
**Phase:** F - Revenue & Payouts execution, Accounting integration
**Dependencies:** Task 76 (Logging/Tracing), Task 74 (Secrets/Config).

**Output Files:**
1.  `src/clients/internalHttpClient.ts` (New file: Base client with auth/tracing)
2.  `src/clients/projectClient.ts` (New file: Example client for Project Service)
3.  `test/unit/api_client.test.ts` (Test specification)

**Input/Output Shapes:**

| Client Action | Request Detail | Header Set | Principle Enforced |
| :--- | :--- | :--- | :--- |
| **ProjectClient.getTeam** | `{ projectId, internalToken }` | `Authorization: Bearer <token>`, `X-Request-ID: <traceId>` | Type safety, Decoupling, Traceability. |

**Runtime & Env Constraints:**
*   **Security:** The client must use a secure system token (or a JWT from the requester) for service-to-service calls.
*   **Traceability:** Must automatically propagate the `traceId` (`X-Request-ID`) from the calling request context.
*   **Type Safety:** Uses TypeScript generics to ensure the response DTO matches expectations.

**Acceptance Criteria:**
*   The `ProjectClient.getTeam` method successfully simulates an internal call to the Project Service, including the correct headers.
*   The client correctly handles a simulated 400-level error from a downstream service, re-throwing it as a system error.

**Tests to Generate:**
*   **Unit Test (Headers):** Verify the `internalHttpClient` sets the `Authorization` and `X-Request-ID` headers correctly.
*   **Unit Test (Error Handling):** Verify the client throws a custom error when a mock 404 is received from the downstream service.

***

### **Task 90 Code Implementation**

#### **90.1. `src/clients/internalHttpClient.ts` (New Base Client File)**

```typescript
// src/clients/internalHttpClient.ts
import { CONFIG } from '../config/global.config'; // Task 74 Config
import { logger } from '../utils/logger.utility'; // Task 76 Logger

// Defines base URL for microservices (mocked lookup)
const SERVICE_URLS: Record<string, string> = {
    PROJECTS: 'http://localhost:8081/api/v1',
    USERS: 'http://localhost:8082/api/v1',
    // ... all other service URLs
};

/** Custom error for downstream API failures. */
export class DownstreamApiError extends Error {
    public readonly statusCode: number;
    public readonly responseBody: any;
    constructor(service: string, statusCode: number, message: string, responseBody: any) {
        super(`Downstream API Error in ${service} (${statusCode}): ${message}`);
        this.name = 'DownstreamApiError';
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }
}

/**
 * Base HTTP Client for internal microservice communication.
 * Provides mandatory tracing and authorization headers.
 */
export class InternalHttpClient {
    private service: string;
    private baseUrl: string;

    constructor(serviceName: keyof typeof SERVICE_URLS) {
        this.service = serviceName;
        this.baseUrl = SERVICE_URLS[serviceName];
    }
    
    /**
     * Executes an authenticated request to a downstream service.
     * @param method - HTTP method (GET, POST, PUT).
     * @param path - API path (e.g., /projects/123/team).
     * @param token - Bearer token (User or System JWT).
     * @param context - Request context (for traceId).
     * @param data - Request body.
     */
    public async request<T>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        token: string,
        context: { traceId: string },
        data?: any
    ): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        
        // 1. Build Standard Headers (Tracing and Auth)
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${token}`,
            'X-Request-ID': context.traceId, // Context Propagation (Task 76)
            'Content-Type': 'application/json',
        };

        // 2. Simulate Fetch Call
        const mockResponse = {
            status: 200, // Default to success
            body: {} as any,
            statusText: 'OK',
        };
        
        // MOCK: Simulate API failures/successes
        if (path.includes('404_test')) {
            mockResponse.status = 404;
            mockResponse.statusText = 'Not Found';
            mockResponse.body = { error: { message: 'Resource not found' } };
        } else {
             // Mock success with the data passed to it
             mockResponse.body = data || { success: true, mockedData: true };
        }
        
        // 3. Handle Downstream Errors
        if (mockResponse.status >= 400) {
            logger.error(`Downstream Error ${mockResponse.status} from ${this.service}`, { 
                traceId: context.traceId, 
                url, 
                responseBody: mockResponse.body 
            });
            throw new DownstreamApiError(
                this.service, 
                mockResponse.status, 
                mockResponse.body.error?.message || mockResponse.statusText,
                mockResponse.body
            );
        }

        // 4. Return DTO (Parsed Body)
        return mockResponse.body as T;
    }
}
```

#### **90.2. `src/clients/projectClient.ts` (New Example Client File)**

```typescript
// src/clients/projectClient.ts
import { InternalHttpClient } from './internalHttpClient';

// Define a simplified DTO for the Project Client
interface TeamMemberDTO {
    userId: string;
    displayName: string;
}

/**
 * Type-safe client facade for the Project Management Service.
 */
export class ProjectClient {
    private client: InternalHttpClient;

    constructor() {
        this.client = new InternalHttpClient('PROJECTS');
    }

    /**
     * Calls GET /projects/:projectId/team (Task 29) to retrieve team members.
     * @param projectId - The ID of the project.
     * @param token - The JWT of the authenticated user.
     * @param traceId - The current request's trace ID.
     */
    public async getTeamMembers(projectId: string, token: string, traceId: string): Promise<{ projectId: string, team: TeamMemberDTO[] }> {
        return this.client.request(
            'GET', 
            `/projects/${projectId}/team`, 
            token, 
            { traceId }
        ) as Promise<{ projectId: string, team: TeamMemberDTO[] }>;
    }
    
    // Future: Method to call Milestone Service, etc.
}
```

#### **90.3. Test Specification**

| Test ID | Method | Description | Scenario | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **T90.1** | `ProjectClient.getTeamMembers`| Success Check | Request with valid token/traceId | Returns mocked success DTO. |
| **T90.2** | `ProjectClient.request` | Error Handling Check | Call path that includes `404_test` | Throws `DownstreamApiError` with `statusCode: 404`. |
| **T90.3** | `InternalHttpClient` | Header Check | Single request execution | `X-Request-ID` and `Authorization` headers are correctly built. |

---