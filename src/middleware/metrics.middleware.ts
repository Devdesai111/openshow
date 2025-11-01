// src/middleware/metrics.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDurationSeconds } from '../utils/metrics.utility';

/**
 * Middleware to track request count and latency for Prometheus metrics.
 * This middleware should be applied early in the middleware chain to capture all requests.
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Start timer for request duration (using high precision)
  const endTimer = httpRequestDurationSeconds.startTimer({
    method: req.method,
    path: req.path, // Use path for initial tracking
  });

  // Define handler for response finalization
  res.on('finish', () => {
    // Stop timer and record duration (records duration to histogram)
    endTimer({
      method: req.method,
      path: req.path,
    });

    // Increment total requests counter
    httpRequestsTotal.inc({
      method: req.method,
      path: req.path,
      status: res.statusCode.toString(),
    });
  });

  next();
};

