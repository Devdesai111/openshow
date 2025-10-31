import { Request } from 'express';
import { compare, hash } from 'bcryptjs';
import { sign } from 'jsonwebtoken';
import { Types } from 'mongoose';
import crypto from 'crypto';
import { UserModel, IUser } from '../models/user.model';
import { AuthSessionModel } from '../models/authSession.model';
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
}

