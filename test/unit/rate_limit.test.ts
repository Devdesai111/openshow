import { Request, Response, NextFunction } from 'express';
import { rateLimiter, clearRateLimitStore } from '../../src/middleware/rateLimit.middleware';
import { GLOBAL_READ_LIMIT, AUTH_WRITE_LIMIT, API_WRITE_LIMIT } from '../../src/config/rateLimits';

describe('Rate Limit Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    clearRateLimitStore(); // Clear the store before each test
    mockRequest = {
      ip: '127.0.0.1',
      headers: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    nextFunction = jest.fn();
    jest.clearAllMocks();
  });

  describe('IP-based throttling', () => {
    it('T70.1 - should allow requests under the limit', () => {
      // Arrange
      const middleware = rateLimiter(GLOBAL_READ_LIMIT);

      // Act: 5 requests
      for (let i = 0; i < 5; i++) {
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      }

      // Assert
      expect(nextFunction).toHaveBeenCalledTimes(5);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('T70.2 - should block requests exceeding the IP limit', () => {
      // Arrange
      const middleware = rateLimiter(AUTH_WRITE_LIMIT);

      // Act: 6 requests (limit is 5 per minute)
      for (let i = 0; i < 5; i++) {
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      }
      // 6th request should be blocked
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(nextFunction).toHaveBeenCalledTimes(5);
      expect(mockResponse.status).toHaveBeenCalledWith(429);
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'too_many_requests',
          message: AUTH_WRITE_LIMIT.message,
          details: { limit: 5, window: 60 },
        },
      });
    });

    it('T70.3 - should reset the window after expiry', async () => {
      // Arrange
      const middleware = rateLimiter(AUTH_WRITE_LIMIT);

      // Act: 6 requests immediately (should block)
      for (let i = 0; i < 6; i++) {
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      }

      expect(nextFunction).toHaveBeenCalledTimes(5);
      jest.clearAllMocks();

      // Wait for window to expire (61 seconds)
      jest.useFakeTimers();
      jest.advanceTimersByTime(61000);

      // 7th request after expiry should succeed
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('User-based throttling', () => {
    it('T70.4 - should use user ID when authenticated', () => {
      // Arrange
      const middleware = rateLimiter(AUTH_WRITE_LIMIT);
      mockRequest.user = {
        sub: 'user123',
        role: 'creator',
        email: 'user@test.com',
      };

      // Act: 6 requests from authenticated user (limit is 20 per minute)
      for (let i = 0; i < 21; i++) {
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      }

      // Assert: Should block 21st request (limit is 20)
      expect(nextFunction).toHaveBeenCalledTimes(20);
      expect(mockResponse.status).toHaveBeenCalledWith(429);
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    });

    it('should fallback to IP limit when no user limit is defined', () => {
      // Arrange
      const middleware = rateLimiter(GLOBAL_READ_LIMIT);
      mockRequest.user = {
        sub: 'user123',
        role: 'creator',
        email: 'user@test.com',
      };

      // Act: 151 requests (IP limit is 150, user limit is 500)
      for (let i = 0; i < 151; i++) {
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      }

      // Assert: Should use user limit (500), so 151 should pass
      expect(nextFunction).toHaveBeenCalledTimes(151);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should use user limit preferentially when both are defined', () => {
      // Arrange
      const middleware = rateLimiter(AUTH_WRITE_LIMIT);
      mockRequest.user = {
        sub: 'user456',
        role: 'creator',
        email: 'user2@test.com',
      };

      // Act: 6 requests from authenticated user
      // IP limit is 5, user limit is 20
      for (let i = 0; i < 21; i++) {
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      }

      // Assert: Should use user limit (20), not IP limit (5)
      expect(nextFunction).toHaveBeenCalledTimes(20);
      expect(mockResponse.status).toHaveBeenCalledWith(429);
    });
  });

  describe('Different rate limit configurations', () => {
    it('should apply API_WRITE_LIMIT correctly', () => {
      // Arrange
      const middleware = rateLimiter(API_WRITE_LIMIT);
      mockRequest.user = {
        sub: 'user789',
        role: 'creator',
        email: 'user3@test.com',
      };

      // Act: 61 requests (limit is 60 per minute)
      for (let i = 0; i < 61; i++) {
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      }

      // Assert
      expect(nextFunction).toHaveBeenCalledTimes(60);
      expect(mockResponse.status).toHaveBeenCalledWith(429);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'too_many_requests',
          message: API_WRITE_LIMIT.message,
          details: { limit: 60, window: 60 },
        },
      });
    });

    it('should handle requests without IP limit when user is not authenticated', () => {
      // Arrange
      const middleware = rateLimiter(API_WRITE_LIMIT);
      // No user, no IP limit

      // Act
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert: Should proceed without blocking
      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('should handle multiple IPs independently', () => {
      // Arrange
      const middleware = rateLimiter(AUTH_WRITE_LIMIT);
      const request1: Partial<Request> = { ip: '127.0.0.1', headers: {} };
      const request2: Partial<Request> = { ip: '192.168.0.1', headers: {} };

      // Act
      for (let i = 0; i < 6; i++) {
        middleware(request1 as Request, mockResponse as Response, nextFunction);
      }
      // Request from different IP should not be blocked
      middleware(request2 as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(nextFunction).toHaveBeenCalledTimes(6); // 5 from IP1 + 1 from IP2
      expect(mockResponse.status).toHaveBeenCalledTimes(1); // Only 6th request from IP1 blocked
    });

    it('should handle multiple users independently', () => {
      // Arrange
      const middleware = rateLimiter(AUTH_WRITE_LIMIT);
      const request1: Partial<Request> = {
        ip: '127.0.0.1',
        user: { sub: 'userA', role: 'creator', email: 'userA@test.com' },
        headers: {},
      };
      const request2: Partial<Request> = {
        ip: '127.0.0.1',
        user: { sub: 'userB', role: 'creator', email: 'userB@test.com' },
        headers: {},
      };

      // Act: 21 requests from userA (limit is 20 for authenticated users)
      for (let i = 0; i < 21; i++) {
        middleware(request1 as Request, mockResponse as Response, nextFunction);
      }
      // Request from different user should not be blocked
      middleware(request2 as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(nextFunction).toHaveBeenCalledTimes(21); // 20 from userA + 1 from userB
      expect(mockResponse.status).toHaveBeenCalledTimes(1); // Only 21st request from userA blocked
    });

    it('should calculate Retry-After header correctly', () => {
      // Arrange
      const middleware = rateLimiter(AUTH_WRITE_LIMIT);

      // Act: Exceed limit
      for (let i = 0; i < 6; i++) {
        middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      }

      // Assert
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
      const retryAfterCall = (mockResponse.setHeader as jest.Mock).mock.calls.find(
        (call) => call[0] === 'Retry-After'
      );
      expect(retryAfterCall).toBeDefined();
      const retryAfter = retryAfterCall![1];
      expect(retryAfter).toBeGreaterThanOrEqual(0);
      expect(retryAfter).toBeLessThanOrEqual(60); // Should be within the window
    });
  });
});

