// src/paymentAdapters/razorpay.adapter.ts
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
 * Mock implementation of the Razorpay Payment Adapter.
 * Assumes a flow of: Order (Intent) -> Payment Capture + Payouts (Release).
 */
export class RazorpayAdapter implements IPaymentAdapter {
  public providerName = 'razorpay';

  public async createIntent(_data: IntentInputDTO): Promise<IntentOutputDTO> {
    // PRODUCTION: Razorpay.orders.create()
    const orderId = `order_${crypto.randomBytes(10).toString('hex')}`;
    const checkoutUrl = `https://checkout.razorpay.com/pay/${orderId}`;

    return {
      provider: this.providerName,
      providerPaymentIntentId: orderId,
      checkoutUrl,
      status: 'created',
    };
  }

  public async releaseEscrow(_data: ReleaseInputDTO): Promise<ReleaseOutputDTO> {
    // PRODUCTION: Razorpay.payouts.create() or direct transfer after capture
    const payoutId = `pout_${crypto.randomBytes(12).toString('hex')}`;

    // Simulates an async PSP action
    return {
      providerTransferId: payoutId,
      status: 'pending',
    };
  }

  public async refundPayment(_data: RefundInputDTO): Promise<RefundOutputDTO> {
    // PRODUCTION: Razorpay.payments.refund()
    const refundId = `refr_${crypto.randomBytes(12).toString('hex')}`;

    return {
      providerRefundId: refundId,
      status: 'pending',
    };
  }
}

