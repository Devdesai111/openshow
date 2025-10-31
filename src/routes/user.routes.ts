import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Example Controller Logic (Placeholder for Task 13.1) ---
const listAllUsersController = (req: Request, res: Response): void => {
  // This endpoint should eventually call the Admin & Audit Service to fetch user data
  res.status(200).json({
    message: 'ADMIN ACCESS GRANTED: Successfully retrieved mock list of all users.',
    userId: req.user?.sub,
    role: req.user?.role,
  });
};

// --- Protected Endpoint Definition ---

// GET /users/admin/all
// Access: Only users with the 'admin:dashboard_access' permission.
router.get(
  '/admin/all',
  authenticate, // Step 1: Ensure JWT is valid
  authorize([PERMISSIONS.ADMIN_DASHBOARD]), // Step 2: Check status and permissions
  listAllUsersController // Step 3: Execute controller if authorized
);

export default router;
