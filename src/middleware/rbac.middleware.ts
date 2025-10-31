import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { checkPermissions, checkStatus } from '../config/permissions';
import { UserModel, IUser } from '../models/user.model';

/**
 * Middleware function generator for Role-Based Access Control (RBAC).
 * Checks user's status and ensures they possess all required permissions.
 * @param requiredPermissions An array of permission constants (from src/config/permissions.ts).
 * @returns An Express middleware function.
 */
export const authorize = (requiredPermissions: string[]) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Assumes authenticate middleware has run and req.user is present
    if (!req.user) {
      // Failsafe: Should be caught by the authenticate middleware (401)
      res.status(500).json({
        error: {
          code: 'server_error',
          message: 'Authorization error: missing authenticated user data.',
        },
      });
      return;
    }

    const { sub: userId } = req.user;

    try {
      // 1. Fetch User Status from DB (Security: Do not rely on potentially stale JWT claims for status/suspension)
      // Explicitly include status and role fields
      const user = (await UserModel.findById(new Types.ObjectId(userId))
        .select('status role')
        .lean()) as IUser | null;

      if (!user) {
        // User may have been deleted (401 Unauthorized)
        res.status(401).json({
          error: { code: 'user_not_found', message: 'Authenticated user account not found.' },
        });
        return;
      }

      // 2. Status Check (e.g., 'active' status required)
      if (!checkStatus(user.status)) {
        // 403 Forbidden: Account is suspended/inactive
        res.status(403).json({
          error: {
            code: 'account_inactive',
            message: `Account is ${user.status}. Access denied.`,
          },
        });
        return;
      }

      // 3. Permission Check (Role-based)
      if (!checkPermissions(user.role, requiredPermissions)) {
        // 403 Forbidden: User role lacks the necessary permissions
        res.status(403).json({
          error: {
            code: 'permission_denied',
            message: 'You do not have the required role or permissions.',
          },
        });
        return;
      }

      // 4. Update req.user with fresh data from DB (role might have changed)
      if (req.user) {
        req.user.role = user.role;
      }

      // 5. Success: Proceed to the controller
      next();
    } catch (error) {
      console.error(`RBAC Error for User ${userId}:`, error);
      // General 500 server error for DB/unforeseen failures
      res.status(500).json({
        error: { code: 'server_error', message: 'An error occurred during permission check.' },
      });
    }
  };
};
