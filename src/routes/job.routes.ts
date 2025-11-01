// src/routes/job.routes.ts
import { Router } from 'express';
import { 
    enqueueController, 
    leaseController, 
    reportSuccessController,
    reportFailureController,
    enqueueValidation, 
    leaseValidation,
    reportParamValidation
} from '../controllers/job.controller';
import { getJobStatusController, jobIdParamValidation } from '../controllers/admin.controller';
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

// --- Worker Report Endpoints (Task 54) ---

// POST /jobs/:jobId/succeed - Worker reports success
router.post(
    '/:jobId/succeed',
    authenticate,
    authorize(adminAccess),
    reportParamValidation,
    reportSuccessController
);

// POST /jobs/:jobId/fail - Worker reports failure
router.post(
    '/:jobId/fail',
    authenticate,
    authorize(adminAccess),
    reportParamValidation,
    reportFailureController
);

// --- Job Monitoring Endpoints (Task 59) ---

// GET /jobs/:jobId - Get job status and details
router.get(
    '/:jobId',
    authenticate,
    jobIdParamValidation,
    getJobStatusController
);

export default router;

