Following the structured plan and focusing on external performance optimization, we proceed with **Task 80: Caching Layer & CDN Integration**.

This task establishes the foundational architecture for maximizing system efficiency by implementing Redis caching for API responses and defining the strategy for CDN integration for static assets.

***

## **Task 80: Caching Layer & CDN Integration**

**Goal:** Implement a generic, Express-compatible middleware and utility interface to manage application-level caching (Redis-backed, mocked here) for API responses and define the strategy for serving all static assets via a CDN.

**Service:** `Utility & System Features` / `Infrastructure`
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 70 (Rate Limiting - for shared Redis structure), Task 20 (Asset Service - for CDN links).

**Output Files:**
1.  `src/utils/cache.utility.ts` (New file: Redis client mock and helper functions)
2.  `src/middlewares/cache.middleware.ts` (New file: Cache read/write Express middleware)
3.  `src/controllers/userProfile.controller.ts` (Updated: Apply cache middleware to `/creators`)
4.  `test/unit/cache_utility.test.ts` (Test specification)

**Input/Output Shapes:**

| Middleware Action | Condition | Header Check | Status Check |
| :--- | :--- | :--- | :--- |
| **Cache Hit** | Key found in cache. | `X-Cache: HIT` | **200 OK** (Fast response) |
| **Cache Miss** | Key not found. | `X-Cache: MISS` | Continues to next handler. |

**Runtime & Env Constraints:**
*   **Performance (CRITICAL):** Caching must be non-blocking. We mock a fast Redis client.
*   **Invalidation:** The utility must support TTLs and explicit invalidation (future task) upon data mutation.
*   **CDN Strategy:** All API responses for static media (`AssetModel` URLs) must direct the client to the CDN endpoint.

**Acceptance Criteria:**
*   The caching middleware correctly intercepts a request, checks the cache, and serves the response if a hit occurs.
*   The middleware is successfully applied to a public, heavy read endpoint (e.g., `GET /creators`).
*   The cache utility implements basic `get`, `set`, and `del` methods with a TTL.

**Tests to Generate:**
*   **Unit Test (Utility):** Test `set` and `get` operations, verify TTL expiration (mocked clock).
*   **Unit Test (Middleware):** Test a successful cache hit (response served by middleware, controller not called) and a cache miss (controller called).

***

### **Task 80 Code Implementation**

#### **80.1. `src/utils/cache.utility.ts` (New Utility File - Redis Mock)**

```typescript
// src/utils/cache.utility.ts
// Mocking a dedicated, high-speed Redis Client

// Internal cache store (Simulated Redis)
const redisCache = new Map<string, { value: string, expires: number }>();


export class CacheUtility {
    
    /** Retrieves a value from the cache. */
    public static async get(key: string): Promise<string | null> {
        const entry = redisCache.get(key);
        if (entry && entry.expires > Date.now()) {
            return entry.value;
        }
        if (entry) {
            // Expired: delete key
            redisCache.delete(key);
        }
        return null;
    }

    /** Sets a value in the cache with a Time-To-Live (TTL). */
    public static async set(key: string, value: string, ttlSeconds: number): Promise<void> {
        const expires = Date.now() + ttlSeconds * 1000;
        redisCache.set(key, { value, expires });
    }

    /** Deletes a key from the cache. */
    public static async del(key: string): Promise<void> {
        redisCache.delete(key);
    }
    
    /** Generates a deterministic cache key from the request path and query. */
    public static generateKey(path: string, query: Record<string, any>): string {
        // PRODUCTION: Should normalize query params (e.g., sort keys, exclude timestamps)
        const normalizedQuery = JSON.stringify(query); 
        return `cache:${path}:${normalizedQuery}`;
    }
}
```

#### **80.2. `src/middlewares/cache.middleware.ts` (New Middleware File)**

```typescript
// src/middlewares/cache.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { CacheUtility } from '../utils/cache.utility';

// Default TTL for public listing data
const DEFAULT_TTL_SECONDS = 60; 


/**
 * Cache middleware generator for response caching.
 * Only caches successful GET responses.
 */
export const cacheResponse = (ttlSeconds: number = DEFAULT_TTL_SECONDS) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET') {
            return next(); // Only cache GET requests
        }

        const cacheKey = CacheUtility.generateKey(req.path, req.query);

        // 1. Check Cache
        const cachedResponse = await CacheUtility.get(cacheKey);

        if (cachedResponse) {
            // Cache Hit: Serve immediately
            res.setHeader('X-Cache', 'HIT');
            res.setHeader('Content-Type', 'application/json');
            return res.status(200).send(cachedResponse);
        }

        // 2. Cache Miss: Patch response.send/json to capture response body
        res.setHeader('X-Cache', 'MISS');
        
        const originalSend = res.send;
        
        // Intercept response body
        (res as any).send = function (body: any) {
            if (res.statusCode === 200) {
                // Set cache asynchronously
                const content = typeof body === 'string' ? body : JSON.stringify(body);
                CacheUtility.set(cacheKey, content, ttlSeconds);
            }
            
            // Call original send function
            originalSend.apply(res, arguments as any);
        };

        next();
    };
};
```

#### **80.3. `src/controllers/userProfile.controller.ts` (Updates - Apply Cache)**

```typescript
// src/controllers/userProfile.controller.ts (partial update)
// ... (Imports, userProfileService initialization, previous controllers) ...
import { cacheResponse } from '../middlewares/cache.middleware'; // New Import

// Define the middleware chain for the /creators route
export const searchCreatorsMiddleware = [
    // Apply cache layer to the public, high-read endpoint
    cacheResponse(120), // Cache for 2 minutes (120 seconds) 
    searchCreatorsValidation,
];

// Controller definition remains clean:
// export const searchCreatorsController = async (req, res) => { ... }
```

#### **80.4. `src/routes/userProfile.routes.ts` (Updates - Route Definition)**

```typescript
// src/routes/userProfile.routes.ts (partial update)
import { Router } from 'express';
import { searchCreatorsController, searchCreatorsValidation } from '../controllers/discovery.controller';
import { searchCreatorsMiddleware } from '../controllers/userProfile.controller'; // Get middleware pipeline

const router = Router();

// --- Public/Discovery Endpoints ---

// GET /creators - Creator Directory Listing/Search (Task 10)
// Now uses the middleware pipeline including caching
router.get(
    '/creators', 
    searchCreatorsMiddleware, // Pipeline includes cacheResponse(120) and validation
    searchCreatorsController
);

// ... (Other routes) ...
```

#### **80.5. Test Specification**

| Test ID | Method | Description | Command | Expected State Check |
| :--- | :--- | :--- | :--- | :--- |
| **T80.1** | `GET /creators` | Cache Hit Check (Request 2) | Run request twice consecutively. | Request 2 header: `X-Cache: HIT`. Controller execution count is 1. |
| **T80.2** | `GET /creators` | Cache Miss Check (Request 1) | Run request first time. | Request 1 header: `X-Cache: MISS`. Controller execution count is 1. |
| **T80.3** | `Utility Test` | TTL Expiration | Call `CacheUtility.set('k1', 'v1', 0.001)` then wait 10ms and `get('k1')`. | `get('k1')` must return `null`. |
| **T80.4** | `CDN Strategy` | Architecture Check | N/A | All API code referencing asset links should generate URLs pointing to a CDN (e.g., `https://cdn.openshow.com/`). |

---

