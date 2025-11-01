Following the structured plan, we proceed with **Task 51: Webhook Subscriptions & Delivery Management**.

This task implements the final external communication feature of the `Notifications Service`, allowing external partners (or internal services) to subscribe to platform events and receive notifications via a custom webhook endpoint.

***

## **Task 51: Webhook Subscriptions & Delivery Management**

**Goal:** Implement the `WebhookSubscription` model and the necessary CRUD endpoints (`POST/PUT/DELETE /webhook-subscriptions`) to manage external subscriptions to internal platform events, including signature secret storage and activation status.

**Service:** `Notifications Service`
**Phase:** G - Notifications, Webhooks...
**Dependencies:** Task 11 (Notification Model, Service Structure), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/webhookSubscription.model.ts` (New file: IWebhookSubscription, WebhookSubscriptionSchema/Model)
2.  `src/services/notification.service.ts` (Updated: `createSubscription`, `updateSubscription`, `deleteSubscription`)
3.  `src/controllers/notification.controller.ts` (Updated: new subscription controllers)
4.  `src/routes/notification.routes.ts` (Updated: new protected routes)
5.  `test/integration/webhook_manage.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (201 Created/204 No Content) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /webhook-subscriptions** | `{ event: string, url: string, secret: string }` | `{ subscriptionId: string, status: 'active' }` | Auth (Admin/System Only) |
| **DELETE /webhook-subscriptions/:id** | `Params: { subscriptionId }` | **204 No Content** | Auth (Admin/System Only) |

**WebhookSubscriptionDTO (Excerpt):**
```json
{
  "subscriptionId": "whsub_001",
  "event": "project.milestone.approved",
  "url": "https://partner.com/hook",
  "status": "active"
}
```

**Runtime & Env Constraints:**
*   **Security:** The `secret` (used for HMAC signing the outgoing payload) must be treated as sensitive data (encrypted storage/hidden in DTOs).
*   **Authorization:** Webhook management is a highly privileged operation; strictly restricted to Admin/System users (`ADMIN_DASHBOARD`).
*   **Delivery (Future):** The system must support asynchronous delivery to these URLs via a dedicated Job/Worker (Task 52/58), which verifies the secret via the stored hash.

**Acceptance Criteria:**
*   `POST /webhook-subscriptions` successfully creates the record, hashing the provided `secret` before storage and marking the subscription as `active`.
*   The API returns the non-hashed subscription object (excluding the secret).
*   All CRUD endpoints must enforce Admin access (403 Forbidden).

**Tests to Generate:**
*   **Integration Test (Create/Delete):** Test creation success (hash secret check), successful deletion, and unauthorized access failures.

***

### **Task 51 Code Implementation**

#### **51.1. `src/models/webhookSubscription.model.ts` (New Model)**

```typescript
// src/models/webhookSubscription.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IWebhookSubscription {
  _id?: Types.ObjectId;
  subscriptionId: string;
  event: string; // The internal event name to subscribe to (e.g., 'project.milestone.approved')
  url: string; // Partner's endpoint URL
  secretHash: string; // Hashed version of the partner's shared secret (for verification)
  status: 'active' | 'inactive' | 'failed';
  createdBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
  lastAttemptedAt?: Date; // For monitoring/retries
}

const WebhookSubscriptionSchema = new Schema<IWebhookSubscription>({
  subscriptionId: { type: String, required: true, unique: true, default: () => `whsub_${crypto.randomBytes(6).toString('hex')}` },
  event: { type: String, required: true, index: true },
  url: { type: String, required: true, maxlength: 500 },
  secretHash: { type: String, required: true }, // SECURITY: Hashed secret
  status: { type: String, enum: ['active', 'inactive', 'failed'], default: 'active', index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  lastAttemptedAt: { type: Date },
}, { timestamps: true });

export const WebhookSubscriptionModel = model<IWebhookSubscription>('WebhookSubscription', WebhookSubscriptionSchema);
```

#### **51.2. `src/services/notification.service.ts` (Updates)**

```typescript
// src/services/notification.service.ts (partial update)
// ... (Imports from Task 50) ...
import { WebhookSubscriptionModel, IWebhookSubscription } from '../models/webhookSubscription.model';
import { hash, compare } from 'bcryptjs'; 

export class NotificationService {
    // ... (All previous notification/dispatch methods) ...
    
    /** Creates a new webhook subscription. */
    public async createSubscription(requesterId: string, data: any): Promise<IWebhookSubscription> {
        const { event, url, secret } = data;

        // 1. Hash the secret (Security)
        const secretHash = await hash(secret, 10);

        // 2. Create Subscription
        const newSubscription = new WebhookSubscriptionModel({
            event,
            url,
            secretHash,
            status: 'active',
            createdBy: new Types.ObjectId(requesterId),
        });
        const savedSubscription = await newSubscription.save();
        
        // PRODUCTION: Emit 'webhook.subscription.created' event
        
        // 3. Map to DTO (Exclude sensitive secretHash)
        const dto = savedSubscription.toObject() as IWebhookSubscription;
        delete (dto as any).secretHash;
        
        return dto;
    }
    
    /** Updates a webhook subscription (e.g., status, URL, or secret). */
    public async updateSubscription(subscriptionId: string, data: any): Promise<IWebhookSubscription> {
        const update: any = {};
        if (data.event) update.event = data.event;
        if (data.url) update.url = data.url;
        if (data.status) update.status = data.status;
        
        // Hash the secret if it is being updated
        if (data.secret) {
            update.secretHash = await hash(data.secret, 10);
        }
        
        const updatedSubscription = await WebhookSubscriptionModel.findOneAndUpdate(
            { subscriptionId },
            { $set: update },
            { new: true }
        );

        if (!updatedSubscription) { throw new Error('SubscriptionNotFound'); }
        
        // Map to DTO (Exclude sensitive secretHash)
        const dto = updatedSubscription.toObject() as IWebhookSubscription;
        delete (dto as any).secretHash;
        
        return dto;
    }
    
    /** Deletes a webhook subscription. */
    public async deleteSubscription(subscriptionId: string): Promise<void> {
        const result = await WebhookSubscriptionModel.deleteOne({ subscriptionId });
        if (result.deletedCount === 0) { throw new Error('SubscriptionNotFound'); }
    }
    
    /** (Future Worker Logic) Retrieves all active subscriptions for a given event. */
    public async getActiveSubscriptionsForEvent(event: string): Promise<IWebhookSubscription[]> {
        const subscriptions = await WebhookSubscriptionModel.find({ event, status: 'active' }).lean() as IWebhookSubscription[];
        return subscriptions;
    }
}
```

#### **51.3. `src/controllers/notification.controller.ts` (Updates)**

```typescript
// src/controllers/notification.controller.ts (partial update)
// ... (Imports, notificationService initialization, previous controllers) ...
import { body, param, validationResult } from 'express-validator';

// --- Validation Middleware ---

export const subscriptionValidation = [
    body('event').isString().isLength({ min: 5 }).withMessage('Event name is required.'),
    body('url').isURL({ protocols: ['https'], require_tld: false }).withMessage('URL must be a valid HTTPS URL.'),
    body('secret').isString().isLength({ min: 16 }).withMessage('Secret is required (min 16 chars).'),
];

export const subscriptionUpdateValidation = [ // Reuse and make fields optional
    body('event').optional().isString(),
    body('url').optional().isURL({ protocols: ['https'], require_tld: false }),
    body('secret').optional().isString().isLength({ min: 16 }),
    body('status').optional().isIn(['active', 'inactive']),
];

export const subscriptionIdValidation = [
    param('subscriptionId').isString().withMessage('Subscription ID is required.'),
];


// --- Admin Webhook Controllers ---

/** Creates a new webhook subscription. POST /webhook-subscriptions */
export const createSubscriptionController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const result = await notificationService.createSubscription(req.user!.sub, req.body);
        return res.status(201).json(result);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error creating subscription.' } });
    }
};

/** Updates a webhook subscription. PUT /webhook-subscriptions/:id */
export const updateSubscriptionController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const result = await notificationService.updateSubscription(req.params.subscriptionId, req.body);
        return res.status(200).json(result);
    } catch (error: any) {
        if (error.message === 'SubscriptionNotFound') { return res.status(404).json({ error: { code: 'not_found', message: 'Subscription not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating subscription.' } });
    }
};

/** Deletes a webhook subscription. DELETE /webhook-subscriptions/:id */
export const deleteSubscriptionController = async (req: Request, res: Response) => {
    try {
        await notificationService.deleteSubscription(req.params.subscriptionId);
        return res.status(204).send();
    } catch (error: any) {
        if (error.message === 'SubscriptionNotFound') { return res.status(404).json({ error: { code: 'not_found', message: 'Subscription not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error deleting subscription.' } });
    }
};
```

#### **51.4. `src/routes/notification.routes.ts` (Updates)**

```typescript
// src/routes/notification.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 47/48/50) ...
import { 
    createSubscriptionController, updateSubscriptionController, deleteSubscriptionController,
    subscriptionValidation, subscriptionUpdateValidation, subscriptionIdValidation
} from '../controllers/notification.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; 


// ... (All other Task 11/46/47/50 endpoints) ...


// --- Admin Webhook Subscriptions (Task 51) ---

// POST /webhook-subscriptions - Create new subscription
router.post(
    '/webhook-subscriptions',
    authenticate,
    authorize(adminAccess), 
    subscriptionValidation,
    createSubscriptionController
);

// PUT /webhook-subscriptions/:subscriptionId - Update subscription
router.put(
    '/webhook-subscriptions/:subscriptionId',
    authenticate,
    authorize(adminAccess),
    subscriptionIdValidation,
    subscriptionUpdateValidation,
    updateSubscriptionController
);

// DELETE /webhook-subscriptions/:subscriptionId - Delete subscription
router.delete(
    '/webhook-subscriptions/:subscriptionId',
    authenticate,
    authorize(adminAccess),
    subscriptionIdValidation,
    deleteSubscriptionController
);


export default router;
```

#### **51.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T51.1** | `POST /webhook-subscriptions` | Happy Path: Creation | Auth Admin, Valid Payload | **201 Created** | N/A (Secret stored as hash) |
| **T51.2** | `POST /webhook-subscriptions` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T51.3** | `PUT /webhook-subscriptions/:id` | Happy Path: Update URL | Auth Admin | **200 OK** | `url` field updated. |
| **T51.4** | `DELETE /webhook-subscriptions/:id` | Happy Path: Delete | Auth Admin | **204 No Content** | N/A |
| **T51.5** | `DELETE /webhook-subscriptions/:id` | Fail: Not Found | Auth Admin, Invalid ID | **404 Not Found** | `not_found` |

---