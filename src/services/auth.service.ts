import { Request } from 'express';
import { compare, hash } from 'bcryptjs';
import { sign } from 'jsonwebtoken';
import { Types } from 'mongoose';
import crypto from 'crypto';
import { UserModel, IUser } from '../models/user.model';
import { AuthSessionModel } from '../models/authSession.model';
import { PasswordResetModel } from '../models/passwordReset.model';
import { env } from '../config/env';

// Token configuration
const ACCESS_TOKEN_SECRET = env.ACCESS_TOKEN_SECRET;
// REFRESH_TOKEN_SECRET will be used in Task 3 for token refresh endpoint
// const REFRESH_TOKEN_SECRET = env.REFRESH_TOKEN_SECRET;
const ACCESS_TOKEN_EXPIRY_S = 900; // 15 minutes in seconds

// DTO for token response
interface ITokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Utility to generate access and refresh tokens
 */
const generateTokens = (user: IUser): ITokenPair => {
  const payload = {
    sub: user._id?.toString(),
    role: user.role,
    email: user.email,
    iss: 'OpenShow', // Issuer
    aud: 'OpenShow', // Audience
  };

  // 1. Access Token (JWT) - Short lived
  const accessToken = sign(payload, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY_S });

  // 2. Refresh Token (Opaque String) - Long lived
  const refreshToken = crypto.randomBytes(32).toString('hex');

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_EXPIRY_S };
};

/**
 * Saves the hashed refresh token securely in the DB (AuthSession).
 * @param userId - The user's ID
 * @param refreshToken - The plain opaque refresh token string.
 * @param req - Express request to log IP/User-Agent.
 * @param rememberMe - If true, sets a longer expiration.
 */
const saveRefreshToken = async (
  userId: Types.ObjectId,
  refreshToken: string,
  req: Request,
  rememberMe: boolean = false
): Promise<void> => {
  // SECURITY: Hash the opaque token before saving
  const refreshTokenHash = await hash(refreshToken, 10);

  // Set expiry: 30 days if 'rememberMe', else 7 days
  const expiryDays = rememberMe ? 30 : 7;
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  const session = new AuthSessionModel({
    userId,
    refreshTokenHash,
    userAgent: req.headers['user-agent'],
    ip: req.ip,
    expiresAt,
  });
  await session.save();
};

// --- Mocks/Placeholders for External Services ---

// Mock OAuthProvider utility (in a production environment, this calls external Google/GitHub APIs)
class OAuthProvider {
  // Mock successful validation and returns normalized user data
  public async validateToken(
    _provider: string,
    token: string
  ): Promise<{ providerId: string; email: string; fullName?: string }> {
    if (token === 'invalid-token') {
      throw new Error('Provider token validation failed.');
    }
    // In a real app, this verifies the token with the provider's API.
    return {
      providerId:
        'prov_id_' + crypto.createHash('sha256').update(token).digest('hex').substring(0, 10),
      email: 'oauth.user@example.com', // Placeholder
      fullName: 'OAuth User',
    };
  }
}

// Mock NotificationService (in a real app, this is a separate service/module)
class NotificationService {
  public async sendPasswordResetEmail(
    email: string,
    token: string,
    redirectUrl: string
  ): Promise<void> {
    // PRODUCTION: This would publish an event or call the Notifications Service API (Task 11)
    console.warn(
      `[Mock Notification] Sending reset email to ${email} with token: ${token} and link: ${redirectUrl}?token=${token}`
    );
    return;
  }
}

const oauthProvider = new OAuthProvider();
const notificationService = new NotificationService();

export class AuthService {
  /**
   * Registers a new user.
   * @throws {Error} - 'EmailAlreadyExists' | 'ValidationError'.
   */
  public async signup(
    data: {
      email: string;
      password: string;
      role?: 'creator' | 'owner';
      fullName?: string;
      preferredName?: string;
      rememberMe?: boolean;
    },
    req: Request
  ): Promise<ITokenPair & { user: IUser }> {
    const { email, password, role, fullName, preferredName, rememberMe } = data;

    // 1. Check for existing user
    const existingUser = await UserModel.findOne({ email });
    if (existingUser) {
      throw new Error('EmailAlreadyExists');
    }

    // 2. Hash password (SECURITY: use strong algorithm and salt)
    const hashedPassword = await hash(password, 10); // Cost factor 10
    const newUser = new UserModel({
      email,
      hashedPassword,
      role: role || 'creator',
      fullName,
      preferredName,
      status: 'active', // Phase 1: auto-active
    });
    const savedUser = await newUser.save();

    // 3. Generate tokens and save session
    const tokenPair = generateTokens(savedUser);
    await saveRefreshToken(savedUser._id as Types.ObjectId, tokenPair.refreshToken, req, rememberMe);

    // 4. Return tokens and sanitized user object
    const userObject = savedUser.toObject({ getters: true, virtuals: true }) as IUser;
    delete userObject.hashedPassword; // Ensure hash is not returned

    return { ...tokenPair, user: userObject };
  }

  /**
   * Authenticates a user and returns tokens.
   * @throws {Error} - 'InvalidCredentials' | 'AccountSuspended'.
   */
  public async login(
    data: {
      email: string;
      password: string;
      rememberMe?: boolean;
    },
    req: Request
  ): Promise<ITokenPair & { user: IUser }> {
    const { email, password, rememberMe } = data;

    // 1. Find user, explicitly requesting password hash for comparison
    const user = await UserModel.findOne({ email }).select('+hashedPassword');
    if (!user || !user.hashedPassword) {
      throw new Error('InvalidCredentials');
    }

    // 2. Compare password (ASYNC operation)
    const isMatch = await compare(password, user.hashedPassword);
    if (!isMatch) {
      throw new Error('InvalidCredentials');
    }

    // 3. Status Check (RBAC: enforce account status)
    if (user.status !== 'active') {
      throw new Error('AccountSuspended');
    }

    // 4. Update last seen time (minimal DB write)
    user.lastSeenAt = new Date();
    await user.save();

    // 5. Generate tokens and save session
    const tokenPair = generateTokens(user);
    await saveRefreshToken(user._id as Types.ObjectId, tokenPair.refreshToken, req, rememberMe);

    // 6. Return tokens and sanitized user object
    const userObject = user.toObject({ getters: true, virtuals: true }) as IUser;
    delete userObject.hashedPassword;

    return { ...tokenPair, user: userObject };
  }

  /**
   * Handles OAuth login/signup flow.
   * @throws {Error} - 'OAuthValidationFailed'.
   */
  public async oauthLogin(
    data: {
      provider: 'google' | 'github' | 'linkedin';
      providerAccessToken: string;
      role?: 'creator' | 'owner';
    },
    req: Request
  ): Promise<ITokenPair & { user: IUser }> {
    const { provider, providerAccessToken, role } = data;

    // 1. Validate token with external provider (ASYNC)
    const providerData = await oauthProvider.validateToken(provider, providerAccessToken);
    const { providerId, email, fullName } = providerData;

    // 2. Find existing user by social account or email
    let user = await UserModel.findOne({
      $or: [{ 'socialAccounts.providerId': providerId }, { email: email }],
    }).select('+hashedPassword'); // Select hash to satisfy IUser type internally, even if it's null/undefined

    if (!user) {
      // 3. New User Signup
      const newUser = new UserModel({
        email,
        role: role || 'creator',
        fullName,
        status: 'active',
        socialAccounts: [{ provider, providerId, connectedAt: new Date() }],
      });
      user = await newUser.save();
    } else {
      // 4. Existing User Login/Account Linking

      // Check for potential conflict: if found by email, but socialAccounts are different
      const isLinked = user.socialAccounts.some(acc => acc.providerId === providerId);
      if (!isLinked) {
        // Link account if authenticated via email but logging in via new social provider
        user.socialAccounts.push({ provider, providerId, connectedAt: new Date() });
        await user.save();
      }

      user.lastSeenAt = new Date();
      await user.save();
    }

    // 5. Generate tokens and save session
    const tokenPair = generateTokens(user);
    await saveRefreshToken(user._id as Types.ObjectId, tokenPair.refreshToken, req, true);

    const userObject = user.toObject({ getters: true, virtuals: true }) as IUser;
    delete userObject.hashedPassword;

    return { ...tokenPair, user: userObject };
  }

  /**
   * Initiates the password reset flow.
   * Generates and stores a unique token, then schedules an email.
   * @returns Always returns success to prevent user enumeration.
   */
  public async requestPasswordReset(data: {
    email: string;
    redirectUrl: string;
  }): Promise<void> {
    const { email, redirectUrl } = data;

    // 1. Find user (don't throw if not found - SECURITY)
    const user = (await UserModel.findOne({ email }).lean()) as IUser | null;

    if (user) {
      // 2. Generate secure, single-use token (Opaque string)
      const plainToken = crypto.randomBytes(20).toString('hex');
      const tokenHash = await hash(plainToken, 10); // Hash token for secure storage

      // Set expiry: 1 hour (configurable)
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      // 3. Invalidate any previous tokens for this user and store the new one
      await PasswordResetModel.updateMany({ userId: user._id, isUsed: false }, { isUsed: true }); // Invalidate old tokens

      const passwordReset = new PasswordResetModel({
        userId: user._id,
        tokenHash,
        expiresAt,
      });
      await passwordReset.save();

      // 4. Send email (Mocked service call)
      await notificationService.sendPasswordResetEmail(email, plainToken, redirectUrl);
    }

    // 5. Return success regardless of whether the user exists (SECURITY)
    return;
  }
}

