// src/paymentAdapters/payment.interface.ts

// --- DTOs for Intent/Checkout ---
export interface IntentInputDTO {
  amount: number; // Cents/Paise
  currency: string;
  description: string;
  metadata: Record<string, string>;
  captureMethod: 'automatic' | 'manual';
  returnUrl?: string;
}

export interface IntentOutputDTO {
  provider: string;
  providerPaymentIntentId: string;
  clientSecret?: string; // For Stripe/Client-side confirmation
  checkoutUrl?: string; // For Razorpay/Hosted checkout
  status: 'created' | 'requires_action';
}

// --- DTOs for Escrow Release/Hold ---
export interface ReleaseInputDTO {
  providerPaymentId: string; // Original charge/intent ID to reference for release
  amount: number;
  currency: string;
  recipientId: string; // Target recipient for fund transfer
}

export interface ReleaseOutputDTO {
  providerTransferId: string; // Transfer/Payout ID for the release
  status: 'pending' | 'succeeded' | 'failed';
}

export interface RefundInputDTO {
  providerPaymentId: string; // Original charge/payment ID
  amount: number;
  reason: string;
}

export interface RefundOutputDTO {
  providerRefundId: string;
  status: 'pending' | 'succeeded' | 'failed';
}

/**
 * The Standard Interface for all Payment Service Provider (PSP) Adapters.
 * All adapter implementations MUST adhere to this contract.
 */
export interface IPaymentAdapter {
  providerName: string;

  /** Step 1: Initiates a payment flow (e.g., Stripe PaymentIntent, Razorpay Order). */
  createIntent(data: IntentInputDTO): Promise<IntentOutputDTO>;

  /** Step 2: Releases a held payment (escrow). E.g., Stripe Capture + Transfer. */
  releaseEscrow(data: ReleaseInputDTO): Promise<ReleaseOutputDTO>;

  /** Initiates a refund against an original payment. */
  refundPayment(data: RefundInputDTO): Promise<RefundOutputDTO>;

  // Future: handleWebhookSignature, createPayoutMethod
}

