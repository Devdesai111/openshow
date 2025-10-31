import { AuthService } from '../../src/services/auth.service';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { hash, compare } from 'bcryptjs';
import { Request } from 'express';

// Mock dependencies
jest.mock('../../src/models/user.model');
jest.mock('../../src/models/authSession.model');
jest.mock('bcryptjs');
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mock.jwt.token'),
}));

describe('AuthService', () => {
  let authService: AuthService;
  let mockRequest: Partial<Request>;

  beforeEach(() => {
    authService = new AuthService();
    mockRequest = {
      headers: {
        'user-agent': 'test-agent',
      },
      ip: '127.0.0.1',
    };
    jest.clearAllMocks();
  });

  describe('signup', () => {
    it('should successfully register a new user and return tokens', async () => {
      // Arrange
      const signupData = {
        email: 'test@example.com',
        password: 'StrongPassword123',
        role: 'creator' as const,
      };

      const mockUser = {
        _id: 'mockUserId123',
        email: signupData.email,
        role: 'creator',
        status: 'active',
        createdAt: new Date(),
        save: jest.fn(),
        toObject: jest.fn().mockReturnValue({
          _id: 'mockUserId123',
          email: signupData.email,
          role: 'creator',
          status: 'active',
          createdAt: new Date(),
        }),
      };

      (UserModel.findOne as jest.Mock).mockResolvedValue(null);
      (hash as jest.Mock).mockResolvedValue('hashedPassword123');
      (UserModel as unknown as jest.Mock).mockImplementation(() => mockUser);
      mockUser.save.mockResolvedValue(mockUser);

      const mockSession = {
        save: jest.fn().mockResolvedValue({}),
      };
      (AuthSessionModel as unknown as jest.Mock).mockImplementation(() => mockSession);

      // Act
      const result = await authService.signup(signupData, mockRequest as Request);

      // Assert
      expect(UserModel.findOne).toHaveBeenCalledWith({ email: signupData.email });
      expect(hash).toHaveBeenCalledWith(signupData.password, 10);
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('expiresIn', 900);
      expect(result).toHaveProperty('user');
      expect(result.user.email).toBe(signupData.email);
      expect(mockSession.save).toHaveBeenCalled();
    });

    it('should throw EmailAlreadyExists error when email is taken', async () => {
      // Arrange
      const signupData = {
        email: 'existing@example.com',
        password: 'Password123',
      };

      (UserModel.findOne as jest.Mock).mockResolvedValue({
        email: signupData.email,
      });

      // Act & Assert
      await expect(authService.signup(signupData, mockRequest as Request)).rejects.toThrow(
        'EmailAlreadyExists'
      );
      expect(UserModel.findOne).toHaveBeenCalledWith({ email: signupData.email });
    });
  });

  describe('login', () => {
    it('should successfully authenticate user and return tokens', async () => {
      // Arrange
      const loginData = {
        email: 'test@example.com',
        password: 'CorrectPassword123',
      };

      const mockUser = {
        _id: 'mockUserId123',
        email: loginData.email,
        hashedPassword: 'hashedPassword123',
        role: 'creator',
        status: 'active',
        lastSeenAt: null,
        save: jest.fn().mockResolvedValue({}),
        toObject: jest.fn().mockReturnValue({
          _id: 'mockUserId123',
          email: loginData.email,
          role: 'creator',
          status: 'active',
        }),
      };

      (UserModel.findOne as jest.Mock).mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser),
      });
      (compare as jest.Mock).mockResolvedValue(true);

      const mockSession = {
        save: jest.fn().mockResolvedValue({}),
      };
      (AuthSessionModel as unknown as jest.Mock).mockImplementation(() => mockSession);

      // Act
      const result = await authService.login(loginData, mockRequest as Request);

      // Assert
      expect(UserModel.findOne).toHaveBeenCalledWith({ email: loginData.email });
      expect(compare).toHaveBeenCalledWith(loginData.password, mockUser.hashedPassword);
      expect(mockUser.save).toHaveBeenCalled();
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('expiresIn', 900);
      expect(result).toHaveProperty('user');
      expect(result.user.email).toBe(loginData.email);
      expect(mockSession.save).toHaveBeenCalled();
    });

    it('should throw InvalidCredentials error when user not found', async () => {
      // Arrange
      const loginData = {
        email: 'nonexistent@example.com',
        password: 'Password123',
      };

      (UserModel.findOne as jest.Mock).mockReturnValue({
        select: jest.fn().mockResolvedValue(null),
      });

      // Act & Assert
      await expect(authService.login(loginData, mockRequest as Request)).rejects.toThrow(
        'InvalidCredentials'
      );
    });

    it('should throw InvalidCredentials error when password is incorrect', async () => {
      // Arrange
      const loginData = {
        email: 'test@example.com',
        password: 'WrongPassword',
      };

      const mockUser = {
        _id: 'mockUserId123',
        email: loginData.email,
        hashedPassword: 'hashedPassword123',
        role: 'creator',
        status: 'active',
      };

      (UserModel.findOne as jest.Mock).mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser),
      });
      (compare as jest.Mock).mockResolvedValue(false);

      // Act & Assert
      await expect(authService.login(loginData, mockRequest as Request)).rejects.toThrow(
        'InvalidCredentials'
      );
      expect(compare).toHaveBeenCalledWith(loginData.password, mockUser.hashedPassword);
    });

    it('should throw AccountSuspended error when user account is not active', async () => {
      // Arrange
      const loginData = {
        email: 'suspended@example.com',
        password: 'Password123',
      };

      const mockUser = {
        _id: 'mockUserId123',
        email: loginData.email,
        hashedPassword: 'hashedPassword123',
        role: 'creator',
        status: 'suspended',
      };

      (UserModel.findOne as jest.Mock).mockReturnValue({
        select: jest.fn().mockResolvedValue(mockUser),
      });
      (compare as jest.Mock).mockResolvedValue(true);

      // Act & Assert
      await expect(authService.login(loginData, mockRequest as Request)).rejects.toThrow(
        'AccountSuspended'
      );
    });
  });

  describe('token generation', () => {
    it('should generate valid JWT access tokens with correct structure', async () => {
      // Arrange
      const signupData = {
        email: 'tokentest@example.com',
        password: 'Password123',
      };

      const mockUser = {
        _id: 'mockUserId123',
        email: signupData.email,
        role: 'creator',
        status: 'active',
        save: jest.fn(),
        toObject: jest.fn().mockReturnValue({
          _id: 'mockUserId123',
          email: signupData.email,
          role: 'creator',
          status: 'active',
        }),
      };

      (UserModel.findOne as jest.Mock).mockResolvedValue(null);
      (hash as jest.Mock).mockResolvedValue('hashedPassword123');
      (UserModel as unknown as jest.Mock).mockImplementation(() => mockUser);
      mockUser.save.mockResolvedValue(mockUser);

      const mockSession = {
        save: jest.fn().mockResolvedValue({}),
      };
      (AuthSessionModel as unknown as jest.Mock).mockImplementation(() => mockSession);

      // Act
      const result = await authService.signup(signupData, mockRequest as Request);

      // Assert
      expect(result.accessToken).toBeDefined();
      expect(typeof result.accessToken).toBe('string');
      expect(result.refreshToken).toBeDefined();
      expect(typeof result.refreshToken).toBe('string');
      expect(result.refreshToken.length).toBe(64); // 32 bytes hex = 64 chars
      expect(result.expiresIn).toBe(900);
    });
  });
});

