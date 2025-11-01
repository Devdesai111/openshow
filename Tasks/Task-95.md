Following the structured plan and finalizing the external traffic management layer, we proceed with **Task 95: API Gateway & Rate-Limit Integration**.

This task implements the final structural piece of the API's security perimeter, defining the role of the external gateway and ensuring that the internal rate-limiting middleware (Task 70) is correctly configured to use the client IP provided by the gateway.

***

## **Task 95: API Gateway & Rate-Limit Integration**

**Goal:** Define the final application middleware structure that correctly extracts the client's original IP address from proxy headers (like `X-Forwarded-For`), and document the routing strategy for the external API Gateway (e.g., Kong, Nginx, or AWS API Gateway).

**Service:** `Deployment / Infrastructure` (Routing/Security)
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 70 (Rate Limiting Middleware), Task 76 (Tracing Middleware).

**Output Files:**
1.  `src/middlewares/proxy.middleware.ts` (New file: IP extraction and trust configuration)
2.  `src/server.ts` (Mocked file: Application start/middleware loading order)
3.  `documentation/gateway_routing.md` (New file: Routing and header documentation)
4.  `test/unit/proxy_check.test.ts` (Test specification)

**Input/Output Shapes:**

| Component | Input (Header) | Output (Express Property) | Purpose |
| :--- | :--- | :--- | :--- |
| **Proxy Middleware** | `X-Forwarded-For: 192.168.1.1, 203.0.113.1` | `req.ip` $\rightarrow$ `203.0.113.1` (Client IP) | Accurate Rate Limiting (T70). |

**Runtime & Env Constraints:**
*   **Security (CRITICAL):** Trusting the proxy header is dangerous. Express must be configured to only trust the IP addresses of the known, immediate external proxy/gateway.
*   **Middleware Order:** IP extraction must occur **before** the Rate Limiter (Task 70) to ensure the correct client IP is used for throttling.

**Acceptance Criteria:**
*   The middleware successfully extracts the true client IP from the `X-Forwarded-For` header chain.
*   The application startup file demonstrates the correct, production-grade ordering of the security middlewares: Tracing $\rightarrow$ IP Trust $\rightarrow$ Auth $\rightarrow$ Rate Limit $\rightarrow$ Routes $\rightarrow$ Error Handling.

**Tests to Generate:**
*   **Unit Test (IP Extraction):** Test a mock request with a multi-IP `X-Forwarded-For` header and verify Express `req.ip` is the client IP.

***

### **Task 95 Code Implementation**

#### **95.1. `src/middlewares/proxy.middleware.ts` (New IP Trust File)**

```typescript
// src/middlewares/proxy.middleware.ts
import { Request, Response, NextFunction } from 'express';

// NOTE: This file focuses on the Express configuration strategy required for production.

// 1. Setting Trust Proxy in Express (Done in src/server.ts, requires Express instance)
// expressApp.set('trust proxy', 'loopback'); // Example: Trust only the local host/load balancer

/**
 * Custom middleware to log the client's IP and ensure it is available.
 * CRITICAL: This is primarily a documentation step for the Ops team.
 */
export const ipTrustLogger = (req: Request, res: Response, next: NextFunction) => {
    // If 'trust proxy' is set correctly in Express, req.ip will be the client IP.
    // If it's not set, req.ip will be the immediate proxy's IP.
    
    const clientIP = req.ip;
    const forwardedFor = req.header('x-forwarded-for') || 'N/A';
    
    // Log the IP chain for security auditing
    logger.info('Client IP Chain Check', { 
        traceId: req.traceId, 
        clientIP: clientIP, 
        forwardedFor: forwardedFor 
    });

    next();
};
```

#### **95.2. `src/server.ts` (Mocked Application Start - Illustrative)**

```typescript
// src/server.ts (Mock - Final Application Startup File)
import express from 'express';
import { tracingMiddleware } from './middlewares/tracing.middleware'; // T76
import { rateLimiter } from './middlewares/rateLimit.middleware';   // T70
import { globalErrorHandler, notFoundHandler } from './middlewares/error.middleware'; // T83
import { authenticate } from './middlewares/auth.middleware'; // T2
import { ipTrustLogger } from './middlewares/proxy.middleware'; // T95
import authRoutes from './routes/auth.routes';
import { AUTH_WRITE_LIMIT } from './config/rateLimits';

const app = express();

// --- CRITICAL CONFIGURATION: Trust Proxy ---
// Trust the FIRST hop (Load Balancer/Gateway) which adds the X-Forwarded-For header.
// NOTE: Must be a list of trusted IPs/Subnets in production.
app.set('trust proxy', 1); // Trust first proxy hop

// --- MIDDLEWARE STACK ORDER (CRITICAL SECURITY) ---
app.use(express.json({ limit: '1mb' }));
app.use(tracingMiddleware); 
app.use(ipTrustLogger); // Log original IP

// 1. GLOBAL RATE LIMIT: Protects ALL endpoints
app.use(rateLimiter({ ipLimit: { limit: 100, windowMs: 60000 }, message: 'Global Rate Limit Exceeded' }));

// 2. ROUTE-SPECIFIC LIMITS/AUTH
app.use('/auth', rateLimiter(AUTH_WRITE_LIMIT), authRoutes); // Stricter limit on writes

// 3. FINAL ERROR HANDLERS
app.use(notFoundHandler);
app.use(globalErrorHandler);

// app.listen(...)
```

#### **95.3. `documentation/gateway_routing.md` (New Routing Doc)**

```markdown
# API Gateway Routing and Security Documentation

This document defines the expected external Gateway configuration and the security headers required for the OpenShow backend.

## 1. External Gateway Responsibilities

The API Gateway (external to the microservices layer) MUST perform the following actions:

1.  **TLS Termination:** Terminate all HTTPS traffic and pass only HTTP/2 internally (for faster communication).
2.  **Rate Limiting:** Provide a basic layer of defense against high-volume attacks (e.g., block all IPs > 1000 RPS).
3.  **IP Header Forwarding:** Inject/Overwrite the `X-Forwarded-For` header chain, ensuring the **first IP** in the list is the **TRUE CLIENT IP**.

## 2. Backend Header and IP Trust Configuration

The Node.js/Express application is configured to expect the Gateway's behavior via:

*   **Trust Proxy:** `app.set('trust proxy', 'N')` where 'N' is the number of proxies the backend is behind, or a list of trusted IP subnets.
    *   *Rationale:* This correctly sets `req.ip` to the client's true IP (needed for Task 70 Rate Limiting).
*   **Traceability:** The application expects the `X-Request-ID` header (or generates one via Task 76) and returns it in the response.

## 3. Example Routing Rules

| External Path | Internal Service URL | Auth/Security Check |
| :--- | :--- | :--- |
| `GET /api/creators` | `http://projects-service:8081/api/v1/creators` | Public, High Cache TTL |
| `POST /api/projects` | `http://projects-service:8081/api/v1/projects` | JWT Validation |
| `POST /auth/login` | `http://auth-service:8082/api/v1/auth/login` | JWT Validation, Stricter Rate Limit (T70) |
| `POST /webhooks/*` | `http://payments-service:8083/api/v1/webhooks/*`| **NO AUTH**, Signature Validation (T69) |
```

#### **95.4. Test Specification**

| Test ID | Method | Description | Headers Input | Express `req.ip` Expected |
| :--- | :--- | :--- | :--- | :--- |
| **T95.1** | `Unit Test` | Single Hop Proxy | `X-Forwarded-For: 203.0.113.1` | `203.0.113.1` |
| **T95.2** | `Unit Test` | Multi-Hop Proxy (External Client) | `X-Forwarded-For: 192.168.1.1, 203.0.113.1` | `203.0.113.1` (Assuming trust proxy is 1) |
| **T95.3** | `Integration` | Rate Limit Check | T70.2 scenario (IP/User Limit) | 429 Status |

---