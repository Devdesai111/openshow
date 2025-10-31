import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';

describe('Auth Routes Integration Tests', () => {
  // Test database connection setup
  beforeAll(async () => {
    // Use test database
    const testDbUri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/openshow-test';
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    await mongoose.connect(testDbUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    // Clean up database before each test
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
  });

  describe('POST /auth/signup', () => {
    it('should successfully register a new user (201 Created)', async () => {
      // Arrange
      const signupData = {
        email: 'newuser@example.com',
        password: 'StrongPassword123',
        role: 'creator',
        fullName: 'Test User',
      };

      // Act
      const response = await request(app).post('/auth/signup').send(signupData);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body).toHaveProperty('tokenType', 'Bearer');
      expect(response.body).toHaveProperty('expiresIn', 900);
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('id');
      expect(response.body.user).toHaveProperty('email', signupData.email);
      expect(response.body.user).toHaveProperty('role', 'creator');
      expect(response.body.user).toHaveProperty('status', 'active');
      expect(response.body.user).toHaveProperty('fullName', signupData.fullName);
      expect(response.body.user).toHaveProperty('createdAt');
      expect(response.body.user).not.toHaveProperty('hashedPassword');

      // Verify user was created in database
      const user = await UserModel.findOne({ email: signupData.email });
      expect(user).toBeTruthy();
      expect(user?.email).toBe(signupData.email);

      // Verify session was created
      const session = await AuthSessionModel.findOne({ userId: user?._id });
      expect(session).toBeTruthy();
      expect(session?.refreshTokenHash).toBeDefined();
    });

    it('should return 422 when password is too short', async () => {
      // Arrange
      const signupData = {
        email: 'test@example.com',
        password: 'short',
      };

      // Act
      const response = await request(app).post('/auth/signup').send(signupData);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'validation_error');
      expect(response.body.error).toHaveProperty('message', 'Input validation failed');
      expect(response.body.error).toHaveProperty('details');
      expect(Array.isArray(response.body.error.details)).toBe(true);
    });

    it('should return 422 when email is invalid', async () => {
      // Arrange
      const signupData = {
        email: 'invalid-email',
        password: 'StrongPassword123',
      };

      // Act
      const response = await request(app).post('/auth/signup').send(signupData);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 409 when email already exists', async () => {
      // Arrange
      const signupData = {
        email: 'duplicate@example.com',
        password: 'StrongPassword123',
        role: 'creator',
      };

      // Create user first
      await request(app).post('/auth/signup').send(signupData);

      // Act - Try to create again
      const response = await request(app).post('/auth/signup').send(signupData);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'already_exists');
      expect(response.body.error).toHaveProperty(
        'message',
        'The provided email is already registered.'
      );
    });

    it('should default role to creator when not specified', async () => {
      // Arrange
      const signupData = {
        email: 'defaultrole@example.com',
        password: 'StrongPassword123',
      };

      // Act
      const response = await request(app).post('/auth/signup').send(signupData);

      // Assert
      expect(response.status).toBe(201);
      expect(response.body.user).toHaveProperty('role', 'creator');
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      // Create a test user for login tests
      await request(app).post('/auth/signup').send({
        email: 'logintest@example.com',
        password: 'TestPassword123',
        role: 'creator',
      });
    });

    it('should successfully login with correct credentials (200 OK)', async () => {
      // Arrange
      const loginData = {
        email: 'logintest@example.com',
        password: 'TestPassword123',
      };

      // Act
      const response = await request(app).post('/auth/login').send(loginData);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('accessToken');
      expect(response.body).toHaveProperty('refreshToken');
      expect(response.body).toHaveProperty('tokenType', 'Bearer');
      expect(response.body).toHaveProperty('expiresIn', 900);
      expect(response.body).toHaveProperty('user');
      expect(response.body.user).toHaveProperty('id');
      expect(response.body.user).toHaveProperty('email', loginData.email);
      expect(response.body.user).toHaveProperty('role', 'creator');
      expect(response.body.user).toHaveProperty('status', 'active');
      expect(response.body.user).not.toHaveProperty('hashedPassword');

      // Verify lastSeenAt was updated
      const user = await UserModel.findOne({ email: loginData.email });
      expect(user?.lastSeenAt).toBeTruthy();
    });

    it('should return 401 with incorrect password', async () => {
      // Arrange
      const loginData = {
        email: 'logintest@example.com',
        password: 'WrongPassword123',
      };

      // Act
      const response = await request(app).post('/auth/login').send(loginData);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'invalid_credentials');
      expect(response.body.error).toHaveProperty('message', 'Email or password incorrect.');
    });

    it('should return 401 with non-existent email', async () => {
      // Arrange
      const loginData = {
        email: 'nonexistent@example.com',
        password: 'TestPassword123',
      };

      // Act
      const response = await request(app).post('/auth/login').send(loginData);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'invalid_credentials');
    });

    it('should return 422 when email is missing', async () => {
      // Arrange
      const loginData = {
        password: 'TestPassword123',
      };

      // Act
      const response = await request(app).post('/auth/login').send(loginData);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 when password is missing', async () => {
      // Arrange
      const loginData = {
        email: 'logintest@example.com',
      };

      // Act
      const response = await request(app).post('/auth/login').send(loginData);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should create a new session on login', async () => {
      // Arrange
      const loginData = {
        email: 'logintest@example.com',
        password: 'TestPassword123',
      };

      const user = await UserModel.findOne({ email: loginData.email });
      const sessionsBefore = await AuthSessionModel.countDocuments({ userId: user?._id });

      // Act
      await request(app).post('/auth/login').send(loginData);

      // Assert
      const sessionsAfter = await AuthSessionModel.countDocuments({ userId: user?._id });
      expect(sessionsAfter).toBe(sessionsBefore + 1);
    });
  });

  describe('Token behavior', () => {
    it('should generate different tokens for each signup', async () => {
      // Act
      const response1 = await request(app).post('/auth/signup').send({
        email: 'user1@example.com',
        password: 'Password123',
      });

      const response2 = await request(app).post('/auth/signup').send({
        email: 'user2@example.com',
        password: 'Password123',
      });

      // Assert
      expect(response1.body.accessToken).not.toBe(response2.body.accessToken);
      expect(response1.body.refreshToken).not.toBe(response2.body.refreshToken);
    });

    it('should generate different tokens for each login of same user', async () => {
      // Arrange
      await request(app).post('/auth/signup').send({
        email: 'multilogin@example.com',
        password: 'Password123',
      });

      // Act
      const login1 = await request(app).post('/auth/login').send({
        email: 'multilogin@example.com',
        password: 'Password123',
      });

      // Wait 1 second to ensure different timestamp in JWT
      await new Promise(resolve => setTimeout(resolve, 1000));

      const login2 = await request(app).post('/auth/login').send({
        email: 'multilogin@example.com',
        password: 'Password123',
      });

      // Assert
      expect(login1.body.accessToken).not.toBe(login2.body.accessToken);
      expect(login1.body.refreshToken).not.toBe(login2.body.refreshToken);
    });
  });
});

