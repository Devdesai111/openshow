import { Router } from 'express';
import { healthController, metricsController } from '../controllers/utility.controller';
import { authenticate } from '../middleware/auth.middleware';
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// GET /health - Service health check (Public access)
router.get('/health', healthController);

// GET /metrics - Prometheus metrics (Admin-only for security)
router.get('/metrics', authenticate, authorize([PERMISSIONS.ADMIN_DASHBOARD]), metricsController);

export default router;

