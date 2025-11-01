Following the structured plan and prioritizing critical security and operational stability, we proceed with **Task 70: Rate Limiting & Abuse Protections**.

This task implements the global middleware layer for API throttling, which is essential for protecting the platform against DDoS, brute-force, and resource exhaustion attacks.

***

## **Task 70: Rate Limiting & Abuse Protections**

**Goal:** Implement a generic, Express-compatible rate-limiting middleware that can be applied globally and with different limits to specific routes (e.g., Auth, Search, Write Operations), utilizing a high-speed store (e.g., Redis).

**Service:** `Utility & System Features`
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** None (Infrastructure Foundation, but requires a cache store like Redis, which we will mock).

**Output Files:**
1.  `src/middlewares/rateLimit.middleware.ts` (New file: Core rate limiting logic)
2.  `src/config/rateLimits.ts` (New file: Limit definitions)
3.  `src/app.ts` (Mocked file - Where global middleware is applied)
4.  `test/unit/rate_limit.test.ts` (Test specification)

**Input/Output Shapes:**

| Middleware Action | Condition | Response (429 Too Many Requests) | Header Check |
| :--- | :--- | :--- | :--- |
| **Throttling** | Limit exceeded for IP/User ID | `{ error: { code: 'too_many_requests', message: 'Rate limit exceeded.' } }` | `Retry-After` header must be present. |

**Runtime & Env Constraints:**
*   **Performance (CRITICAL):** The rate-limiting middleware **must** use a non-blocking, fast memory store (mocked as an in-memory map here, but designed for Redis/Memcached).
*   **Flexibility:** The middleware must support throttling by **IP** (global/anonymous) and by **User ID** (authenticated users).
*   **Header:** Must correctly return the `Retry-After` header upon failure.

**Acceptance Criteria:**
*   A user/IP exceeding the limit returns **429 Too Many Requests**.
*   The middleware correctly identifies the user ID vs. IP for different rate limits.
*   The `Retry-After` header is correctly set to the remaining time in seconds.
*   The middleware successfully applies different limits to different routes (e.g., stricter limit on Auth write operations).

**Tests to Generate:**
*   **Unit Test (IP Throttling):** Test 5 requests from the same IP, verify the 6th fails with 429.
*   **Unit Test (User Throttling):** Test 5 requests from the same authenticated user, verify the 6th fails.

***

### **Task 70 Code Implementation**

#### **70.1. `src/config/rateLimits.ts` (New Config File)**

```typescript
// src/config/rateLimits.ts

export interface ILimit {
    limit: number; // Max requests
    windowMs: number; // Time window in milliseconds
}

export interface IRateLimitOptions {
    ipLimit?: ILimit;
    userLimit?: ILimit;
    message: string;
}

// --- Global Rate Limit Definitions ---

export const GLOBAL_READ_LIMIT: IRateLimitOptions = {
    ipLimit: { limit: 150, windowMs: 60 * 1000 }, // 150 requests per minute per IP
    userLimit: { limit: 500, windowMs: 60 * 1000 }, // 500 requests per minute per User
    message: 'Global read rate limit exceeded.',
};

export const AUTH_WRITE_LIMIT: IRateLimitOptions = {
    ipLimit: { limit: 5, windowMs: 60 * 1000 }, // Stricter: 5 requests per minute per IP (DDoS/Brute Force)
    userLimit: { limit: 20, windowMs: 60 * 1000 },
    message: 'Authentication write rate limit exceeded.',
};

export const API_WRITE_LIMIT: IRateLimitOptions = {
    userLimit: { limit: 60, windowMs: 60 * 1000 }, // 60 writes per minute per User (prevents accidental API loops)
    message: 'API write rate limit exceeded.',
};
```

#### **70.2. `src/middlewares/rateLimit.middleware.ts` (New Middleware File)**

```typescript
// src/middlewares/rateLimit.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { IRateLimitOptions, ILimit } from '../config/rateLimits';

// Mock Cache Store for Rate Limiting (Simulated Redis)
interface ICacheEntry {
    count: number;
    resetTime: number; // Unix timestamp
}
const limitStore = new Map<string, ICacheEntry>();

/**
 * Middleware generator for IP and User ID based rate limiting.
 */
export const rateLimiter = (options: IRateLimitOptions) => {
    return (req: Request, res: Response, next: NextFunction) => {
        
        // 1. Determine Key and Limit Type (User ID takes precedence over IP)
        let key = req.ip;
        let limitConfig: ILimit | undefined = options.ipLimit;

        if (req.user) {
            // Authenticated users are tracked by their user ID
            key = req.user.sub;
            limitConfig = options.userLimit || options.ipLimit; // Fallback to IP limit if no user limit defined
        }
        
        if (!limitConfig) {
            return next(); // No limit defined for this route/user type
        }

        const { limit, windowMs } = limitConfig;
        const now = Date.now();
        const storeKey = `rate_${key}`;

        // 2. Retrieve/Initialize Count
        const entry = limitStore.get(storeKey);
        
        if (!entry || entry.resetTime <= now) {
            // New window or window expired: Reset count
            limitStore.set(storeKey, {
                count: 1,
                resetTime: now + windowMs,
            });
            return next();
        }

        // 3. Check Limit
        if (entry.count >= limit) {
            // Limit Exceeded: Return 429
            const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
            
            res.setHeader('Retry-After', retryAfter);
            return res.status(429).json({
                error: {
                    code: 'too_many_requests',
                    message: options.message,
                    details: { limit, window: windowMs / 1000 },
                }
            });
        }

        // 4. Increment Count and Proceed
        entry.count += 1;
        limitStore.set(storeKey, entry);
        next();
    };
};
```

#### **70.3. `src/app.ts` (Application of Middleware - Mock)**

```typescript
// src/app.ts (Mock) - Where middleware is globally applied

import express from 'express';
import { rateLimiter } from './middlewares/rateLimit.middleware';
import { GLOBAL_READ_LIMIT, AUTH_WRITE_LIMIT, API_WRITE_LIMIT } from './config/rateLimits';
import authRoutes from './routes/auth.routes';

const app = express();

// Global Middleware: Apply rate limiting to ALL requests by default (GLOBAL_READ_LIMIT)
app.use(rateLimiter(GLOBAL_READ_LIMIT));

// Example of applying a stricter limit to a specific route/router
app.use('/auth', rateLimiter(AUTH_WRITE_LIMIT), authRoutes);

// Example for all authenticated write operations (PUT, POST, DELETE on API routes)
// app.put('*', authenticate, rateLimiter(API_WRITE_LIMIT));
```

#### **70.4. Test Specification**

| Test ID | Endpoint | Limit Type | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T70.1** | Any Public | IP Throttling (150/min) | 151st request from same IP within 60s. | **429 Too Many Requests** | `Retry-After` header is $>0$. |
| **T70.2** | `/auth/login` | Auth Write (5/min) | 6th request from same IP/User within 60s. | **429 Too Many Requests** | `message` matches `Authentication write rate limit exceeded.`. |
| **T70.3** | `/auth/login` | User Throttling | 6th request from same AUTHENTICATED user within 60s. | **429 Too Many Requests** | Limit based on `userLimit` (stricter than IP). |
| **T70.4** | `/auth/login` | Reset Check | 6th request after 61 seconds. | **200 OK** | Count must be reset to 1. |
