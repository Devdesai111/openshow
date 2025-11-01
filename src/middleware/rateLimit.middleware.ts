// src/middleware/rateLimit.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { IRateLimitOptions, ILimit } from '../config/rateLimits';

// Mock Cache Store for Rate Limiting (Simulated Redis)
interface ICacheEntry {
  count: number;
  resetTime: number; // Unix timestamp
}
const limitStore = new Map<string, ICacheEntry>();

/**
 * Clear the rate limit store (for testing purposes)
 */
export const clearRateLimitStore = (): void => {
  limitStore.clear();
};

/**
 * Middleware generator for IP and User ID based rate limiting.
 */
export const rateLimiter = (options: IRateLimitOptions) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Determine Key and Limit Type (User ID takes precedence over IP)
    let key = req.ip;
    let limitConfig: ILimit | undefined = options.ipLimit;

    if (req.user) {
      // Authenticated users are tracked by their user ID
      key = req.user.sub!;
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
      res.status(429).json({
        error: {
          code: 'too_many_requests',
          message: options.message,
          details: { limit, window: windowMs / 1000 },
        },
      });
      return;
    }

    // 4. Increment Count and Proceed
    entry.count += 1;
    limitStore.set(storeKey, entry);
    next();
  };
};

