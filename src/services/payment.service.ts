// src/services/payment.service.ts
import { PaymentTransactionModel } from '../models/paymentTransaction.model';
import { EscrowModel, IEscrow } from '../models/escrow.model';
import { ProjectModel } from '../models/project.model';
import { PaymentAdapterFactory } from '../paymentAdapters/adapter.factory';
import { IntentInputDTO } from '../paymentAdapters/payment.interface';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

// Mock Webhook Signature Utility
class WebhookSecurity {
  public verifySignature(_payload: string, signature: string, _secret: string): boolean {
    // PRODUCTION: Implement HMAC SHA256 verification (e.g., Stripe.webhooks.verifyHeader)
    const expectedSecret = process.env.STRIPE_WEBHOOK_SECRET || 'wh_secret';
    return signature === expectedSecret; // Mock check
  }
}
const webhookSecurity = new WebhookSecurity();

// Mock Event Emitter
class MockEventEmitter {
  public emit(event: string, payload: any): void {
    console.warn(`[EVENT EMITTED] ${event}:`, JSON.stringify(payload));
  }
}
const eventEmitter = new MockEventEmitter();

interface ICreateIntentRequest {
  projectId: string;
  milestoneId: string;
  amount: number;
  currency: string;
  returnUrl?: string;
  // NOTE: PayerId comes from Auth
}

interface ICreateIntentResponse {
  intentId: string;
  provider: string;
  providerPaymentIntentId: string;
  clientSecret?: string;
  checkoutUrl?: string;
  status: string;
}

export class PaymentService {
  /**
   * Creates a payment intent via the selected PSP adapter.
   * @param payerId - User ID of the payer (from authentication)
   * @param data - Payment intent creation data
   * @returns Payment intent response with PSP-specific data
   */
  public async createPaymentIntent(
    payerId: string,
    data: ICreateIntentRequest
  ): Promise<ICreateIntentResponse> {
    const { projectId, milestoneId, amount, currency, returnUrl } = data;

    // 1. Select Adapter
    const adapter = PaymentAdapterFactory.getAdapter(); // Uses DEFAULT_PSP env
    const internalIntentId = `payint_${crypto.randomBytes(8).toString('hex')}`;

    // 2. Prepare PSP Input DTO
    const pspInput: IntentInputDTO = {
      amount,
      currency,
      description: `Escrow for Project ${projectId} Milestone ${milestoneId}`,
      metadata: {
        projectId,
        milestoneId,
        payerId,
        internalIntentId, // Internal ID passed to PSP for webhook correlation
      },
      captureMethod: 'manual', // Hold funds in escrow
      returnUrl,
    };

    // 3. Call PSP Adapter (Decoupled)
    const pspOutput = await adapter.createIntent(pspInput);

    // 4. Create Transaction Record (Status: 'created')
    // Map PSP status to transaction status: both 'created' and 'requires_action' map to 'created' for new intents
    const transactionStatus = pspOutput.status === 'created' || pspOutput.status === 'requires_action' ? 'created' : 'pending';
    const newTransaction = new PaymentTransactionModel({
      intentId: internalIntentId,
      projectId: new Types.ObjectId(projectId),
      milestoneId: new Types.ObjectId(milestoneId),
      payerId: new Types.ObjectId(payerId),
      provider: adapter.providerName as 'stripe' | 'razorpay' | 'other',
      providerPaymentIntentId: pspOutput.providerPaymentIntentId,
      type: 'escrow_lock', // Type is for eventual escrow/hold
      amount,
      currency,
      status: transactionStatus,
      metadata: pspInput.metadata,
    });
    await newTransaction.save();

    // PRODUCTION: Emit 'payment.intent.created' event (Task 35 subscribes)
    console.warn(`[Event] Payment intent ${internalIntentId} created via ${adapter.providerName}.`);

    // 5. Return Client-facing DTO
    return {
      intentId: internalIntentId,
      provider: adapter.providerName,
      providerPaymentIntentId: pspOutput.providerPaymentIntentId,
      clientSecret: pspOutput.clientSecret,
      checkoutUrl: pspOutput.checkoutUrl,
      status: newTransaction.status,
    };
  }

  /**
   * Locks funds into a new Escrow record after payment confirmation.
   * @param data - Escrow lock data including intentId, projectId, milestoneId, etc.
   * @returns Created escrow record
   * @throws {Error} - 'TransactionNotSucceeded', 'EscrowAlreadyLocked'
   */
  public async lockEscrow(data: {
    intentId: string;
    projectId: string;
    milestoneId: string;
    amount: number;
    currency: string;
    provider: string;
    providerPaymentIntentId: string;
  }): Promise<IEscrow> {
    const { intentId, projectId, milestoneId, amount, currency, provider, providerPaymentIntentId } = data;

    const intentTransaction = await PaymentTransactionModel.findOne({ intentId, status: 'succeeded' });
    if (!intentTransaction) {
      throw new Error('TransactionNotSucceeded');
    }

    // 1. IDEMPOTENCY CHECK (CRITICAL: Check against intentId/milestoneId)
    const existingEscrow = await EscrowModel.findOne({ milestoneId: new Types.ObjectId(milestoneId) });
    if (existingEscrow) {
      throw new Error('EscrowAlreadyLocked');
    }

    // 2. Create Escrow Record
    const newEscrow = new EscrowModel({
      projectId: new Types.ObjectId(projectId),
      milestoneId: new Types.ObjectId(milestoneId),
      payerId: intentTransaction.payerId,
      amount,
      currency,
      provider: provider as 'stripe' | 'razorpay' | 'other',
      providerEscrowId: providerPaymentIntentId,
      transactions: [intentTransaction._id!],
      status: 'locked',
    });
    const savedEscrow = await newEscrow.save();

    // 3. Update Project Milestone (Update milestone escrowId field)
    await ProjectModel.updateOne(
      { _id: new Types.ObjectId(projectId), 'milestones._id': new Types.ObjectId(milestoneId) },
      {
        $set: {
          'milestones.$.escrowId': new Types.ObjectId(savedEscrow._id!.toString()),
          'milestones.$.status': 'funded',
        },
      }
    );

    // PRODUCTION: Emit 'escrow.locked' event (Task 32 subscribes)
    eventEmitter.emit('escrow.locked', {
      escrowId: savedEscrow.escrowId,
      projectId,
      milestoneId,
      amount,
      currency,
    });

    return savedEscrow.toObject() as IEscrow;
  }

  /**
   * Handles incoming PSP webhooks (e.g., payment_intent.succeeded).
   * @param provider - PSP provider name
   * @param payload - Webhook payload from PSP
   * @param signature - Webhook signature for verification
   * @throws {Error} - 'InvalidWebhookSignature', 'MissingCorrelationID', 'TransactionNotFound'
   */
  public async handleWebhook(_provider: string, payload: any, signature: string): Promise<void> {
    // 1. SECURITY: Signature Verification
    if (!webhookSecurity.verifySignature(JSON.stringify(payload), signature, process.env.STRIPE_WEBHOOK_SECRET || 'wh_secret')) {
      throw new Error('InvalidWebhookSignature');
    }

    // 2. Extract Event and Correlation ID
    const eventType = payload.type; // e.g., 'payment_intent.succeeded'
    // Retrieve internal correlation ID from metadata
    const correlationId = payload.data?.object?.metadata?.internalIntentId;
    const providerPaymentIntentId = payload.data?.object?.id;

    if (!correlationId) {
      throw new Error('MissingCorrelationID');
    }

    // 3. Find Transaction Record
    const transaction = await PaymentTransactionModel.findOne({ intentId: correlationId });
    if (!transaction) {
      throw new Error('TransactionNotFound');
    }

    // 4. Update Transaction Status based on Event Type
    if (eventType === 'payment_intent.succeeded' || eventType === 'order.paid') {
      const wasAlreadySucceeded = transaction.status === 'succeeded';
      const needsUpdate = !wasAlreadySucceeded || !transaction.providerPaymentId;

      if (needsUpdate) {
        transaction.status = 'succeeded';
        // NOTE: Final Payment ID (charge ID) should be stored here
        transaction.providerPaymentId = providerPaymentIntentId;
        await transaction.save();
      }

      // 5. TRIGGER ESCROW LOCK (Internal call based on success event)
      // Check if escrow already exists to prevent duplicate creation (idempotency)
      if (transaction.projectId && transaction.milestoneId) {
        const existingEscrow = await EscrowModel.findOne({
          milestoneId: transaction.milestoneId,
        });
        if (!existingEscrow) {
          await this.lockEscrow({
            intentId: transaction.intentId,
            projectId: transaction.projectId.toString(),
            milestoneId: transaction.milestoneId.toString(),
            amount: transaction.amount,
            currency: transaction.currency,
            provider: transaction.provider,
            providerPaymentIntentId: providerPaymentIntentId,
          });
        }
      }

      // If transaction was already succeeded and escrow already exists, return early (idempotency)
      if (wasAlreadySucceeded) {
        const existingEscrow = await EscrowModel.findOne({
          milestoneId: transaction.milestoneId,
        });
        if (existingEscrow) {
          return;
        }
      }
    } else if (eventType.includes('failed')) {
      transaction.status = 'failed';
      await transaction.save();
    }

    // PRODUCTION: Emit 'payment.updated' event
    eventEmitter.emit('payment.updated', {
      intentId: transaction.intentId,
      status: transaction.status,
      providerPaymentIntentId,
    });
  }
}

