Following the structured plan and prioritizing operational observability, we proceed with **Task 75: Metrics, Monitoring & Alerting Integration**.

This task establishes the foundational structure for emitting application metrics using a standard format (Prometheus/OpenMetrics), ensuring that the operations team has real-time data on the health and performance of the backend services.

***

## **Task 75: Metrics, Monitoring & Alerting Integration**

**Goal:** Implement a basic structure using a metrics library (mocked here by using the `prom-client` pattern) to track key application metrics (HTTP counts, service duration) and expose them on the dedicated Admin endpoint (`GET /metrics`).

**Service:** `Utility & System Features` (Foundation)
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 7 (Health Check Controller structure), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/utils/metrics.utility.ts` (New file: Prom-client mock/interface)
2.  `src/middlewares/metrics.middleware.ts` (New file: Tracks request duration and path)
3.  `src/controllers/utility.controller.ts` (Updated: `metricsController` to serve real metrics)
4.  `test/unit/metrics_check.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Headers/Params) | Response (200 OK) | Header Check |
| :--- | :--- | :--- | :--- |
| **GET /metrics** | `Auth: Admin-Token` | Plain Text Prometheus Format | `Content-Type: text/plain` |

**Metrics Payload (Excerpt):**
```text
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/auth/me",status="200"} 12
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{path="/auth/me",le="0.1"} 12
```

**Runtime & Env Constraints:**
*   **Security:** The `/metrics` endpoint must be restricted to Admin access or an IP whitelist (already implemented in Task 7 as Admin RBAC).
*   **Performance (CRITICAL):** Metrics collection should be non-blocking and have minimal impact on request latency.
*   **Library:** The implementation will use the concepts from a library like `prom-client` (Node.js standard for Prometheus).

**Acceptance Criteria:**
*   The system successfully exposes metrics data in the Prometheus text format.
*   The custom metrics middleware accurately increments a counter for total HTTP requests and records the response time.
*   Access to `/metrics` by a non-Admin user returns **403 Forbidden**.

**Tests to Generate:**
*   **Unit Test (Middleware):** Test middleware increments the counter for a successful request and records latency.
*   **Integration Test (Access):** Test Admin access vs. non-Admin access to the endpoint.

***

### **Task 75 Code Implementation**

#### **75.1. `src/utils/metrics.utility.ts` (New Utility File - Prom-Client Mock)**

```typescript
// src/utils/metrics.utility.ts
import { Registry, Counter, Histogram } from 'prom-client'; // Mocking prom-client interfaces

// The main registry instance
const registry = new Registry();

// --- Define Core Metrics ---

// 1. Counter: Total HTTP Requests
export const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests processed',
    labelNames: ['method', 'path', 'status'],
});
registry.registerMetric(httpRequestsTotal);

// 2. Histogram: HTTP Request Duration
export const httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'path'],
    buckets: [0.003, 0.03, 0.1, 0.3, 1.0, 3.0, 5.0], // Standard fast service buckets
});
registry.registerMetric(httpRequestDurationSeconds);

// 3. Gauge: Application Specific Metric (Example)
export const activeJobsGauge = new Gauge({
    name: 'app_active_jobs_count',
    help: 'Current number of jobs with status=leased or status=running',
    labelNames: ['type'],
});
registry.registerMetric(activeJobsGauge);


// --- Utility Functions ---

/** Retrieves the metrics in Prometheus text format. */
export async function getMetricsRegistry(): Promise<string> {
    return registry.metrics();
}

// Mock Gauge class for the example (prom-client's Gauge)
class Gauge {
    private value = 0;
    private labels: Record<string, string> = {};
    constructor(config: { name: string, help: string, labelNames: string[] }) {
        this.labels = config.labelNames.reduce((acc, name) => ({ ...acc, [name]: 'unknown' }), {});
    }
    set(value: number) { this.value = value; }
    inc(amount: number) { this.value += amount; }
    dec(amount: number) { this.value -= amount; }
}
```

#### **75.2. `src/middlewares/metrics.middleware.ts` (New Middleware File)**

```typescript
// src/middlewares/metrics.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../utils/metrics.utility';

/**
 * Middleware to track request count and latency for Prometheus.
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // 1. Start timer (using [hrtime] for high precision)
    const endTimer = httpRequestDurationSeconds.startTimer({ 
        method: req.method, 
        path: req.path // Use path for initial tracking
    });

    // 2. Define handler for response finalization
    res.on('finish', () => {
        // Stop timer and record duration (records duration to histogram)
        endTimer({ status: res.statusCode.toString(), path: req.path }); 

        // Increment total requests counter
        httpRequestsTotal.inc({
            method: req.method,
            path: req.path,
            status: res.statusCode.toString(),
        });
    });

    next();
};
```

#### **75.3. `src/controllers/utility.controller.ts` (Updates)**

```typescript
// src/controllers/utility.controller.ts (partial update)
// ... (Imports, healthController) ...
import { getMetricsRegistry } from '../utils/metrics.utility';

/** Handles Prometheus/Grafana metrics endpoint. GET /metrics */
export const metricsController = async (req: Request, res: Response) => {
    try {
        // 1. Retrieve all metrics data in Prometheus format
        const metrics = await getMetricsRegistry();

        // 2. Success (200 OK)
        res.setHeader('Content-Type', registry.contentType); // Use prom-client content type
        return res.status(200).send(metrics);
        
    } catch (error) {
        // Should not happen, but a safe 500 response
        res.status(500).json({ error: { code: 'metrics_fail', message: 'Failed to retrieve metrics.' } });
    }
};
```

#### **75.4. `src/routes/utility.routes.ts` (Updates)**

*(No explicit update required; Task 7's definition is already compatible.)*

#### **75.5. Test Specification**

| Test ID | Method | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T75.1** | `metricsMiddleware` | Counter Check | Successful request to `/health` | N/A | `httpRequestsTotal` count for `path="/health"` is 1. |
| **T75.2** | `metricsMiddleware` | Error Check | Simulated 500 error response | N/A | `httpRequestsTotal` count for `status="500"` is 1. |
| **T75.3** | `GET /metrics` | Access Check | Auth Admin | **200 OK** | `Content-Type: text/plain` (Prometheus format). |
| **T75.4** | `GET /metrics` | Access Check | Auth Creator | **403 Forbidden** | `permission_denied` (RBAC enforced). |
