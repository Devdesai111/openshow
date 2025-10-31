import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { UserSettingsModel } from '../../src/models/userSettings.model';

describe('User Settings CRUD Integration Tests', () => {
  let userAToken: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
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
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await UserSettingsModel.deleteMany({});

    // Create user A
    const userASignup = await request(app).post('/auth/signup').send({
      email: 'usera@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'User A',
    });
    userAToken = userASignup.body.accessToken;
    const userA = await UserModel.findOne({ email: 'usera@example.com' });
    userAId = userA!._id.toString();

    // Create user B
    await request(app).post('/auth/signup').send({
      email: 'userb@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'User B',
    });
    const userB = await UserModel.findOne({ email: 'userb@example.com' });
    userBId = userB!._id.toString();
  });

  describe('GET /settings/:userId', () => {
    it('T44.1 - should return default settings for new user (200 OK)', async () => {
      // Act
      const response = await request(app)
        .get(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('userId', userAId);
      expect(response.body).toHaveProperty('notificationPrefs');
      expect(response.body.notificationPrefs).toEqual({
        in_app: true,
        email: true,
        push: true,
      });
    });

    it('should return existing settings if already created', async () => {
      // Arrange - Create settings first
      await UserSettingsModel.create({
        userId: new mongoose.Types.ObjectId(userAId),
        notificationPrefs: {
          in_app: false,
          email: true,
          push: false,
        },
      });

      // Act
      const response = await request(app)
        .get(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.notificationPrefs).toEqual({
        in_app: false,
        email: true,
        push: false,
      });
    });

    it('should return 403 when user tries to access another user\'s settings', async () => {
      // Act
      const response = await request(app)
        .get(`/settings/${userBId}`)
        .set('Authorization', `Bearer ${userAToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).get(`/settings/${userAId}`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should return 422 for invalid userId format', async () => {
      // Act
      const response = await request(app)
        .get('/settings/invalid_id')
        .set('Authorization', `Bearer ${userAToken}`);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should not expose payoutMethod details in response', async () => {
      // Arrange - Create settings with payout method
      await UserSettingsModel.create({
        userId: new mongoose.Types.ObjectId(userAId),
        payoutMethod: {
          type: 'stripe_connect',
          details: { accountId: 'acct_123', secretKey: 'sk_test_123' },
          isVerified: false,
        },
      });

      // Act
      const response = await request(app)
        .get(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.payoutMethod).toBeDefined();
      expect(response.body.payoutMethod.details).toBeUndefined(); // Details should be hidden
      expect(response.body.payoutMethod.type).toBe('stripe_connect');
      expect(response.body.payoutMethod.isVerified).toBe(false);
    });
  });

  describe('PUT /settings/:userId', () => {
    it('T44.2 - should successfully update notification preferences (200 OK)', async () => {
      // Act
      const response = await request(app)
        .put(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          notificationPrefs: {
            email: false,
            in_app: true,
            push: true,
          },
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('userId', userAId);
      expect(response.body.notificationPrefs).toEqual({
        email: false,
        in_app: true,
        push: true,
      });

      // Verify persistence
      const settings = await UserSettingsModel.findOne({ userId: userAId }).lean();
      expect(settings!.notificationPrefs.email).toBe(false);
    });

    it('should successfully update payout method', async () => {
      // Act
      const response = await request(app)
        .put(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          payoutMethod: {
            type: 'stripe_connect',
            details: { accountId: 'acct_xyz' },
            isVerified: false,
            providerAccountId: 'acct_xyz',
          },
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.payoutMethod).toBeDefined();
      expect(response.body.payoutMethod.type).toBe('stripe_connect');
      expect(response.body.payoutMethod.details).toBeUndefined(); // Details hidden
      expect(response.body.payoutMethod.providerAccountId).toBe('acct_xyz');

      // Verify persistence (explicitly select details field which is hidden by default)
      const settings = await UserSettingsModel.findOne({ userId: userAId })
        .select('+payoutMethod.details')
        .lean();
      expect(settings!.payoutMethod?.type).toBe('stripe_connect');
      expect((settings!.payoutMethod as any).details).toBeDefined(); // Details stored in DB
    });

    it('should merge notification preferences (partial update)', async () => {
      // Arrange - Create initial settings
      await UserSettingsModel.create({
        userId: new mongoose.Types.ObjectId(userAId),
        notificationPrefs: {
          in_app: true,
          email: true,
          push: true,
        },
      });

      // Act - Update only email
      const response = await request(app)
        .put(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          notificationPrefs: {
            email: false,
          },
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.notificationPrefs.email).toBe(false);
      expect(response.body.notificationPrefs.in_app).toBe(true); // Preserved
      expect(response.body.notificationPrefs.push).toBe(true); // Preserved
    });

    it('T44.3 - should return 403 when user tries to update another user\'s settings', async () => {
      // Act
      const response = await request(app)
        .put(`/settings/${userBId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          notificationPrefs: {
            email: false,
          },
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('own settings');
    });

    it('T44.4 - should return 422 for invalid payout method type', async () => {
      // Act
      const response = await request(app)
        .put(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          payoutMethod: {
            type: 'invalid_type',
            details: {},
            isVerified: false,
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should return 422 for invalid notification prefs (non-boolean)', async () => {
      // Act
      const response = await request(app)
        .put(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          notificationPrefs: {
            email: 'not-a-boolean',
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).put(`/settings/${userAId}`).send({
        notificationPrefs: {
          email: false,
        },
      });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should return 422 for invalid userId format', async () => {
      // Act
      const response = await request(app)
        .put('/settings/invalid_id')
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          notificationPrefs: {
            email: false,
          },
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should handle updating both notification prefs and payout method', async () => {
      // Act
      const response = await request(app)
        .put(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          notificationPrefs: {
            email: false,
            push: false,
          },
          payoutMethod: {
            type: 'razorpay_account',
            details: { accountId: 'acc_123' },
            isVerified: true,
            providerAccountId: 'acc_123',
          },
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.notificationPrefs.email).toBe(false);
      expect(response.body.notificationPrefs.push).toBe(false);
      expect(response.body.payoutMethod.type).toBe('razorpay_account');
      expect(response.body.payoutMethod.isVerified).toBe(true);
    });

    it('should support bank_transfer payout method type', async () => {
      // Act
      const response = await request(app)
        .put(`/settings/${userAId}`)
        .set('Authorization', `Bearer ${userAToken}`)
        .send({
          payoutMethod: {
            type: 'bank_transfer',
            details: {
              accountNumber: '123456789',
              ifscCode: 'IFSC123',
              bankName: 'Test Bank',
            },
            isVerified: false,
          },
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.payoutMethod.type).toBe('bank_transfer');
      expect(response.body.payoutMethod.details).toBeUndefined(); // Details hidden
    });
  });
});

