// src/paymentAdapters/adapter.factory.ts
import { IPaymentAdapter } from './payment.interface';
import { StripeAdapter } from './stripe.adapter';
import { RazorpayAdapter } from './razorpay.adapter';

// Enum for configuration safety
export enum PSPProvider {
  STRIPE = 'stripe',
  RAZORPAY = 'razorpay',
  MOCK = 'mock', // Useful for testing
}

/**
 * Gets the default PSP provider from environment variable.
 * Reads dynamically to support testing.
 */
function getDefaultPSP(): PSPProvider {
  const envProvider = process.env.DEFAULT_PSP as PSPProvider;
  return envProvider || PSPProvider.STRIPE;
}

/**
 * Factory to retrieve the correct PSP Adapter instance.
 */
export class PaymentAdapterFactory {
  /**
   * Gets a payment adapter instance based on the configured provider.
   * @param providerName - Optional override for provider selection. If not provided, reads from DEFAULT_PSP env var.
   * @returns An instance of a class implementing IPaymentAdapter.
   * @throws {Error} - If the configured provider is not supported.
   */
  public static getAdapter(providerName?: PSPProvider): IPaymentAdapter {
    const selectedProvider = providerName ?? getDefaultPSP();
    switch (selectedProvider) {
      case PSPProvider.STRIPE:
        return new StripeAdapter();
      case PSPProvider.RAZORPAY:
        return new RazorpayAdapter();
      default:
        throw new Error(`Unsupported PSP configuration: ${selectedProvider}`);
    }
  }
}

