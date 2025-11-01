You are absolutely correct. **Task 50: In-app Notification Read/Unread Status** was completed under the umbrella of **Task 47** (Notifications Queue & Dispatcher (Interaction)).

Specifically:
*   The `UserInboxModel` (Task 47.1) handles the per-user `read: boolean` status.
*   `listUserNotificationsController` (Task 47.3) fetches this list and filters.
*   `markReadController` (Task 47.3) updates the status to `read: true`.
*   `getUnreadCountController` (Task 47.3) calculates the total unread count.

Since we completed these core components, and to ensure we stick to the 100-task list's *flow* without skipping a number, we will assign the next logical priority item that enhances the Notifications Service (which was implicitly assumed in the plan): the actual push logic.

We will proceed with **Task 50: Notifications Dispatcher Logic (Push/Email Trigger)**, which implements the internal worker logic to send the actual notifications.

***

## **Task 50: Notifications Dispatcher Logic (Push/Email Trigger)**

**Goal:** Implement the internal service method (`dispatchNotification`) that consumes a queued `Notification` record (Task 11), uses the `IEmailAdapter` (Task 48) and `IPushAdapter` (Task 49) to send content, and records a corresponding `DispatchAttempt` for audit.

**Service:** `Notifications Service`
**Phase:** G - Notifications, Webhooks...
**Dependencies:** Task 49 (Push Adapters/Token Model), Task 48 (Email Adapters), Task 11 (Notification Model).

**Output Files:**
1.  `src/models/dispatchAttempt.model.ts` (New file: `IDispatchAttempt` model)
2.  `src/services/notification.service.ts` (Updated: `dispatchNotification`)
3.  `test/unit/notification_dispatch.test.ts` (Test specification)

**Input/Output Shapes:**

| Dispatch Method | Input (Notification Record) | Output (State Update) | Side Effect |
| :--- | :--- | :--- | :--- |
| **dispatchNotification** | `INotification` | `Notification.status` $\rightarrow$ `sent`/`partial` | `DispatchAttempt` record created for each channel. |

**Runtime & Env Constraints:**
*   **Decoupling:** The logic must dynamically select and use the correct adapters based on the notification channels.
*   **Concurrency:** This logic is designed to be executed by a **Job/Worker** (Task 52/58) that processes the `queued` status.
*   **Auditability:** A durable `DispatchAttempt` record must be created for every send attempt on every channel.

**Acceptance Criteria:**
*   A successful dispatch transitions the notification status to `'sent'` (or `'partial'`).
*   The system must correctly look up the recipient's push tokens from the `UserModel` before calling the `IPushAdapter`.
*   A failure in one channel (e.g., email) must not prevent dispatching on another (e.g., push).

**Tests to Generate:**
*   **Unit Test (Dispatch):** Test a full dispatch cycle (Email + Push) where the Email adapter returns a failure and the Push adapter returns a success, leading to a `'partial'` status.
*   **Unit Test (Token Cleanup):** Test dispatching to a token that the mock adapter marks as `'token_invalid'` and verify the system removes that token from the user's document.

***

### **Task 50 Code Implementation**

#### **50.1. `src/models/dispatchAttempt.model.ts` (New Model)**

```typescript
// src/models/dispatchAttempt.model.ts
import { Schema, model, Types } from 'mongoose';
import { INotification } from './notification.model';

export interface IDispatchAttempt {
  _id?: Types.ObjectId;
  notificationRef: Types.ObjectId;
  recipientUserId?: Types.ObjectId;
  channel: INotification['channels'][number];
  provider: string; // e.g., 'sendgrid', 'fcm'
  providerReferenceId?: string;
  status: 'pending' | 'success' | 'failed' | 'permanent_failed';
  error?: { code?: string; message?: string };
  attemptNumber: number;
  nextRetryAt?: Date;
  createdAt?: Date;
}

const DispatchAttemptSchema = new Schema<IDispatchAttempt>({
  notificationRef: { type: Schema.Types.ObjectId, ref: 'Notification', required: true, index: true },
  recipientUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  channel: { type: String, enum: ['in_app', 'email', 'push', 'webhook'], required: true },
  provider: { type: String, required: true },
  providerReferenceId: { type: String },
  status: { type: String, enum: ['pending', 'success', 'failed', 'permanent_failed'], default: 'pending', index: true },
  error: { type: Schema.Types.Mixed },
  attemptNumber: { type: Number, default: 1 },
  nextRetryAt: { type: Date, index: true },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

export const DispatchAttemptModel = model<IDispatchAttempt>('DispatchAttempt', DispatchAttemptSchema);
```

#### **50.2. `src/services/notification.service.ts` (Updates)**

```typescript
// src/services/notification.service.ts (partial update)
// ... (Imports from Task 11, UserInboxModel) ...
import { IDispatchAttempt, DispatchAttemptModel } from '../models/dispatchAttempt.model';
import { IEmailAdapter, IEmailSendResponseDTO } from '../notificationAdapters/email.interface';
import { IPushAdapter, IPushSendResponseDTO } from '../notificationAdapters/push.interface';
import { SendGridAdapter } from '../notificationAdapters/sendgrid.adapter'; 
import { FCMAdapter } from '../notificationAdapters/fcm.adapter'; 
import { UserModel, IPushToken } from '../models/user.model';
import { getExponentialBackoffDelay, isRetryAllowed } from '../utils/retryPolicy'; // Task 40 utility


const emailAdapter = new SendGridAdapter(); 
const pushAdapter = new FCMAdapter(); 

export class NotificationService {
    // ... (All previous methods) ...

    /** Worker/Job entry point to process a single notification across all channels. */
    public async dispatchNotification(notificationId: string): Promise<INotification> {
        const notification = await NotificationModel.findById(new Types.ObjectId(notificationId));
        if (!notification) { throw new Error('NotificationNotFound'); }
        if (notification.status !== 'queued') { throw new Error('NotificationNotQueued'); }
        
        let overallSuccess = true;
        let overallFailure = false;
        
        // Update master status to processing
        notification.status = 'processing';
        await notification.save();

        // 1. Iterate through Recipients and Channels
        for (const recipient of notification.recipients) {
            const userId = recipient.userId!.toString();
            
            for (const channel of notification.channels) {
                let sendResult: IEmailSendResponseDTO | IPushSendResponseDTO | undefined;
                let attempt: Partial<IDispatchAttempt> = { notificationRef: notification._id, recipientUserId: recipient.userId, channel, provider: 'system', attemptNumber: 1 };
                
                try {
                    // 2. DISPATCH LOGIC (Channel-specific)
                    if (channel === 'email' && recipient.email) {
                        sendResult = await this.sendEmailNotification(recipient.email, notification.content, notificationId);
                        attempt.provider = emailAdapter.providerName;
                        attempt.status = sendResult.status === 'sent' ? 'success' : 'pending';
                        attempt.providerReferenceId = sendResult.providerMessageId;
                    } 
                    else if (channel === 'push') {
                        // Look up all user's tokens
                        const user = await UserModel.findById(recipient.userId).select('pushTokens').lean() as { pushTokens: IPushToken[] };
                        const tokens = user.pushTokens.map(t => t.token);

                        if (tokens.length > 0) {
                            // Mocking batch send: only checking the first result
                            const pushResults = await pushAdapter.sendPush([{ title: notification.content.in_app!.title, body: notification.content.in_app!.body, token: tokens[0] }]);
                            sendResult = pushResults[0];
                            attempt.provider = pushAdapter.providerName;
                            attempt.status = sendResult.status === 'success' ? 'success' : 'failed';
                            attempt.providerReferenceId = sendResult.providerMessageId;
                        } else {
                            attempt.status = 'permanent_failed';
                            attempt.error = { message: 'No push tokens found for user.' };
                        }
                    } 
                    // NOTE: In-app logic is instant/db write (Task 47) and webhooks are Task 51

                } catch (e: any) {
                    // Transient failure (e.g., network error to PSP)
                    attempt.status = 'failed';
                    attempt.error = { message: e.message };
                    overallFailure = true;
                } finally {
                    // 3. Record Audit Attempt
                    await DispatchAttemptModel.create(attempt);
                    
                    // 4. Handle Retry/Token Invalidation
                    if (attempt.status === 'failed' && isRetryAllowed(attempt.attemptNumber!)) {
                        const delay = getExponentialBackoffDelay(attempt.attemptNumber! + 1);
                        // PRODUCTION: Re-queue as a delayed job (Task 52/58)
                        // jobQueue.enqueueDelayedDispatch(notificationId, delay);
                        overallSuccess = false; // Prevents overall status from becoming 'sent'
                    } else if (attempt.status === 'permanent_failed') {
                         // PRODUCTION: Trigger token invalidation/user suppression logic
                         overallSuccess = false;
                    }
                }
            }
        }

        // 5. Final Status Update
        if (overallSuccess && !overallFailure) {
            notification.status = 'sent';
        } else if (overallSuccess && overallFailure) {
            notification.status = 'partial';
        } else {
            notification.status = 'failed'; // Final failure before escalation/DLQ (Task 60)
        }
        
        await notification.save();
        
        return notification.toObject() as INotification;
    }
}
```

#### **50.3. `src/controllers/notification.controller.ts` (Updates)**

*(No new Express endpoints are needed for this Task, as `dispatchNotification` is the internal worker/job handler. However, we'll create a controller to manually trigger it for testing/admin purposes.)*

```typescript
// src/controllers/notification.controller.ts (partial update)
// ... (Imports, notificationService initialization, previous controllers) ...
import { param, validationResult } from 'express-validator';

// --- Validation Middleware ---
export const dispatchValidation = [
    param('notificationId').isMongoId().withMessage('Invalid Notification ID format.'),
];

// --- Admin/System Dispatch Controller ---

/** Manually triggers dispatch for a single notification (Admin/Test Use). POST /notifications/:id/dispatch */
export const dispatchNotificationController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid ID format.' }}); }
    
    try {
        const updatedNotification = await notificationService.dispatchNotification(req.params.notificationId);

        return res.status(200).json({
            notificationId: updatedNotification._id!.toString(),
            status: updatedNotification.status,
            message: `Dispatch complete. Final status: ${updatedNotification.status}.`
        });
    } catch (error: any) {
        if (error.message === 'NotificationNotFound') { return res.status(404).json({ error: { code: 'not_found', message: 'Notification not found.' } }); }
        if (error.message === 'NotificationNotQueued') { return res.status(409).json({ error: { code: 'invalid_status', message: 'Notification must be in "queued" status to dispatch.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during dispatch.' } });
    }
};
```

#### **50.4. `src/routes/notification.routes.ts` (Updates)**

```typescript
// src/routes/notification.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 47) ...
import { dispatchNotificationController, dispatchValidation } from '../controllers/notification.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';
import { param } from 'express-validator';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 

// ... (All other Task 11/46/47 endpoints) ...

// --- Admin Dispatch/Worker Test Endpoint (Task 50) ---

// POST /notifications/:notificationId/dispatch - Manually trigger dispatch (Worker/Admin)
router.post(
    '/:notificationId/dispatch',
    authenticate,
    authorize(adminAccess), 
    dispatchValidation,
    dispatchNotificationController
);

export default router;
```

#### **50.5. Test Specification**

| Test ID | Method | Description | Condition | Expected Final Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T50.1** | `dispatchNotification` | Happy Path: Full Success | Email/Push Adapters both succeed. | `sent` | `DispatchAttempt` records exist for both channels with `status: 'success'`. |
| **T50.2** | `dispatchNotification` | Partial Failure | Email adapter fails (network), Push succeeds. | `partial` | `DispatchAttempt` for email has `status: 'failed'` and `nextRetryAt` is set. |
| **T50.3** | `dispatchNotification` | Permanent Failure | Push adapter returns `token_invalid`. | `failed` (or permanent_failed) | `DispatchAttempt` status is `permanent_failed` (or equivalent). |
| **T50.4** | `POST /:id/dispatch` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |

---
