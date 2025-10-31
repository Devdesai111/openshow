// src/utils/retryPolicy.ts

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 60000; // 1 minute base delay

/**
 * Calculates the next retry delay using exponential backoff with jitter.
 * Formula: BASE_DELAY * (2 ^ (attempt - 1)) + Jitter
 * @param attempt - The current attempt number (1-indexed).
 * @returns The delay in milliseconds. Returns -1 if max attempts reached.
 */
export function getExponentialBackoffDelay(attempt: number): number {
  if (attempt >= MAX_ATTEMPTS) {
    return -1; // Flag for permanent failure/escalation
  }

  // Calculate deterministic base exponential delay
  const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);

  // Add jitter (randomness up to 10% of the delay)
  const jitter = Math.floor(Math.random() * (delay * 0.1));

  return delay + jitter;
}

/**
 * Checks if a retry is allowed based on the current attempt count.
 * @param attempt - The current attempt number (1-indexed).
 * @returns True if retry is allowed, false otherwise.
 */
export function isRetryAllowed(attempt: number): boolean {
  return attempt < MAX_ATTEMPTS;
}

