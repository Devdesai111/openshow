// src/paymentAdapters/stripe.adapter.ts
import {
  IPaymentAdapter,
  IntentInputDTO,
  IntentOutputDTO,
  ReleaseInputDTO,
  ReleaseOutputDTO,
  RefundInputDTO,
  RefundOutputDTO,
} from './payment.interface';
import * as crypto from 'crypto';

/**
 * Mock implementation of the Stripe Payment Adapter.
 * Assumes a flow of: PaymentIntent (Intent) -> Capture + Transfer (Release).
 */
export class StripeAdapter implements IPaymentAdapter {
  public providerName = 'stripe';

  public async createIntent(_data: IntentInputDTO): Promise<IntentOutputDTO> {
    // PRODUCTION: Stripe.paymentIntents.create({...})
    const intentId = `pi_${crypto.randomBytes(12).toString('hex')}`;
    const clientSecret = `${intentId}_secret_${crypto.randomBytes(6).toString('hex')}`;

    return {
      provider: this.providerName,
      providerPaymentIntentId: intentId,
      clientSecret,
      status: 'requires_action',
    };
  }

  public async releaseEscrow(_data: ReleaseInputDTO): Promise<ReleaseOutputDTO> {
    // PRODUCTION: Stripe.charges.capture() + Stripe.transfers.create()
    const transferId = `tr_${crypto.randomBytes(12).toString('hex')}`;

    // Simulates an async PSP action
    return {
      providerTransferId: transferId,
      status: 'pending', // Will be confirmed via webhook later
    };
  }

  public async refundPayment(_data: RefundInputDTO): Promise<RefundOutputDTO> {
    // PRODUCTION: Stripe.refunds.create()
    const refundId = `re_${crypto.randomBytes(12).toString('hex')}`;

    return {
      providerRefundId: refundId,
      status: 'pending',
    };
  }
}

