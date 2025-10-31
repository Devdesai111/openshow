// src/services/payment.service.ts
import { PaymentTransactionModel } from '../models/paymentTransaction.model';
import { PaymentAdapterFactory } from '../paymentAdapters/adapter.factory';
import { IntentInputDTO } from '../paymentAdapters/payment.interface';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

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
}

