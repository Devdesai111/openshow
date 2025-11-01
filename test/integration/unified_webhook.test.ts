import request from 'supertest';
import app from '../../src/server';
import { AuditLogModel } from '../../src/models/auditLog.model';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import mongoose from 'mongoose';

describe('Unified Webhook Receiver API Integration Tests (Task 69)', () => {
  let adminToken: string;

  beforeAll(async () => {
    const testDbUri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/openshow-test';
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    await mongoose.connect(testDbUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await AuditLogModel.deleteMany({});
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});

    // Create admin user (signup as creator, then update role)
    await request(app).post('/auth/signup').send({
      email: 'admin@test.com',
      password: 'Admin123!',
      preferredName: 'Admin User',
      fullName: 'Admin User',
      role: 'creator',
    });
    // Get admin user from database
    const adminUser = await UserModel.findOne({ email: 'admin@test.com' });
    expect(adminUser).toBeDefined();

    // Update to admin role
    await UserModel.updateOne({ email: 'admin@test.com' }, { $set: { role: 'admin' } });

    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@test.com',
      password: 'Admin123!',
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.data?.token || adminLogin.body.accessToken;
    expect(adminToken).toBeDefined();
  });

  describe('POST /payments/webhooks/provider/:providerName', () => {
    it('T69.1 - should return 401 for invalid signature', async () => {
      // Arrange: Invalid Stripe signature header
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_12345',
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/payments/webhooks/provider/stripe')
        .set('stripe-signature', 'invalid_signature')
        .send(payload);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('unauthorized');

      // Verify audit log was created for the failed attempt
      const auditLog = await AuditLogModel.findOne({
        action: 'webhook.received.stripe',
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.actorRole).toBe('system');
    });

    it('T69.2 - should successfully process payment event with valid signature', async () => {
      // Arrange: Valid Stripe signature header
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_12345',
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/payments/webhooks/provider/stripe')
        .set('stripe-signature', 'wh_stripe_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('Event processed.');

      // Verify audit log was created
      const auditLog = await AuditLogModel.findOne({
        action: 'webhook.received.stripe',
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.details).toHaveProperty('eventType', 'payment_intent.succeeded');
    });

    it('T69.3 - should successfully process e-sign event with valid signature', async () => {
      // Arrange: Valid DocuSign signature header
      const payload = {
        type: 'envelope.signed',
        data: {
          object: {
            envelopeId: 'envelope_test_12345',
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/payments/webhooks/provider/docusign')
        .set('x-signature', 'wh_docusign_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('Event processed.');

      // Verify audit log was created
      const auditLog = await AuditLogModel.findOne({
        action: 'webhook.received.docusign',
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.details).toHaveProperty('eventType', 'envelope.signed');
    });

    it('T69.4 - should return 200 for unhandled provider with valid signature', async () => {
      // Arrange: Valid signature but unhandled provider
      const payload = {
        type: 'unknown.event',
        data: {
          object: {
            id: 'test_12345',
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/payments/webhooks/provider/unhandled')
        .set('x-signature', 'unknown_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('Provider not handled.');

      // Verify audit log was created
      const auditLog = await AuditLogModel.findOne({
        action: 'webhook.received.unhandled',
      });
      expect(auditLog).toBeDefined();
    });

    it('should successfully process refund event with valid Razorpay signature', async () => {
      // Arrange: Valid Razorpay signature header
      const payload = {
        type: 'charge.refunded',
        data: {
          object: {
            id: 'txn_rzp_test_12345',
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/payments/webhooks/provider/razorpay')
        .set('x-razorpay-signature', 'wh_razorpay_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('Event processed.');

      // Verify audit log was created
      const auditLog = await AuditLogModel.findOne({
        action: 'webhook.received.razorpay',
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.details).toHaveProperty('eventType', 'charge.refunded');
    });

    it('should successfully process SignWell event with valid signature', async () => {
      // Arrange: Valid SignWell signature header
      const payload = {
        type: 'recipient.signed',
        data: {
          object: {
            envelopeId: 'envelope_signwell_test_12345',
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/payments/webhooks/provider/signwell')
        .set('x-signature', 'wh_signwell_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('Event processed.');

      // Verify audit log was created
      const auditLog = await AuditLogModel.findOne({
        action: 'webhook.received.signwell',
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.details).toHaveProperty('eventType', 'recipient.signed');
    });

    it('should handle multiple webhook events sequentially', async () => {
      // Arrange: Multiple payment events
      const payload1 = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_001',
          },
        },
      };
      const payload2 = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_002',
          },
        },
      };

      // Act
      const response1 = await request(app)
        .post('/payments/webhooks/provider/stripe')
        .set('stripe-signature', 'wh_stripe_secret')
        .send(payload1);

      const response2 = await request(app)
        .post('/payments/webhooks/provider/stripe')
        .set('stripe-signature', 'wh_stripe_secret')
        .send(payload2);

      // Assert
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);

      // Verify multiple audit logs were created
      const auditLogs = await AuditLogModel.find({
        action: 'webhook.received.stripe',
      });
      expect(auditLogs.length).toBe(2);
    });

    it('should return 401 for missing signature header', async () => {
      // Arrange: No signature header
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_12345',
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/payments/webhooks/provider/stripe')
        .send(payload);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('unauthorized');
    });

    it('should handle case-insensitive provider names', async () => {
      // Arrange: Uppercase provider name
      const payload = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_12345',
          },
        },
      };

      // Act
      const response = await request(app)
        .post('/payments/webhooks/provider/STRIPE')
        .set('stripe-signature', 'wh_stripe_secret')
        .send(payload);

      // Assert
      expect(response.status).toBe(200);
      expect(response.text).toBe('Event processed.');

      // Verify audit log uses lowercase provider name
      const auditLog = await AuditLogModel.findOne({
        action: 'webhook.received.stripe',
      });
      expect(auditLog).toBeDefined();
    });
  });
});

