import { getExponentialBackoffDelay, isRetryAllowed, MAX_ATTEMPTS } from '../../src/utils/retryPolicy';

describe('Retry Policy Utility', () => {
  describe('getExponentialBackoffDelay', () => {
    it('T40.1 - should calculate correct delay for attempt 1', () => {
      // Act
      const delay = getExponentialBackoffDelay(1);

      // Assert
      // Attempt 1: BASE_DELAY * (2^0) = 60000ms = 1 minute (plus jitter)
      expect(delay).toBeGreaterThanOrEqual(60000);
      expect(delay).toBeLessThanOrEqual(66000); // 60000 + 10% jitter
    });

    it('T40.1 - should calculate correct delay for attempt 2', () => {
      // Act
      const delay = getExponentialBackoffDelay(2);

      // Assert
      // Attempt 2: BASE_DELAY * (2^1) = 120000ms = 2 minutes (plus jitter)
      expect(delay).toBeGreaterThanOrEqual(120000);
      expect(delay).toBeLessThanOrEqual(132000); // 120000 + 10% jitter
    });

    it('should calculate correct delay for attempt 3', () => {
      // Act
      const delay = getExponentialBackoffDelay(3);

      // Assert
      // Attempt 3: BASE_DELAY * (2^2) = 240000ms = 4 minutes (plus jitter)
      expect(delay).toBeGreaterThanOrEqual(240000);
      expect(delay).toBeLessThanOrEqual(264000); // 240000 + 10% jitter
    });

    it('should calculate correct delay for attempt 4', () => {
      // Act
      const delay = getExponentialBackoffDelay(4);

      // Assert
      // Attempt 4: BASE_DELAY * (2^3) = 480000ms = 8 minutes (plus jitter)
      expect(delay).toBeGreaterThanOrEqual(480000);
      expect(delay).toBeLessThanOrEqual(528000); // 480000 + 10% jitter
    });

    it('should return -1 for attempt >= MAX_ATTEMPTS', () => {
      // Act
      const delay = getExponentialBackoffDelay(MAX_ATTEMPTS);

      // Assert
      expect(delay).toBe(-1);
    });

    it('should return -1 for attempt > MAX_ATTEMPTS', () => {
      // Act
      const delay = getExponentialBackoffDelay(MAX_ATTEMPTS + 1);

      // Assert
      expect(delay).toBe(-1);
    });
  });

  describe('isRetryAllowed', () => {
    it('should return true for attempt < MAX_ATTEMPTS', () => {
      expect(isRetryAllowed(1)).toBe(true);
      expect(isRetryAllowed(2)).toBe(true);
      expect(isRetryAllowed(3)).toBe(true);
      expect(isRetryAllowed(4)).toBe(true);
    });

    it('should return false for attempt >= MAX_ATTEMPTS', () => {
      expect(isRetryAllowed(MAX_ATTEMPTS)).toBe(false);
      expect(isRetryAllowed(MAX_ATTEMPTS + 1)).toBe(false);
    });
  });
});

