import { StripeAdapter } from '../../src/paymentAdapters/stripe.adapter';
import { RazorpayAdapter } from '../../src/paymentAdapters/razorpay.adapter';
import { PaymentAdapterFactory, PSPProvider } from '../../src/paymentAdapters/adapter.factory';
import { IPaymentAdapter } from '../../src/paymentAdapters/payment.interface';

describe('Payment Adapter Abstraction Tests', () => {
  describe('StripeAdapter', () => {
    let adapter: StripeAdapter;

    beforeEach(() => {
      adapter = new StripeAdapter();
    });

    it('T33.1 - should implement IPaymentAdapter interface', () => {
      expect(adapter).toHaveProperty('providerName', 'stripe');
      expect(adapter).toHaveProperty('createIntent');
      expect(adapter).toHaveProperty('releaseEscrow');
      expect(adapter).toHaveProperty('refundPayment');
      expect(typeof adapter.createIntent).toBe('function');
      expect(typeof adapter.releaseEscrow).toBe('function');
      expect(typeof adapter.refundPayment).toBe('function');
    });

    it('T33.3 - should create intent and return IntentOutputDTO with clientSecret', async () => {
      // Arrange
      const input = {
        amount: 10000,
        currency: 'USD',
        description: 'Test payment',
        metadata: { projectId: 'proj_123' },
        captureMethod: 'manual' as const,
      };

      // Act
      const result = await adapter.createIntent(input);

      // Assert
      expect(result).toHaveProperty('provider', 'stripe');
      expect(result).toHaveProperty('providerPaymentIntentId');
      expect(result.providerPaymentIntentId).toMatch(/^pi_/);
      expect(result).toHaveProperty('clientSecret');
      expect(result.clientSecret).toBeDefined();
      expect(result).toHaveProperty('status', 'requires_action');
      expect(result.checkoutUrl).toBeUndefined(); // Stripe uses clientSecret, not checkoutUrl
    });

    it('should release escrow and return ReleaseOutputDTO', async () => {
      // Arrange
      const input = {
        providerPaymentId: 'pi_test123',
        amount: 10000,
        currency: 'USD',
        recipientId: 'user_123',
      };

      // Act
      const result = await adapter.releaseEscrow(input);

      // Assert
      expect(result).toHaveProperty('providerTransferId');
      expect(result.providerTransferId).toMatch(/^tr_/);
      expect(result).toHaveProperty('status');
      expect(['pending', 'succeeded', 'failed']).toContain(result.status);
    });

    it('should refund payment and return RefundOutputDTO', async () => {
      // Arrange
      const input = {
        providerPaymentId: 'pi_test123',
        amount: 5000,
        reason: 'Customer request',
      };

      // Act
      const result = await adapter.refundPayment(input);

      // Assert
      expect(result).toHaveProperty('providerRefundId');
      expect(result.providerRefundId).toMatch(/^re_/);
      expect(result).toHaveProperty('status');
      expect(['pending', 'succeeded', 'failed']).toContain(result.status);
    });
  });

  describe('RazorpayAdapter', () => {
    let adapter: RazorpayAdapter;

    beforeEach(() => {
      adapter = new RazorpayAdapter();
    });

    it('should implement IPaymentAdapter interface', () => {
      expect(adapter).toHaveProperty('providerName', 'razorpay');
      expect(adapter).toHaveProperty('createIntent');
      expect(adapter).toHaveProperty('releaseEscrow');
      expect(adapter).toHaveProperty('refundPayment');
      expect(typeof adapter.createIntent).toBe('function');
      expect(typeof adapter.releaseEscrow).toBe('function');
      expect(typeof adapter.refundPayment).toBe('function');
    });

    it('should create intent and return IntentOutputDTO with checkoutUrl', async () => {
      // Arrange
      const input = {
        amount: 10000,
        currency: 'INR',
        description: 'Test payment',
        metadata: { projectId: 'proj_123' },
        captureMethod: 'automatic' as const,
      };

      // Act
      const result = await adapter.createIntent(input);

      // Assert
      expect(result).toHaveProperty('provider', 'razorpay');
      expect(result).toHaveProperty('providerPaymentIntentId');
      expect(result.providerPaymentIntentId).toMatch(/^order_/);
      expect(result).toHaveProperty('checkoutUrl');
      expect(result.checkoutUrl).toContain('checkout.razorpay.com');
      expect(result).toHaveProperty('status', 'created');
      expect(result.clientSecret).toBeUndefined(); // Razorpay uses checkoutUrl, not clientSecret
    });

    it('T33.4 - should release escrow and return ReleaseOutputDTO with providerTransferId', async () => {
      // Arrange
      const input = {
        providerPaymentId: 'order_test123',
        amount: 10000,
        currency: 'INR',
        recipientId: 'user_123',
      };

      // Act
      const result = await adapter.releaseEscrow(input);

      // Assert
      expect(result).toHaveProperty('providerTransferId');
      expect(result.providerTransferId).toMatch(/^pout_/);
      expect(result).toHaveProperty('status');
      expect(['pending', 'succeeded', 'failed']).toContain(result.status);
    });

    it('should refund payment and return RefundOutputDTO', async () => {
      // Arrange
      const input = {
        providerPaymentId: 'order_test123',
        amount: 5000,
        reason: 'Customer request',
      };

      // Act
      const result = await adapter.refundPayment(input);

      // Assert
      expect(result).toHaveProperty('providerRefundId');
      expect(result.providerRefundId).toMatch(/^refr_/);
      expect(result).toHaveProperty('status');
      expect(['pending', 'succeeded', 'failed']).toContain(result.status);
    });
  });

  describe('PaymentAdapterFactory', () => {
    const originalEnv = process.env.DEFAULT_PSP;

    afterEach(() => {
      // Restore original environment variable
      if (originalEnv !== undefined) {
        process.env.DEFAULT_PSP = originalEnv;
      } else {
        delete process.env.DEFAULT_PSP;
      }
    });

    it('T33.2 - should instantiate StripeAdapter when DEFAULT_PSP is stripe', () => {
      // Arrange
      process.env.DEFAULT_PSP = 'stripe';

      // Act
      const adapter = PaymentAdapterFactory.getAdapter();

      // Assert
      expect(adapter).toBeInstanceOf(StripeAdapter);
      expect(adapter.providerName).toBe('stripe');
    });

    it('T33.2 - should instantiate RazorpayAdapter when DEFAULT_PSP is razorpay', () => {
      // Arrange
      process.env.DEFAULT_PSP = 'razorpay';

      // Act
      const adapter = PaymentAdapterFactory.getAdapter();

      // Assert
      expect(adapter).toBeInstanceOf(RazorpayAdapter);
      expect(adapter.providerName).toBe('razorpay');
    });

    it('should default to StripeAdapter when DEFAULT_PSP is not set', () => {
      // Arrange
      delete process.env.DEFAULT_PSP;

      // Act
      const adapter = PaymentAdapterFactory.getAdapter();

      // Assert
      expect(adapter).toBeInstanceOf(StripeAdapter);
      expect(adapter.providerName).toBe('stripe');
    });

    it('should allow explicit provider override', () => {
      // Arrange
      process.env.DEFAULT_PSP = 'stripe';

      // Act - Override with Razorpay
      const adapter = PaymentAdapterFactory.getAdapter(PSPProvider.RAZORPAY);

      // Assert
      expect(adapter).toBeInstanceOf(RazorpayAdapter);
      expect(adapter.providerName).toBe('razorpay');
    });

    it('should throw error for unsupported provider', () => {
      // Arrange & Act & Assert
      expect(() => {
        PaymentAdapterFactory.getAdapter('unsupported' as PSPProvider);
      }).toThrow('Unsupported PSP configuration: unsupported');
    });

    it('should support explicit PSPProvider enum values', () => {
      // Act
      const stripeAdapter = PaymentAdapterFactory.getAdapter(PSPProvider.STRIPE);
      const razorpayAdapter = PaymentAdapterFactory.getAdapter(PSPProvider.RAZORPAY);

      // Assert
      expect(stripeAdapter).toBeInstanceOf(StripeAdapter);
      expect(razorpayAdapter).toBeInstanceOf(RazorpayAdapter);
    });
  });

  describe('Adapter Interface Compliance', () => {
    it('should ensure all adapters implement IPaymentAdapter', () => {
      const stripeAdapter: IPaymentAdapter = new StripeAdapter();
      const razorpayAdapter: IPaymentAdapter = new RazorpayAdapter();

      expect(stripeAdapter.providerName).toBe('stripe');
      expect(razorpayAdapter.providerName).toBe('razorpay');

      // TypeScript compile-time check: Both should implement IPaymentAdapter
      expect(stripeAdapter.createIntent).toBeDefined();
      expect(stripeAdapter.releaseEscrow).toBeDefined();
      expect(stripeAdapter.refundPayment).toBeDefined();

      expect(razorpayAdapter.createIntent).toBeDefined();
      expect(razorpayAdapter.releaseEscrow).toBeDefined();
      expect(razorpayAdapter.refundPayment).toBeDefined();
    });

    it('should ensure adapters return correct DTO types', async () => {
      const stripeAdapter = new StripeAdapter();
      const razorpayAdapter = new RazorpayAdapter();

      // Test createIntent return types
      const stripeIntent = await stripeAdapter.createIntent({
        amount: 1000,
        currency: 'USD',
        description: 'Test',
        metadata: {},
        captureMethod: 'automatic',
      });
      expect(stripeIntent).toHaveProperty('provider');
      expect(stripeIntent).toHaveProperty('providerPaymentIntentId');
      expect(stripeIntent).toHaveProperty('status');

      const razorpayIntent = await razorpayAdapter.createIntent({
        amount: 1000,
        currency: 'INR',
        description: 'Test',
        metadata: {},
        captureMethod: 'automatic',
      });
      expect(razorpayIntent).toHaveProperty('provider');
      expect(razorpayIntent).toHaveProperty('providerPaymentIntentId');
      expect(razorpayIntent).toHaveProperty('status');
    });
  });
});

