// src/routes/payment.routes.ts
import { Router } from 'express';
import { createPaymentIntentController, createPaymentIntentValidation } from '../controllers/payment.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// --- Payments Endpoints ---

// POST /payments/intents - Create payment intent / checkout session (Task 34)
router.post('/intents', authenticate, createPaymentIntentValidation, createPaymentIntentController);

// NOTE: Future endpoints (webhooks, escrow, refunds, etc.) will be added here.

export default router;

