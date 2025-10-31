import { Request, Response, NextFunction } from 'express';
import { authenticate } from '../../src/middleware/auth.middleware';
import { verify } from 'jsonwebtoken';

// Mock jsonwebtoken
jest.mock('jsonwebtoken');

describe('Auth Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    nextFunction = jest.fn();
    jest.clearAllMocks();
  });

  describe('authenticate middleware', () => {
    it('should return 401 when no authorization header is present', () => {
      // Act
      authenticate(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'no_token',
          message: 'Authentication token is missing or malformed.',
        },
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('should return 401 when authorization header does not start with Bearer', () => {
      // Arrange
      mockRequest.headers = {
        authorization: 'InvalidFormat token123',
      };

      // Act
      authenticate(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'no_token',
          message: 'Authentication token is missing or malformed.',
        },
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('should return 401 when token is invalid', () => {
      // Arrange
      mockRequest.headers = {
        authorization: 'Bearer invalid.token.here',
      };
      (verify as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      // Act
      authenticate(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'invalid_token',
          message: 'Authentication token is invalid or has expired.',
        },
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('should return 401 when token is expired', () => {
      // Arrange
      mockRequest.headers = {
        authorization: 'Bearer expired.token.here',
      };
      (verify as jest.Mock).mockImplementation(() => {
        const error: NodeJS.ErrnoException = new Error('jwt expired');
        error.name = 'TokenExpiredError';
        throw error;
      });

      // Act
      authenticate(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'invalid_token',
          message: 'Authentication token is invalid or has expired.',
        },
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('should return 401 when token is missing required claims', () => {
      // Arrange
      mockRequest.headers = {
        authorization: 'Bearer valid.token.here',
      };
      (verify as jest.Mock).mockReturnValue({
        sub: '123',
        // Missing role and email
      });

      // Act
      authenticate(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'invalid_token',
          message: 'Authentication token is invalid or has expired.',
        },
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('should populate req.user and call next() when token is valid', () => {
      // Arrange
      const mockDecodedToken = {
        sub: 'user123',
        role: 'admin',
        email: 'admin@example.com',
        iss: 'OpenShow',
        aud: 'OpenShow',
      };

      mockRequest.headers = {
        authorization: 'Bearer valid.token.here',
      };
      (verify as jest.Mock).mockReturnValue(mockDecodedToken);

      // Act
      authenticate(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(verify).toHaveBeenCalledWith('valid.token.here', expect.any(String));
      expect(mockRequest.user).toEqual(mockDecodedToken);
      expect(nextFunction).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(mockResponse.json).not.toHaveBeenCalled();
    });

    it('should handle malformed JWT token', () => {
      // Arrange
      mockRequest.headers = {
        authorization: 'Bearer malformed',
      };
      (verify as jest.Mock).mockImplementation(() => {
        throw new Error('jwt malformed');
      });

      // Act
      authenticate(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: {
          code: 'invalid_token',
          message: 'Authentication token is invalid or has expired.',
        },
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('should extract token correctly from Bearer authorization header', () => {
      // Arrange
      const mockDecodedToken = {
        sub: 'user456',
        role: 'creator',
        email: 'creator@example.com',
      };

      mockRequest.headers = {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.token',
      };
      (verify as jest.Mock).mockReturnValue(mockDecodedToken);

      // Act
      authenticate(mockRequest as Request, mockResponse as Response, nextFunction);

      // Assert
      expect(verify).toHaveBeenCalledWith(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.token',
        expect.any(String)
      );
      expect(nextFunction).toHaveBeenCalled();
    });
  });
});

