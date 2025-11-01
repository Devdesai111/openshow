// src/routes/job.routes.ts
import { Router } from 'express';
import { enqueueController, leaseController, enqueueValidation, leaseValidation } from '../controllers/job.controller';
import { authenticate } from '../middleware/auth.middleware'; 
import { authorize } from '../middleware/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// --- Job Enqueue Endpoints (Task 52) ---

// POST /jobs - Enqueue a job (System/Admin access)
router.post(
    '/',
    authenticate,
    authorize(adminAccess),
    enqueueValidation,
    enqueueController
);

// GET /jobs/lease - Atomically lease a job (Worker/System access)
router.get(
    '/lease',
    authenticate,
    authorize(adminAccess), // Worker access is modeled as Admin/System
    leaseValidation,
    leaseController
);

// NOTE: Future endpoints (succeed, fail, status, requeue) will be added here.

export default router;

