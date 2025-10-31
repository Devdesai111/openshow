import { Request, Response, NextFunction } from 'express';
import { verify, JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env';

const ACCESS_TOKEN_SECRET = env.ACCESS_TOKEN_SECRET;

/** Defines the structure of the payload after JWT decoding. */
export interface IAuthUser extends JwtPayload {
  sub: string; // The user ID (MongoDB ObjectId string)
  role: 'creator' | 'owner' | 'admin';
  email: string;
}

// Global declaration merging to add 'user' property to Request
declare module 'express-serve-static-core' {
  interface Request {
    user?: IAuthUser;
  }
}

/**
 * Middleware to extract and validate the JWT.
 * On success, populates req.user with decoded payload.
 */
export const authenticate = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  // 1. Check for token presence (401 Unauthorized)
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: {
        code: 'no_token',
        message: 'Authentication token is missing or malformed.',
      },
    });
    return;
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({
      error: {
        code: 'no_token',
        message: 'Authentication token is missing or malformed.',
      },
    });
    return;
  }

  try {
    // 2. Verify token
    const decoded = verify(token, ACCESS_TOKEN_SECRET);

    // Type guard to ensure decoded has required properties
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'sub' in decoded &&
      'role' in decoded &&
      'email' in decoded
    ) {
      const authUser = decoded as IAuthUser;

      // 3. Populate req.user (Strict Typing)
      if (!authUser.sub || !authUser.role || !authUser.email) {
        throw new Error('Required token claims missing.');
      }

      req.user = authUser;
      next();
    } else {
      throw new Error('Invalid token structure');
    }
  } catch {
    // 4. Handle expired/invalid token (401 Unauthorized)
    res.status(401).json({
      error: {
        code: 'invalid_token',
        message: 'Authentication token is invalid or has expired.',
      },
    });
  }
};

/**
 * Optional authentication middleware - allows requests to proceed without a token.
 * If a valid token is provided, populates req.user. Otherwise, req.user remains undefined.
 * Useful for public endpoints that need to show different data based on authentication status.
 */
export const optionalAuthenticate = (req: Request, _res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  // If no auth header, proceed without req.user
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    next();
    return;
  }

  try {
    // Verify token if present
    const decoded = verify(token, ACCESS_TOKEN_SECRET);

    // Type guard to ensure decoded has required properties
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'sub' in decoded &&
      'role' in decoded &&
      'email' in decoded
    ) {
      const authUser = decoded as IAuthUser;

      // Populate req.user only if token is valid
      if (authUser.sub && authUser.role && authUser.email) {
        req.user = authUser;
      }
    }

    // Always proceed (even if token is invalid, don't block request)
    next();
  } catch {
    // If token is invalid/expired, just proceed without req.user
    next();
  }
};
