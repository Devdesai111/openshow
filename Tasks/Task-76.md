Following the structured plan and finalizing the operational observability features, we proceed with **Task 76: Logging & Tracing (OpenTelemetry)**.

This task implements the system's logging standards and tracing infrastructure, which is essential for diagnosing production issues, debugging microservice dependencies, and linking audit records to the original request flow.

***

## **Task 76: Logging & Tracing (OpenTelemetry)**

**Goal:** Implement a centralized logging utility (following audit standards) and a basic middleware for generating unique correlation IDs (Trace IDs) and attaching them to the request object and logs, in line with OpenTelemetry tracing principles.

**Service:** `Utility & System Features` (Foundation)
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 60 (AuditLog Model - for audit reference), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/utils/logger.utility.ts` (New file: Centralized Winston/Pino style logger)
2.  `src/middlewares/tracing.middleware.ts` (New file: Correlation/Trace ID generator)
3.  `src/config/global.config.ts` (Updated: Apply logging/tracing initialization)
4.  `test/unit/tracing_logic.test.ts` (Test specification)

**Input/Output Shapes:**

| Middleware Action | Condition | Header/Property Check | Audit Impact |
| :--- | :--- | :--- | :--- |
| **Tracing** | Any incoming request | `req.traceId` populated; `X-Request-ID` header sent in response. | Audit logs must include `traceId`. |

**Runtime & Env Constraints:**
*   **Decoupling:** Logging should be handled by a single utility and not dispersed across `console.log`.
*   **Trace ID:** A unique `traceId` (UUID/random string) must be generated for every incoming request.
*   **Context Propagation:** The `traceId` must be automatically included in all logs generated during that request's lifetime.

**Acceptance Criteria:**
*   A new middleware successfully generates a unique `traceId` and attaches it to the request object.
*   The final response includes the `X-Request-ID` header containing the `traceId`.
*   The logging utility correctly formats log messages with the current `traceId` and log level.

**Tests to Generate:**
*   **Unit Test (Logger):** Test logger formatting (level, message, timestamp, traceId).
*   **Unit Test (Middleware):** Test that two consecutive requests generate different trace IDs.

***

### **Task 76 Code Implementation**

#### **76.1. `src/utils/logger.utility.ts` (New Utility File)**

```typescript
// src/utils/logger.utility.ts
// Mocking a standard structured logger (like Pino or Winston)

interface LogContext {
    traceId?: string;
    [key: string]: any;
}

// Global interface for the structured logger
interface ILogger {
    info(message: string, context?: LogContext): void;
    warn(message: string, context?: LogContext): void;
    error(message: string, context?: LogContext): void;
}

/**
 * Centralized Structured Logging Utility (Pino/Winston inspired).
 * In production, this pipes to an external log aggregator (Splunk/ELK).
 */
class Logger implements ILogger {
    private logLevel: 'info' | 'warn' | 'error' = 'info';

    private format(level: string, message: string, context: LogContext = {}) {
        return JSON.stringify({
            timestamp: new Date().toISOString(),
            level: level.toUpperCase(),
            traceId: context.traceId || 'N/A',
            service: 'OpenShow-Auth', // Placeholder for service name
            message: message,
            ...context,
        });
    }

    public info(message: string, context?: LogContext) {
        if (this.logLevel === 'info') {
            console.info(this.format('info', message, context));
        }
    }

    public warn(message: string, context?: LogContext) {
        console.warn(this.format('warn', message, context));
    }

    public error(message: string, context?: LogContext) {
        console.error(this.format('error', message, context));
    }
}

export const logger = new Logger();
```

#### **76.2. `src/middlewares/tracing.middleware.ts` (New Middleware File)**

```typescript
// src/middlewares/tracing.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid'; // Standard UUID generator
import { logger } from '../utils/logger.utility';

// Extend the Express Request interface to include the traceId
declare module 'express-serve-static-core' {
    interface Request {
        traceId?: string;
    }
}

/**
 * Middleware to generate a unique Trace ID (X-Request-ID) for context propagation.
 */
export const tracingMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // 1. Generate new UUID for Trace ID
    const traceId = uuidv4();
    
    // 2. Attach to Request for internal service logging
    req.traceId = traceId;

    // 3. Set Response Header for external tracing/debugging (X-Request-ID)
    res.setHeader('X-Request-ID', traceId);

    // 4. Log the incoming request (Optional, good practice)
    logger.info('Incoming Request', { 
        traceId, 
        method: req.method, 
        path: req.originalUrl, 
        ip: req.ip 
    });

    // 5. Log the outgoing response on finish
    res.on('finish', () => {
        logger.info('Outgoing Response', { 
            traceId: req.traceId, 
            status: res.statusCode, 
            responseTimeMs: Date.now() - req.startTime! // Assuming startTime is set earlier
        });
    });
    
    // Add start time property (Task 75/76 dependency)
    (req as any).startTime = Date.now(); 

    next();
};
```

#### **76.3. `src/config/global.config.ts` (Updates - Initialization)**

```typescript
// src/config/global.config.ts (Illustrative placement of initialization)
// ... (Imports from Task 74) ...

// 1. Initialize Secrets (Must be done first)
// ... (SecretsProvider.initialize logic) ...

// 2. Initialize Tracing/Logging Systems
// No complex init needed for our mock, but in production, OpenTelemetry SDK setup happens here.
console.log(`[Config] Logging and Tracing systems initialized.`);

// 3. Build and Export Global Config Object
// ... (CONFIG export logic) ...
```

#### **76.4. Example Usage (Service Layer)**

*(Demonstrating how a service would use the logger, including the Trace ID)*

```typescript
// src/services/auth.service.ts (Illustrative Update)

// Inject Logger dependency (or use global logger)
import { logger } from '../utils/logger.utility'; 

export class AuthService {
    // ... (login method) ...

    public async login(data: any, req: Request): Promise<any> {
        // ... (find user logic) ...
        
        if (!isMatch) {
            // Log failure with context
            logger.warn('Login failure: Invalid credentials', { traceId: req.traceId, email: data.email });
            throw new Error('InvalidCredentials');
        }

        // Log success with user ID
        logger.info('User authenticated successfully', { traceId: req.traceId, userId: user._id.toString() });
        // ... (rest of logic) ...
    }
}
```

#### **76.5. Test Specification**

| Test ID | Method | Description | Condition | Expected Check |
| :--- | :--- | :--- | :--- | :--- |
| **T76.1** | `tracingMiddleware` | Header Propagation | Any Request | Response header `X-Request-ID` is present and unique. |
| **T76.2** | `tracingMiddleware` | ID Uniqueness | Two sequential requests | `req1.traceId !== req2.traceId`. |
| **T76.3** | `logger.error` | Log Formatting | Call `logger.error('Test')` | Console output is valid JSON and includes `traceId`. |

---

