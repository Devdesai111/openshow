Following the structured plan and focusing on platform reliability, we proceed with **Task 83: Error Handling & Graceful Degradation**.

This task implements the final, centralized structure for managing all errors across the application, ensuring that clients receive consistent, actionable responses and that the server's internal state is protected.

***

## **Task 83: Error Handling & Graceful Degradation**

**Goal:** Implement a centralized Express error handling middleware that captures all internal server errors, logs the full stack trace (using Task 76), and returns a standardized, sanitized JSON error response to the client.

**Service:** `Utility & System Features` (Foundation)
**Phase:** K - Operational hardening, backups, DR, docs
**Dependencies:** Task 76 (Logging/Tracing), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/config/errorCodes.ts` (New file: Standardized error code definitions)
2.  `src/middlewares/error.middleware.ts` (New file: The final Express error handler)
3.  `src/app.ts` (Mocked file: Application of middleware)
4.  `test/unit/error_handler.test.ts` (Test specification)

**Input/Output Shapes:**

| Error Type | Status Code | Error Code | Client Response (Sanitized) |
| :--- | :--- | :--- | :--- |
| **Operational Error** | 400-409 | `validation_error`, `not_found`, etc. | Unsanitized, specific client message. |
| **Internal Server Error** | 500 | `server_error` | Generic message; sanitized for production. |

**Runtime & Env Constraints:**
*   **Security (CRITICAL):** Stack traces and sensitive internal details MUST NOT be exposed to the client, especially in a production environment.
*   **Context:** The handler must log the full stack trace and the `traceId` (Task 76) for internal debugging.
*   **Placement:** The middleware must be placed as the **LAST** middleware in the Express application chain.

**Acceptance Criteria:**
*   Simulated unhandled exception in a controller results in a generic **500 Internal Server Error** with a sanitized body.
*   The system successfully logs the full error stack trace linked to the request's `traceId`.
*   The final middleware handles `404 Not Found` errors for undefined routes.

**Tests to Generate:**
*   **Unit Test (500 Handling):** Test passing a generic JavaScript `Error` object to the middleware and verifying a sanitized 500 response.
*   **Unit Test (404 Handling):** Test calling a non-existent route and verifying a correct 404 response.

***

### **Task 83 Code Implementation**

#### **83.1. `src/config/errorCodes.ts` (New Error Code Definitions)**

```typescript
// src/config/errorCodes.ts

export const STATUS_CODES = {
    UNPROCESSABLE_ENTITY: 422,
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    UNAUTHORIZED: 401,
    CONFLICT: 409,
    FAILED_DEPENDENCY: 424,
    TOO_MANY_REQUESTS: 429,
    SERVICE_UNAVAILABLE: 503,
    INTERNAL_SERVER_ERROR: 500,
};

export interface StandardError {
    code: string;
    message: string;
    details?: any;
    traceId?: string;
}

export class AppError extends Error {
    public readonly statusCode: number;
    public readonly isOperational: boolean;
    public readonly errorCode: string;
    
    constructor(statusCode: number, errorCode: string, message: string, details?: any) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true; // Errors we expect and handle gracefully
        this.errorCode = errorCode;
        // Attach details to the instance if needed
        if (details) (this as any).details = details;

        Error.captureStackTrace(this, this.constructor);
    }
}
```

#### **83.2. `src/middlewares/error.middleware.ts` (New Middleware File)**

```typescript
// src/middlewares/error.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { AppError, STATUS_CODES, StandardError } from '../config/errorCodes';
import { logger } from '../utils/logger.utility'; // Task 76 Logger

/**
 * Global Error Handling Middleware (The FINAL piece in the chain).
 * Captures all unhandled exceptions and formats them into a standardized, safe response.
 */
// Express requires 4 arguments for the error handler signature
export const globalErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
    
    const traceId = req.traceId || 'N/A';
    
    // 1. Determine Error Type and Status Code
    let statusCode = err.statusCode || STATUS_CODES.INTERNAL_SERVER_ERROR;
    let errorIsOperational = err.isOperational || false;
    
    // Handle Mongoose/DB-specific errors if necessary (e.g., CastError, ValidationError)
    if (err.name === 'CastError' || err.name === 'ValidationError') {
        statusCode = STATUS_CODES.UNPROCESSABLE_ENTITY;
        errorIsOperational = true;
    }
    
    // 2. Log Internal Server Errors (5xx)
    if (statusCode >= 500) {
        // Log the full stack trace for internal debugging/monitoring
        logger.error('Unhandled Internal Server Error', { 
            traceId, 
            method: req.method, 
            path: req.originalUrl, 
            stack: err.stack,
        });
    }

    // 3. Prepare Safe Client Response
    const clientError: StandardError = {
        traceId,
        // Send detailed message only for operational errors, otherwise sanitize
        code: err.errorCode || 'server_error',
        message: errorIsOperational ? err.message : 'An unexpected error occurred. Our team has been notified.',
        details: errorIsOperational ? err.details : undefined,
    };

    // 4. Send Response
    res.status(statusCode).json({ error: clientError });
};

/**
 * Fallback Middleware for 404 Not Found Routes.
 */
export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
    const error = new AppError(
        STATUS_CODES.NOT_FOUND, 
        'route_not_found', 
        `Cannot ${req.method} ${req.path}`
    );
    next(error);
};
```

#### **83.3. `src/app.ts` (Mocked Placement)**

```typescript
// src/app.ts (Mock - Demonstrating correct placement)
// ... (Imports: express, routes, middleware) ...
import { tracingMiddleware } from './middlewares/tracing.middleware';
import { notFoundHandler, globalErrorHandler } from './middlewares/error.middleware';


const app = express();

// --- Tracing & Body Parsing ---
app.use(tracingMiddleware);
app.use(express.json()); 
// ... (Other middlewares: Rate Limiter, Auth) ...


// --- Route Definitions ---
// app.use('/auth', authRoutes);
// app.use('/payments', paymentRoutes);
// ...


// --- Error Handling (CRITICAL: Must be last) ---
app.use(notFoundHandler); 
app.use(globalErrorHandler); 
```

#### **83.4. Test Specification**

| Test ID | Middleware Action | Scenario | Expected Status | Expected Body Check |
| :--- | :--- | :--- | :--- | :--- |
| **T83.1** | `globalErrorHandler` | Unhandled Exception (500) | `throw new Error('DB connection failed')` | **500 Internal Server Error** | `code: 'server_error'`, `message` is generic. |
| **T83.2** | `globalErrorHandler` | Handled Exception (422) | `throw new AppError(422, 'validation_error', 'Invalid ID')` | **422 Unprocessable** | `code: 'validation_error'`, original `message` preserved. |
| **T83.3** | `notFoundHandler` | Invalid Route | `GET /non-existent-route` | **404 Not Found** | `code: 'route_not_found'`. |
| **T83.4** | `Logger Check` | 500 Logging | T83.1 scenario | `logger.error` called with `traceId` and full `stack`. |

---