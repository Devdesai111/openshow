// src/middleware/mfa.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { MFA_REQUIRED_ROLES } from '../config/permissions';
import { UserModel } from '../models/user.model';

/**
 * Middleware to enforce Two-Factor Authentication (MFA) for sensitive operations.
 * Requires the 'authenticate' and 'authorize' middleware to run before it.
 */
export const mfaEnforcement = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // This middleware runs *after* authenticate and authorize, so we know the user is authenticated and authorized by role.

  if (!req.user) {
    res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Authentication required.',
      },
    });
    return;
  }

  // 1. Check if user is in an MFA-required role
  if (!MFA_REQUIRED_ROLES.includes(req.user.role as 'admin')) {
    return next(); // Only apply logic to high-privilege roles (Admins)
  }

  // 2. Check if the user has 2FA enabled in the database
  const user = await UserModel.findById(new Types.ObjectId(req.user.sub)).select('twoFA role').lean();

  if (!user) {
    res.status(401).json({
      error: {
        code: 'user_not_found',
        message: 'Authenticated user account not found.',
      },
    });
    return;
  }

  // 3. CRITICAL: Enforce MFA for Admin users
  // If twoFA doesn't exist or is not enabled, block access
  if (!user.twoFA || !user.twoFA.enabled) {
    res.status(403).json({
      error: {
        code: 'mfa_required',
        message: 'Two-Factor Authentication setup is required to access this resource.',
      },
    });
    return;
  }

  // 4. Proceed if MFA is enabled or user is not in MFA-required role
  next();
};

