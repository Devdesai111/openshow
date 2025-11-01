Following the project plan and prioritizing the foundational elements for asynchronous communication, here is the detailed implementation for **Task 11: Notifications Queue & Templating Engine**.

This task establishes the core data models and service logic necessary for all other services (Projects, Payments, etc.) to trigger notifications, fulfilling a high-priority architectural dependency.

***

## **Task 11: Notifications Queue & Templating Engine**

**Goal:** Implement the core Notification data model (`INotification`, `NotificationModel`) and the service layer (`NotificationService`) capable of receiving a template ID/variables, rendering channel-specific content, and queuing the final notification record for the dispatcher (Worker/Job).

**Service:** `Notifications Service`
**Phase:** G - Notifications, Webhooks... (Brought Forward)
**Dependencies:** Task 1 (User Model, ID types), Task 2 (RBAC structure), Task 52 (Jobs/Worker Queue - assumed dependency for final send).

**Output Files:**
1.  `src/models/notification.model.ts` (INotification, NotificationSchema/Model)
2.  `src/models/notificationTemplate.model.ts` (INotificationTemplate, NotificationTemplateSchema/Model)
3.  `src/services/notification.service.ts` (New file: `NotificationService` with `sendTemplateNotification`)
4.  `src/controllers/notification.controller.ts` (New file: Admin/Internal endpoints for testing/triggering)
5.  `src/routes/notification.routes.ts` (New file: router definitions)
6.  `test/unit/notification_render.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (202 Accepted) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /notifications/send** | `{ templateId: string, recipients: { userId }[], variables: {}, channels: [] }` | `{ notificationId: string, status: 'queued' }` | Internal/Auth (Service Token) |

**Notification Model Excerpt:**
```json
{
  "notificationId": "notif_651a...", 
  "type": "project.invite", 
  "status": "queued", 
  "channels": ["in_app", "email"],
  "content": { 
    "email": { "subject": "You were invited...", "html": "<p>...</p>" },
    "in_app": { "title": "Invite Received", "body": "..." } 
  }
}
```

**Runtime & Env Constraints:**
*   Requires a safe, deterministic templating library (e.g., `handlebars` or similar for rendering).
*   The `sendTemplateNotification` must be designed for **internal/service-to-service** consumption.
*   Final dispatch to channels is a Job/Worker responsibility (simulated by emitting an event/console log).

**Acceptance Criteria:**
*   A `POST /notifications/send` request renders content correctly and returns **202 Accepted**.
*   If a required `variable` is missing from the request, the service must throw a **422 Unprocessable** error.
*   The persistence layer (`NotificationModel`) must store the *rendered, channel-specific content* (the content snapshot).
*   The service must emit a `notification.created` event (or queue a job) upon successful database insertion.

**Tests to Generate:**
*   **Unit Test (Rendering):** Test template rendering logic with variables, ensuring HTML is safely escaped.
*   **Integration Test (Queue):** Test required variables validation (422) and successful database persistence.

**Non-Goals / Out-of-Scope (for Task 11):**
*   Actual dispatch to email/push providers (Task 48, 49).
*   User-specific read/unread status (Task 50).
*   Full template CRUD endpoints (internal/Admin-only endpoints provided for simplicity).

***

### **Task 11 Code Implementation**

#### **11.1. `src/models/notificationTemplate.model.ts`**

```typescript
// src/models/notificationTemplate.model.ts
import { Schema, model, Types } from 'mongoose';

// Defines the structure of content parts required for a template's channels
interface IChannelParts {
    title: string;
    body: string;
    metadataSchema?: any;
    // Specific fields for email/push/webhook would be added here
}

export interface INotificationTemplate {
    _id?: Types.ObjectId;
    templateId: string; // Machine-readable key (e.g., 'project.invite.v1')
    name: string;
    description?: string;
    channels: ('in_app' | 'email' | 'push' | 'webhook')[]; // Channels this template supports
    contentTemplate: {
        in_app?: IChannelParts;
        email?: { subject: string; html: string; text?: string };
        push?: IChannelParts;
        webhook?: { payloadTemplate: any };
    };
    requiredVariables: string[]; // Variables needed for rendering (e.g., ['inviter', 'projectTitle'])
    defaultLocale: string;
    version: number;
    active: boolean;
    createdAt?: Date;
    updatedAt?: Date;
}

const TemplateSchema = new Schema<INotificationTemplate>({
    templateId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    channels: { type: [String], enum: ['in_app', 'email', 'push', 'webhook'], required: true },
    contentTemplate: { 
        // Schema.Types.Mixed allows for flexible content structures per channel
        type: Schema.Types.Mixed, 
        required: true 
    },
    requiredVariables: { type: [String], default: [] },
    defaultLocale: { type: String, default: 'en' },
    version: { type: Number, default: 1 },
    active: { type: Boolean, default: true },
}, { timestamps: true });

export const NotificationTemplateModel = model<INotificationTemplate>('NotificationTemplate', TemplateSchema);
```

#### **11.2. `src/models/notification.model.ts`**

```typescript
// src/models/notification.model.ts
import { Schema, model, Types } from 'mongoose';

// Defines a single recipient for a notification
interface IRecipient {
    userId?: Types.ObjectId;
    email?: string; // Fallback or external email
    pushToken?: string;
    channelOverrides?: ('in_app' | 'email' | 'push' | 'webhook')[];
    // Future: webhookUrl
}

// Defines the final rendered content snapshot
interface IRenderedContent {
    in_app?: { title: string; body: string; metadata?: any };
    email?: { subject: string; html: string; text?: string };
    // Future: push, webhook content
}

export interface INotification {
    _id?: Types.ObjectId;
    notificationId: string; // Unique, human-readable ID
    projectId?: Types.ObjectId; 
    type: string; // E.g., 'project.invite', 'payment.succeeded'
    templateId?: string;
    recipients: IRecipient[];
    content: IRenderedContent; // Snapshot of the rendered content
    channels: ('in_app' | 'email' | 'push' | 'webhook')[]; // Final channels to attempt dispatch
    status: 'queued' | 'processing' | 'sent' | 'partial' | 'failed' | 'cancelled';
    scheduledAt?: Date;
    expiresAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
}

const NotificationSchema = new Schema<INotification>({
    notificationId: { type: String, required: true, unique: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },
    type: { type: String, required: true, index: true },
    templateId: { type: String },
    recipients: { type: [Schema.Types.Mixed], required: true }, // Mixed for flexibility in recipient data
    content: { type: Schema.Types.Mixed, required: true },
    channels: { type: [String], enum: ['in_app', 'email', 'push', 'webhook'], required: true },
    status: { type: String, enum: ['queued', 'processing', 'sent', 'partial', 'failed', 'cancelled'], default: 'queued', index: true },
    scheduledAt: { type: Date, index: true },
    expiresAt: { type: Date, index: true },
}, { timestamps: true });

export const NotificationModel = model<INotification>('Notification', NotificationSchema);
```

#### **11.3. `src/services/notification.service.ts`**

```typescript
// src/services/notification.service.ts
import { INotification, NotificationModel } from '../models/notification.model';
import { INotificationTemplate, NotificationTemplateModel } from '../models/notificationTemplate.model';
import { Types } from 'mongoose';
import * as handlebars from 'handlebars'; // Mocking handlebars for templating

// DTO for incoming template-based send request
interface ITemplateSendRequest {
    templateId: string;
    recipients: { userId: string, email?: string }[];
    variables: Record<string, string>;
    channels?: INotification['channels']; // Override template default channels
    scheduledAt?: Date;
}

export class NotificationService {
    
    /**
     * Renders template content using provided variables.
     * @param templateContent - The content part (e.g., template.contentTemplate.email).
     * @param variables - Key-value pair for templating.
     * @returns Rendered content object.
     * @throws {Error} - 'VariableMissing' for missing required variables.
     */
    private renderContent(templateContent: any, variables: Record<string, string>): any {
        const rendered: any = {};
        
        // Helper to check for missing variables globally
        const templateSource = JSON.stringify(templateContent);
        const missingVars = (templateSource.match(/{{(.*?)}}/g) || [])
            .map(v => v.replace(/[{}]/g, '').trim())
            .filter(v => !variables.hasOwnProperty(v));

        if (missingVars.length > 0) {
            throw new Error(`VariableMissing: ${missingVars.join(', ')}`);
        }

        // Iterate through content parts (subject, body, html, etc.) and render
        for (const key in templateContent) {
            if (typeof templateContent[key] === 'string') {
                const template = handlebars.compile(templateContent[key]);
                rendered[key] = template(variables);
            } else {
                rendered[key] = templateContent[key];
            }
        }
        
        return rendered;
    }

    /**
     * Receives a template, renders it, and queues the final notification record in the DB.
     * @param request - The template ID, recipients, and variables.
     * @returns The created notification object.
     * @throws {Error} - 'TemplateNotFound' | 'VariableMissing'.
     */
    public async sendTemplateNotification(request: ITemplateSendRequest): Promise<INotification> {
        const { templateId, recipients, variables, channels, scheduledAt } = request;

        // 1. Fetch Template
        const template = await NotificationTemplateModel.findOne({ templateId, active: true }).lean() as INotificationTemplate;
        if (!template) {
            throw new Error('TemplateNotFound');
        }

        // 2. Validate Required Variables
        template.requiredVariables.forEach(key => {
            if (!variables.hasOwnProperty(key)) {
                throw new Error(`VariableMissing: ${key}`);
            }
        });

        // 3. Render Content Snapshot (ASYNC/AWAIT not strictly necessary here, but good practice)
        const contentSnapshot: INotification['content'] = {};
        for (const channel of template.channels) {
            if (template.contentTemplate[channel]) {
                contentSnapshot[channel] = this.renderContent(template.contentTemplate[channel], variables);
            }
        }

        // 4. Create Final Notification Record
        const finalChannels = channels || template.channels;
        const newNotification = new NotificationModel({
            notificationId: `notif_${crypto.randomBytes(8).toString('hex')}`, // Unique ID
            type: template.templateId,
            templateId: template.templateId,
            recipients: recipients.map(r => ({ userId: new Types.ObjectId(r.userId), email: r.email })),
            content: contentSnapshot,
            channels: finalChannels,
            status: scheduledAt ? 'queued' : 'queued', // Always 'queued' for dispatcher
            scheduledAt,
        });

        const savedNotification = await newNotification.save();

        // 5. Trigger Dispatcher/Job (Simulated)
        // PRODUCTION: Emit 'notification.created' event (Task 47 subscribes to this)
        console.log(`[Event] Notification ${savedNotification.notificationId} created and queued for dispatch.`);

        return savedNotification.toObject() as INotification;
    }
}
```

#### **11.4. `src/controllers/notification.controller.ts` (New File)**

```typescript
// src/controllers/notification.controller.ts
import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { NotificationService } from '../services/notification.service';
import { Types } from 'mongoose';

const notificationService = new NotificationService();

// --- Internal/Admin-Only Route Validation ---

export const sendNotificationValidation = [
    body('templateId').isString().withMessage('Template ID is required.'),
    body('recipients').isArray({ min: 1 }).withMessage('At least one recipient is required.'),
    body('recipients.*.userId').isMongoId().withMessage('Recipient User ID must be valid Mongo ID.'),
    body('variables').isObject().withMessage('Variables must be an object.'),
    body('scheduledAt').optional().isISO8601().toDate().withMessage('ScheduledAt must be a valid ISO 8601 date.'),
    body('channels').optional().isArray().withMessage('Channels must be an array.'),
];

// NOTE: Admin/Internal routes for simplified template creation for initial testing
export const initialTemplateCreationController = async (req: Request, res: Response) => {
    // SECURITY: This is a placeholder for Admin/Seeding. Real production requires a secure template editor.
    try {
        const result = await NotificationTemplateModel.create(req.body);
        return res.status(201).json({ templateId: result.templateId });
    } catch(e) {
        return res.status(500).send();
    }
};

/** Handles incoming requests from other services to send a notification. POST /notifications/send */
export const sendNotificationController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: errors.array() }});
    }

    try {
        // 2. Service Call: Renders and Queues
        const savedNotification = await notificationService.sendTemplateNotification(req.body);

        // 3. Success (202 Accepted - task handed off to background queue)
        return res.status(202).json({
            notificationId: savedNotification.notificationId,
            status: savedNotification.status,
            message: 'Notification accepted and queued for rendering and dispatch.',
        });

    } catch (error: any) {
        // 4. Error Handling
        if (error.message.startsWith('VariableMissing')) {
            return res.status(422).json({ error: { code: 'template_error', message: `Missing required template variable: ${error.message.split(': ')[1]}` } });
        }
        if (error.message === 'TemplateNotFound') {
            return res.status(404).json({ error: { code: 'template_not_found', message: 'The specified template ID was not found or is inactive.' } });
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error queuing notification.' } });
    }
};
```

#### **11.5. `src/routes/notification.routes.ts` (New File)**

```typescript
// src/routes/notification.routes.ts
import { Router } from 'express';
import { sendNotificationController, sendNotificationValidation, initialTemplateCreationController } from '../controllers/notification.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Internal/Service-to-Service Endpoints ---

// POST /notifications/send - Send a notification via template (Task 11)
// NOTE: This must be protected by a service token/secret in production, 
// using Admin permission for Phase 1 simulation.
router.post(
    '/send',
    authenticate, // Internal service authentication
    authorize([PERMISSIONS.ADMIN_DASHBOARD]), // Simulating internal service role
    sendNotificationValidation,
    sendNotificationController
);

// POST /notifications/templates - Admin endpoint to create initial templates (Placeholder for later Task 46)
router.post('/templates', initialTemplateCreationController); 


// ... (Future Task 50 endpoints for user-facing lists will be here) ...

export default router;
```

---