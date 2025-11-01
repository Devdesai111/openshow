Following the structured plan, we proceed with **Task 48: Email Provider Adapter & Webhook Handling**.

This task implements the first external delivery method for the `Notifications Service`, abstracting the email provider via an adapter and establishing the secure, public endpoint to handle asynchronous delivery confirmations (bounces, complaints) via webhooks.

***

## **Task 48: Email Provider Adapter & Webhook Handling**

**Goal:** Define and implement the `IEmailAdapter` (mocking SendGrid/SES) for notification delivery, and create the public webhook endpoint (`POST /webhooks/notifications/email`) to receive and process delivery status callbacks.

**Service:** `Notifications Service`
**Phase:** G - Notifications, Webhooks...
**Dependencies:** Task 47 (Notification Model/Service), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/notificationAdapters/email.interface.ts` (New file: Adapter Interface)
2.  `src/notificationAdapters/sendgrid.adapter.ts` (New file: Mock implementation)
3.  `src/services/notification.service.ts` (Updated: `sendEmailNotification`, `handleEmailWebhook`)
4.  `src/controllers/notification.controller.ts` (Updated: `emailWebhookController`)
5.  `src/routes/notification.routes.ts` (Updated: new public route)
6.  `test/unit/email_adapter.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Headers) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **Adapter.sendEmail** | `{ to, subject, html, refId }` | `{ providerMessageId: string }` | Service-to-Service |
| **POST /webhooks/notifications/email** | Raw PSP Payload, `X-Signature` | **200 OK** | Public (Signature Validation) |

**Webhook Event (Simulated Input):**
```json
// Example of a webhook body
[
  { "event": "bounce", "email": "test@bounce.com", "providerMessageId": "sg_xyz" }
]
```

**Runtime & Env Constraints:**
*   **Security:** The webhook endpoint is **Public** but requires HMAC signature validation using a shared secret (`process.env.EMAIL_WEBHOOK_SECRET`). We will mock this validation.
*   **Decoupling:** The `NotificationService` must call the adapter interface, not the provider implementation directly.
*   **Asynchronous State:** The webhook handler must update the delivery status (e.g., mark a corresponding `DispatchAttempt` as failed).

**Acceptance Criteria:**
*   The webhook endpoint returns **401 Unauthorized** if signature validation fails.
*   The webhook handler successfully parses the payload and logs the event (simulating state update/bounce suppression).
*   The `sendEmailNotification` method uses the adapter and returns a `providerMessageId`.

**Tests to Generate:**
*   **Unit Test (Adapter):** Verify the mock adapter's methods and DTO compliance.
*   **Integration Test (Webhook Security):** Test successful processing with a valid signature and failure with an invalid one (401).

***

### **Task 48 Code Implementation**

#### **48.1. `src/notificationAdapters/email.interface.ts` (New Interface File)**

```typescript
// src/notificationAdapters/email.interface.ts

// DTO for sending email from the Notification Service
export interface IEmailSendDTO {
    to: string;
    subject: string;
    html: string;
    text?: string;
    // Internal reference to correlate webhook events
    providerRefId: string; 
}

// DTO for the response after sending
export interface IEmailSendResponseDTO {
    providerMessageId: string; // ID used by provider to track delivery
    status: 'sent' | 'pending';
}

/**
 * The Standard Interface for all Email Service Provider (ESP) Adapters.
 */
export interface IEmailAdapter {
    providerName: string;

    /** Sends a templated or raw email. */
    sendEmail(data: IEmailSendDTO): Promise<IEmailSendResponseDTO>;

    /** Verifies the webhook signature. */
    verifyWebhookSignature(payload: string, signature: string): boolean;
}
```

#### **48.2. `src/notificationAdapters/sendgrid.adapter.ts` (Mock Implementation)**

```typescript
// src/notificationAdapters/sendgrid.adapter.ts
import { IEmailAdapter, IEmailSendDTO, IEmailSendResponseDTO } from './email.interface';

// Utility for webhook signature verification (mocked)
const EMAIL_WEBHOOK_SECRET = process.env.EMAIL_WEBHOOK_SECRET || 'dev_email_secret';

export class SendGridAdapter implements IEmailAdapter {
    public providerName = 'sendgrid';

    public async sendEmail(data: IEmailSendDTO): Promise<IEmailSendResponseDTO> {
        // PRODUCTION: Call SendGrid API Client
        const messageId = `sg_${crypto.randomBytes(12).toString('hex')}`;

        return {
            providerMessageId: messageId,
            status: 'pending', // Delivery is async
        };
    }

    public verifyWebhookSignature(payload: string, signature: string): boolean {
        // PRODUCTION: This requires complex logic (e.g., verifying timestamp, generating HMAC)
        // Mocked for Phase 1: Only pass if signature matches secret
        return signature === EMAIL_WEBHOOK_SECRET; 
    }
}
```

#### **48.3. `src/services/notification.service.ts` (Updates)**

```typescript
// src/services/notification.service.ts (partial update)
// ... (Imports, NotificationService class definition) ...
import { IEmailAdapter, IEmailSendDTO } from '../notificationAdapters/email.interface';
import { SendGridAdapter } from '../notificationAdapters/sendgrid.adapter'; // Mock adapter
import { IUserInboxModel } from '../models/userNotification.model';

const emailAdapter = new SendGridAdapter(); // Assume SendGrid is the active provider


export class NotificationService {
    // ... (All previous methods) ...

    /** Simulates dispatching a notification email. Called by the Worker/Job (Task 47). */
    public async sendEmailNotification(recipientEmail: string, content: any, notificationId: string): Promise<any> {
        // 1. Build Provider DTO
        const sendDto: IEmailSendDTO = {
            to: recipientEmail,
            subject: content.email.subject,
            html: content.email.html,
            text: content.email.text,
            providerRefId: notificationId, // Use internal ID for webhook correlation
        };

        // 2. Call Adapter
        const result = await emailAdapter.sendEmail(sendDto);

        // PRODUCTION: Create DispatchAttempt record for audit (Task 47)

        return result;
    }

    /** Handles incoming webhook events from the Email Provider (e.g., bounce, delivered). */
    public async handleEmailWebhook(payload: any, signature: string): Promise<void> {
        // 1. SECURITY: Verify Signature
        const rawPayload = JSON.stringify(payload);
        if (!emailAdapter.verifyWebhookSignature(rawPayload, signature)) {
            throw new Error('InvalidWebhookSignature');
        }

        // 2. Process Events (Mock Logic)
        if (Array.isArray(payload)) {
            for (const event of payload) {
                const { event: type, email, providerMessageId } = event; // Example fields
                
                // PRODUCTION: Find DispatchAttempt record by providerMessageId/email
                // Update status to 'success' or 'permanent_failed' (bounce)
                
                if (type === 'bounce') {
                    // CRITICAL: Trigger bounce suppression logic here (Task 60)
                    console.warn(`[Bounce/Webhook] Permanent Failure for ${email}. Triggering suppression.`);
                }
            }
        }
    }
}
```

#### **48.4. `src/controllers/notification.controller.ts` (Updates)**

```typescript
// src/controllers/notification.controller.ts (partial update)
// ... (Imports, notificationService initialization, previous controllers) ...
import { Request, Response } from 'express';
import { header } from 'express-validator';

// --- Webhook Controller ---

/** Receives webhooks from the Email Provider. POST /webhooks/notifications/email */
export const emailWebhookController = async (req: Request, res: Response) => {
    // 1. Retrieve Signature and Payload (Raw body is often required by PSP)
    const signature = req.headers['x-email-signature'] || req.headers['x-sendgrid-signature'] || 'no-signature';
    
    // NOTE: In a real Express setup, you must use a middleware like body-parser.raw to get the raw body string.
    const rawBody = (req as any).rawBody || JSON.stringify(req.body); 

    try {
        // 2. Service Call (handles signature, parsing, and update logic)
        await notificationService.handleEmailWebhook(req.body, signature as string);

        // 3. Success (200 OK) - Required by provider
        return res.status(200).send('OK');

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'InvalidWebhookSignature') {
            // Must return 401 on failed security check
            return res.status(401).json({ error: { code: 'signature_invalid', message: 'Webhook signature validation failed.' } });
        }
        // Return 400 on parsing/processing error, but avoid 500 for non-fatal errors
        return res.status(400).json({ error: { code: 'webhook_fail', message: 'Error processing email event.' } });
    }
};
```

#### **48.5. `src/routes/notification.routes.ts` (Updates)**

```typescript
// src/routes/notification.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 47) ...
import { emailWebhookController } from '../controllers/notification.controller';

const router = Router();
// ... (All other Task 11/46/47 endpoints) ...


// --- Webhooks (Public) ---

// POST /webhooks/notifications/email - Email Provider webhook receiver (Task 48)
// NOTE: This route needs special raw body parsing middleware in the main Express config.
router.post('/webhooks/notifications/email', emailWebhookController);


export default router;
```

#### **48.6. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T48.1** | `Unit Test` | Adapter Send DTO Check | `sendEmail` call | Returns `providerMessageId` | N/A |
| **T48.2** | `POST /webhooks/email` | Happy Path: Delivered Event | Valid Signature, `event: 'delivered'` | **200 OK** | N/A |
| **T48.3** | `POST /webhooks/email` | Fail: Invalid Signature | Invalid/Missing `X-Signature` header | **401 Unauthorized** | `signature_invalid` |
| **T48.4** | `POST /webhooks/email` | Fail: Bounce Event | Valid Signature, `event: 'bounce'` | **200 OK** | Service logs warning/triggers suppression (not API status fail). |

---

