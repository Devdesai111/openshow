// src/utils/webhookSecurity.ts
// Mock Webhook Signature Utility (Centralized for all PSPs)
export const PSP_SECRETS: Record<string, string> = {
  stripe: process.env.STRIPE_WEBHOOK_SECRET || 'wh_stripe_secret',
  razorpay: process.env.RAZORPAY_WEBHOOK_SECRET || 'wh_razorpay_secret',
  docusign: process.env.DOCUSIGN_WEBHOOK_SECRET || 'wh_docusign_secret',
  signwell: process.env.SIGNWELL_WEBHOOK_SECRET || 'wh_signwell_secret',
  // ... add other provider secrets here
};

export class UnifiedWebhookSecurity {
  public verifySignature(provider: string, _rawBody: string, signature: string): boolean {
    const expectedSecret = PSP_SECRETS[provider.toLowerCase()] || 'unknown_secret';
    // PRODUCTION: This would call HMAC verification logic for the specific provider
    return signature === expectedSecret; // Mock check
  }
}

export const webhookSecurity = new UnifiedWebhookSecurity();

