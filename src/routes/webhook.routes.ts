// src/routes/webhook.routes.ts
import { Router } from 'express';
import { webhookController } from '../controllers/payment.controller';

const router = Router();

// --- Webhooks (Public) ---

// POST /webhooks/payments - PSP webhook receiver (Task 35)
router.post('/payments', webhookController); // NOTE: No 'authenticate' middleware!

export default router;

