import { Request } from 'express';
import { compare, hash } from 'bcryptjs';
import { sign } from 'jsonwebtoken';
import { Types } from 'mongoose';
import crypto from 'crypto';
import * as speakeasy from 'speakeasy';
import { UserModel, IUser } from '../models/user.model';
import { AuthSessionModel } from '../models/authSession.model';
import { PasswordResetModel } from '../models/passwordReset.model';
import { TwoFATempModel } from '../models/twoFATemp.model';
import { env } from '../config/env';
import { MFA_REQUIRED_ROLES } from '../config/permissions';

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

// Mock KMS or simple encryption utility for sensitive field storage
class KMSEncryption {
  public encrypt(data: string): string {
    // PRODUCTION: Use actual KMS/Vault
    return `encrypted:${data}`;
  }
  public decrypt(data: string): string {
    return data.replace('encrypted:', '');
  }
}
const kms = new KMSEncryption();

const APP_NAME = 'OpenShow';
const TEMP_SECRET_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
    await saveRefreshToken(
      savedUser._id as Types.ObjectId,
      tokenPair.refreshToken,
      req,
      rememberMe
    );

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

    // 1. Find user, explicitly requesting password hash, 2FA status, and role/status for comparison
    const user = await UserModel.findOne({ email }).select('+hashedPassword twoFA role status');
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

    // 4. MFA ENFORCEMENT CHECK (CRITICAL for Admin users)
    if (MFA_REQUIRED_ROLES.includes(user.role) && (!user.twoFA || !user.twoFA.enabled)) {
      throw new Error('MfaSetupRequired');
    }

    // 5. Update last seen time (minimal DB write)
    user.lastSeenAt = new Date();
    await user.save();

    // 6. Generate tokens and save session
    const tokenPair = generateTokens(user);
    await saveRefreshToken(user._id as Types.ObjectId, tokenPair.refreshToken, req, rememberMe);

    // 7. Return tokens and sanitized user object
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
  public async requestPasswordReset(data: { email: string; redirectUrl: string }): Promise<void> {
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

  /**
   * Renews tokens using a Refresh Token. Implements token rotation.
   * @throws {Error} - 'SessionExpired' | 'SessionRevoked' | 'UserNotFound'.
   */
  public async refreshTokens(refreshToken: string, req: Request): Promise<ITokenPair> {
    // 1. Find the session by comparing the plain token to all hashed tokens in DB
    const sessions = await AuthSessionModel.find({
      expiresAt: { $gt: new Date() }, // Only check non-expired sessions
    });

    // Use a loop + async compare to find the match
    let matchedSession = null;
    for (const session of sessions) {
      const isMatch = await compare(refreshToken, session.refreshTokenHash);
      if (isMatch) {
        matchedSession = session;
        break;
      }
    }

    if (!matchedSession) {
      throw new Error('SessionExpired');
    }

    // 2. Fetch the user associated with the session
    const user = (await UserModel.findById(matchedSession.userId).lean()) as IUser | null;
    if (!user) {
      throw new Error('UserNotFound');
    }

    // 3. Invalidate the old refresh token (Rotation: mark as expired/used)
    // SECURITY: This prevents replay attacks if the old token was compromised
    matchedSession.expiresAt = new Date(); // Set expiry to now
    await matchedSession.save();

    // 4. Generate new tokens and save the new session
    const tokenPair = generateTokens(user);
    await saveRefreshToken(user._id as Types.ObjectId, tokenPair.refreshToken, req, true);

    return tokenPair;
  }

  /**
   * Retrieves the current user's profile information.
   * @throws {Error} - 'UserNotFound' | 'AccountSuspended'.
   */
  public async getAuthMe(userId: string): Promise<IUser> {
    // 1. Find user (select all fields explicitly for DTO mapping)
    const user = (await UserModel.findById(new Types.ObjectId(userId)).lean()) as IUser | null;

    if (!user) {
      throw new Error('UserNotFound');
    }

    // 2. Status check
    if (user.status !== 'active' && user.status !== 'pending') {
      throw new Error('AccountSuspended');
    }

    // 3. Update lastSeenAt (optional, minimal write)
    await UserModel.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date() } });

    // 4. Return user
    return user;
  }

  /**
   * Revokes a specific refresh token session (Logout).
   * @param refreshToken - The plain opaque refresh token.
   * @throws {Error} - 'SessionNotFound'.
   */
  public async logout(refreshToken: string): Promise<void> {
    if (!refreshToken) {
      throw new Error('RefreshTokenRequired');
    }

    // Find the session matching the plain token (must check all hashes)
    const sessions = await AuthSessionModel.find({});
    let matchedSession = null;
    for (const session of sessions) {
      // ASYNC AWAIT: Use async hash comparison
      const isMatch = await compare(refreshToken, session.refreshTokenHash);
      if (isMatch) {
        matchedSession = session;
        break;
      }
    }

    if (!matchedSession) {
      throw new Error('SessionNotFound');
    }

    // Revoke the session (delete is cleaner than setting expiresAt=now)
    await AuthSessionModel.deleteOne({ _id: matchedSession._id });

    // PRODUCTION: Emit 'user.loggedOut' event for audit logging (Task 60)
    console.warn(`[Event] User ${matchedSession.userId.toString()} logged out.`);
  }

  /**
   * Starts the 2FA enrollment process by generating a secret and temporary enrollment ID.
   * @throws {Error} - 'AlreadyEnabled' | 'UserNotFound'.
   */
  public async enable2FA(
    userId: string,
    email: string
  ): Promise<{ tempSecretId: string; otpauthUrl: string; expiresAt: Date }> {
    const user = (await UserModel.findById(new Types.ObjectId(userId))
      .select('twoFA')
      .lean()) as IUser | null;

    if (!user || !user.twoFA) {
      throw new Error('UserNotFound');
    }
    if (user.twoFA.enabled) {
      throw new Error('AlreadyEnabled');
    }

    // 1. Generate the TOTP secret
    const secret = speakeasy.generateSecret({
      name: `${APP_NAME}:${email}`,
      length: 20,
    });

    // 2. Encrypt the secret for temporary storage (SECURITY)
    const tempSecretEncrypted = kms.encrypt(secret.base32);
    const expiresAt = new Date(Date.now() + TEMP_SECRET_TTL_MS);

    // 3. Store the temporary secret (awaiting verification in Task 6)
    const tempRecord = new TwoFATempModel({
      userId: new Types.ObjectId(userId),
      tempSecretEncrypted,
      expiresAt,
    });
    await tempRecord.save();

    // 4. Return necessary data for client (otpauthUrl for QR code display)
    return {
      tempSecretId: tempRecord._id?.toString() || '',
      otpauthUrl: secret.otpauth_url || '',
      expiresAt,
    };
  }

  /**
   * Verifies the TOTP code against the temporary secret and finalizes 2FA enrollment.
   * @throws {Error} - 'SecretNotFound' | 'TokenInvalid' | 'SecretExpired'.
   */
  public async verify2FA(tempSecretId: string, token: string, userId: string): Promise<Date> {
    // 1. Retrieve and validate the temporary secret
    const tempRecord = await TwoFATempModel.findById(new Types.ObjectId(tempSecretId));

    if (!tempRecord) {
      throw new Error('SecretNotFound');
    }
    if (tempRecord.userId.toString() !== userId) {
      throw new Error('SecretMismatch'); // Failsafe for security
    }
    if (tempRecord.expiresAt < new Date()) {
      await TwoFATempModel.deleteOne({ _id: tempSecretId });
      throw new Error('SecretExpired');
    }

    // 2. Decrypt the secret
    const secretBase32 = kms.decrypt(tempRecord.tempSecretEncrypted);

    // 3. Verify the TOTP token
    const isVerified = speakeasy.totp.verify({
      secret: secretBase32,
      encoding: 'base32',
      token: token,
      window: 1, // Allow 1 step (30s) either side of the current time
    });

    if (!isVerified) {
      throw new Error('TokenInvalid');
    }

    // 4. Finalize enrollment: Move secret to permanent user storage
    const enabledAt = new Date();
    const user = await UserModel.findById(new Types.ObjectId(userId));

    if (!user) {
      throw new Error('UserNotFound');
    }

    user.twoFA = {
      enabled: true,
      totpSecretEncrypted: tempRecord.tempSecretEncrypted, // Store encrypted permanent secret
      enabledAt: enabledAt,
    };
    await user.save();

    // 5. Clean up temporary record (important for security)
    await TwoFATempModel.deleteOne({ _id: tempSecretId });

    // PRODUCTION: Emit '2fa.enabled' event
    console.warn(`[Event] User ${userId} successfully enabled 2FA.`);

    return enabledAt;
  }

  /**
   * Disables 2FA (requires re-auth/password/TOTP confirmation in a robust system).
   */
  public async disable2FA(userId: string): Promise<void> {
    const user = await UserModel.findById(new Types.ObjectId(userId)).select('twoFA');

    if (!user || !user.twoFA || !user.twoFA.enabled) {
      throw new Error('NotEnabled');
    }

    user.twoFA.enabled = false;
    user.twoFA.totpSecretEncrypted = undefined;
    user.twoFA.enabledAt = undefined;
    await user.save();

    // PRODUCTION: Emit '2fa.disabled' event
    console.warn(`[Event] User ${userId} successfully disabled 2FA.`);
  }

  // --- Admin Endpoints ---

  /** Suspends a target user account. */
  public async suspendUser(targetUserId: string, reason: string, until?: Date): Promise<IUser> {
    const user = await UserModel.findById(new Types.ObjectId(targetUserId));
    if (!user) {
      throw new Error('TargetUserNotFound');
    }

    user.status = 'suspended';
    // PRODUCTION: Store suspension metadata (reason, suspendedBy, until) in a separate log/collection
    await user.save();

    // PRODUCTION: Emit 'user.suspended' event
    console.warn(
      `[Event] User ${targetUserId} suspended. Reason: ${reason}. Until: ${until?.toISOString() || 'indefinite'}`
    );
    return user.toObject() as IUser;
  }

  /** Unsuspends a target user account. */
  public async unsuspendUser(targetUserId: string): Promise<IUser> {
    const user = await UserModel.findById(new Types.ObjectId(targetUserId));
    if (!user) {
      throw new Error('TargetUserNotFound');
    }

    user.status = 'active';
    await user.save();

    // PRODUCTION: Emit 'user.unsuspended' event
    console.warn(`[Event] User ${targetUserId} unsuspended.`);
    return user.toObject() as IUser;
  }

  /**
   * Confirms the reset token and updates the user's password.
   * @throws {Error} - 'TokenInvalid' | 'TokenExpired' | 'TokenUsed' | 'UserNotFound'.
   */
  public async confirmPasswordReset(plainToken: string, newPassword: string): Promise<void> {
    // 1. Find and validate the token record
    const resetRecords = await PasswordResetModel.find({
      isUsed: false,
      expiresAt: { $gt: new Date() },
    });

    let matchedRecord = null;
    for (const record of resetRecords) {
      // ASYNC AWAIT: Compare plain token against stored hash
      const isMatch = await compare(plainToken, record.tokenHash);
      if (isMatch) {
        matchedRecord = record;
        break;
      }
    }

    if (!matchedRecord) {
      // Use generic 'TokenInvalid' to not distinguish between invalid/expired/used.
      throw new Error('TokenInvalid');
    }

    // 2. Hash the new password
    const newHashedPassword = await hash(newPassword, 10);

    // 3. Update user password and invalidate all sessions (SECURITY: Logout everywhere)
    await UserModel.updateOne(
      { _id: matchedRecord.userId },
      { $set: { hashedPassword: newHashedPassword } }
    );

    await AuthSessionModel.deleteMany({ userId: matchedRecord.userId }); // Revoke all sessions

    // 4. Mark the reset token as used
    await PasswordResetModel.updateOne({ _id: matchedRecord._id }, { $set: { isUsed: true } });

    // PRODUCTION: Emit 'password.reset.confirmed' event for AuditLog (Task 60)
    console.warn(`[Event] User ${matchedRecord.userId.toString()} successfully reset password.`);
  }
}
