import { Router, Request, Response } from 'express';
import {
  getUserController,
  updateUserController,
  userIdParamValidation,
  profileUpdateValidation,
  addPortfolioItemController,
  updatePortfolioItemController,
  deletePortfolioItemController,
  portfolioItemValidation,
  portfolioItemIdParamValidation,
} from '../controllers/userProfile.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Admin Endpoint (from Task 2) ---

// GET /users/admin/all - List all users (admin only)
const listAllUsersController = (req: Request, res: Response): void => {
  res.status(200).json({
    message: 'ADMIN ACCESS GRANTED: Successfully retrieved mock list of all users.',
    userId: req.user?.sub,
    role: req.user?.role,
  });
};

router.get('/admin/all', authenticate, authorize([PERMISSIONS.ADMIN_DASHBOARD]), listAllUsersController);

// --- User Profile Endpoints ---

// GET /users/:userId - Fetch user profile (public partial / full if owner/admin) (Task 8)
// Note: authenticate middleware is optional - if present, user gets more data
router.get('/:userId', userIdParamValidation, authenticate, getUserController);

// PUT /users/:userId - Update user profile (self or admin) (Task 8)
router.put('/:userId', authenticate, profileUpdateValidation, updateUserController);

// --- Portfolio Endpoints (Task 9) ---

// POST /users/:creatorId/portfolio - Add portfolio item (owner only)
router.post('/:creatorId/portfolio', authenticate, portfolioItemValidation, addPortfolioItemController);

// PUT /users/:creatorId/portfolio/:itemId - Update portfolio item (owner only)
// Note: No portfolioItemValidation here - partial updates allowed
router.put('/:creatorId/portfolio/:itemId', authenticate, portfolioItemIdParamValidation, updatePortfolioItemController);

// DELETE /users/:creatorId/portfolio/:itemId - Delete portfolio item (owner only)
router.delete('/:creatorId/portfolio/:itemId', authenticate, portfolioItemIdParamValidation, deletePortfolioItemController);

// --- NOTE: Creator directory endpoints (Task 10) will be added here ---

export default router;


