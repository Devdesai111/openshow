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

