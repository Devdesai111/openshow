Following the structured plan, we proceed with **Task 47: Notifications Queue & Dispatcher (Interaction)**.

This task is the final step in the Notification Service's core implementation (Phase G), providing the user-facing read/write APIs for in-app notifications and read status management.

***

## **Task 47: Notifications Queue & Dispatcher (Interaction)**

**Goal:** Implement the user-facing endpoints for the in-app notification system: list notifications (`GET /notifications`) with read status, mark notifications as read (`POST /notifications/mark-read`), and provide the unread count summary (`GET /notifications/unread-count`).

**Service:** `Notifications Service`
**Phase:** G - Notifications, Webhooks...
**Dependencies:** Task 11 (Notification Model, Service Structure), Task 44 (User Settings Model - for preferences).

**Output Files:**
1.  `src/models/userNotification.model.ts` (New file: simplified, dedicated model for user's inbox state)
2.  `src/services/notification.service.ts` (Updated: `listUserNotifications`, `markRead`, `getUnreadCount`)
3.  `src/controllers/notification.controller.ts` (Updated: new user-facing controllers)
4.  `src/routes/notification.routes.ts` (Updated: new protected routes)
5.  `test/integration/notification_inbox.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Query) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /notifications** | `query: { page?, status? }` | `NotificationListResponse` (Paginated) | Auth (Self only) |
| **POST /notifications/mark-read** | `{ ids: string[], markAll?: boolean }` | **200 OK** | Auth (Self only) |
| **GET /notifications/unread-count**| N/A | `{ unreadCount: number }` | Auth (Self only) |

**NotificationListResponse (Excerpt):**
```json
{
  "meta": { "total": 12 },
  "data": [ { "id": "notif_1", "title": "New Invite", "read": false, "createdAt": "..." } ]
}
```

**Runtime & Env Constraints:**
*   **Performance:** Unread count must be highly optimized, ideally relying on DB indexing or a fast counter store (Redis/denormalized field). We will use DB indexing for Phase 1.
*   **Authorization:** All endpoints are strictly for the **authenticated user** and their own notifications.
*   **Data Source:** Notifications are sourced from the `NotificationModel` (Task 11) and filtered/tracked per user.

**Acceptance Criteria:**
*   `GET /notifications` returns a list of notifications where the requester is a recipient, correctly filtered by `read=true/false`.
*   `POST /mark-read` transitions the status of the target notifications to `read: true` and returns a success status.
*   `GET /unread-count` returns the total number of notifications for the user where `read=false`.

**Tests to Generate:**
*   **Integration Test (Mark Read):** Test user successfully marking a specific notification and marking all as read.
*   **Integration Test (Unread Count):** Test initial count, verify decrease after marking read.

***

### **Task 47 Code Implementation**

#### **47.1. `src/models/userNotification.model.ts` (Refined Model View)**

*(We will use a simplified approach where the **NotificationModel (Task 11)** is the master record, and a new embedded/separate **UserInboxModel** handles the per-user status to avoid massive denormalization within the main Notification Model.)*

```typescript
// src/models/userNotification.model.ts
import { Schema, model, Types } from 'mongoose';
import { INotification } from './notification.model'; // Import main notification model

// Dedicated model for a user's view of an existing notification
export interface IUserInbox {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  notificationId: Types.ObjectId; // Reference to the main Notification record
  read: boolean;
  readAt?: Date;
  deleted: boolean; // User-level soft delete/archive
  createdAt?: Date; // For sorting
}

const UserInboxSchema = new Schema<IUserInbox>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  notificationId: { type: Schema.Types.ObjectId, ref: 'Notification', required: true },
  read: { type: Boolean, default: false, index: true },
  deleted: { type: Boolean, default: false },
  readAt: { type: Date },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

// PERFORMANCE: Primary index for fast unread counts and sorting
UserInboxSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const UserInboxModel = model<IUserInbox>('UserInbox', UserInboxSchema);
```

#### **47.2. `src/services/notification.service.ts` (Updates)**

```typescript
// src/services/notification.service.ts (partial update)
// ... (Imports from Task 11, including NotificationModel) ...
import { UserInboxModel, IUserInbox } from '../models/userNotification.model';
import { IAuthUser } from '../middlewares/auth.middleware';

export class NotificationService {
    // ... (createTemplate, previewTemplate, deleteTemplate, sendTemplateNotification methods) ...

    /** Lists a user's notifications, joining with the main content model. */
    public async listUserNotifications(requesterId: string, queryParams: any): Promise<any> {
        const { status, page = 1, per_page = 20 } = queryParams;
        const limit = parseInt(per_page);
        const skip = (page - 1) * limit;
        const userId = new Types.ObjectId(requesterId);

        const inboxFilters: any = { userId, deleted: false };
        if (status === 'read') inboxFilters.read = true;
        if (status === 'unread') inboxFilters.read = false;

        // 1. Find the Inbox records (fast query on indexed fields)
        const [totalResults, inboxRecords] = await Promise.all([
            UserInboxModel.countDocuments(inboxFilters),
            UserInboxModel.find(inboxFilters)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate({ path: 'notificationId', select: 'type content projectId' }) // 2. Populate core content
                .lean() as Promise<(IUserInbox & { notificationId: INotification })[]>,
        ]);
        
        // 3. Map to DTO
        const data = inboxRecords.map(record => ({
            id: record._id!.toString(),
            notificationId: record.notificationId._id!.toString(),
            read: record.read,
            type: record.notificationId.type,
            title: record.notificationId.content.in_app?.title,
            body: record.notificationId.content.in_app?.body,
            projectId: record.notificationId.projectId?.toString(),
            createdAt: record.createdAt!.toISOString(),
        }));

        return {
            meta: { page: parseInt(page.toString()), per_page: limit, total: totalResults, total_pages: Math.ceil(totalResults / limit) },
            data,
        };
    }

    /** Marks one or more notifications as read. */
    public async markRead(requesterId: string, ids: string[], markAll: boolean): Promise<void> {
        const userId = new Types.ObjectId(requesterId);
        
        const filters: any = { userId, read: false };

        if (markAll) {
            // If markAll is true, no need for ID filter
        } else if (ids.length > 0) {
            // Mark specific IDs
            filters._id = { $in: ids.map(id => new Types.ObjectId(id)) };
        } else {
            // Nothing to do
            return;
        }

        const result = await UserInboxModel.updateMany(
            filters, 
            { $set: { read: true, readAt: new Date() } }
        );
        
        // PRODUCTION: Emit 'notification.read' event for analytics/real-time updates
        console.log(`[Event] User ${requesterId} marked ${result.modifiedCount} notifications as read.`);
    }

    /** Retrieves the total count of unread notifications. */
    public async getUnreadCount(requesterId: string): Promise<number> {
        const userId = new Types.ObjectId(requesterId);
        
        // PERFORMANCE: Direct, indexed count query
        const count = await UserInboxModel.countDocuments({ 
            userId, 
            read: false, 
            deleted: false 
        });
        
        return count;
    }
}
```

#### **47.3. `src/controllers/notification.controller.ts` (Updates)**

```typescript
// src/controllers/notification.controller.ts (partial update)
// ... (Imports, notificationService initialization, previous controllers) ...
import { query, body, validationResult } from 'express-validator';


// --- Validation Middleware ---

export const listNotificationsValidation = [
    query('status').optional().isIn(['read', 'unread', 'all']).withMessage('Status filter must be read, unread, or all.'),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('per_page').optional().isInt({ min: 1, max: 50 }).toInt(),
];

export const markReadValidation = [
    body('ids').optional().isArray().withMessage('IDs must be an array of notification item IDs.'),
    body('markAll').optional().isBoolean().withMessage('MarkAll must be a boolean.'),
    // Custom check: either IDs or markAll must be set
    body().custom(value => {
        if (!value.ids && !value.markAll) {
            throw new Error('Must provide either "ids" or set "markAll" to true.');
        }
        return true;
    }),
];


// --- User Interaction Controllers ---

/** Lists a user's notifications. GET /notifications */
export const listUserNotificationsController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }

    try {
        const list = await notificationService.listUserNotifications(req.user!.sub, req.query);
        return res.status(200).json(list);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error listing notifications.' } });
    }
};

/** Marks notifications as read. POST /notifications/mark-read */
export const markReadController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { ids, markAll } = req.body;
        await notificationService.markRead(req.user!.sub, ids || [], markAll || false);

        // Success (200 OK)
        return res.status(200).json({ status: 'ok', message: 'Notifications updated.' });
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error marking read.' } });
    }
};

/** Retrieves the unread count. GET /notifications/unread-count */
export const getUnreadCountController = async (req: Request, res: Response) => {
    try {
        const unreadCount = await notificationService.getUnreadCount(req.user!.sub);
        
        return res.status(200).json({ unreadCount });
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving unread count.' } });
    }
};
```

#### **47.4. `src/routes/notification.routes.ts` (Updates)**

```typescript
// src/routes/notification.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 11/46) ...
import { 
    listUserNotificationsController, markReadController, getUnreadCountController,
    listNotificationsValidation, markReadValidation 
} from '../controllers/notification.controller';
import { authenticate } from '../middlewares/auth.middleware'; 

const router = Router();
// ... (Admin/Template/Send Endpoints) ...


// --- User Interaction Endpoints (Task 47) ---

// GET /notifications - List user's notifications
router.get(
    '/',
    authenticate,
    listNotificationsValidation,
    listUserNotificationsController
);

// POST /notifications/mark-read - Mark notifications as read
router.post(
    '/mark-read',
    authenticate,
    markReadValidation,
    markReadController
);

// GET /notifications/unread-count - Get unread count
router.get(
    '/unread-count',
    authenticate,
    getUnreadCountController
);


export default router;
```

#### **47.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T47.1** | `GET /notifications` | Happy Path: List | Auth User | **200 OK** | Returns `read: false` by default (new). |
| **T47.2** | `GET /unread-count` | Happy Path: Count | Auth User | **200 OK** | Returns correct `unreadCount` number. |
| **T47.3** | `POST /mark-read` | Happy Path: Mark Specific | Auth User, Body: `{ ids: ["id1"] }` | **200 OK** | Database updates only `id1` to `read: true`. |
| **T47.4** | `POST /mark-read` | Happy Path: Mark All | Auth User, Body: `{ markAll: true }` | **200 OK** | Database updates all user notifications to `read: true`. |
| **T47.5** | `POST /mark-read` | Fail: Missing Action | Auth User, Body: `{}` | **422 Unprocessable** | `validation_error` (no IDs or `markAll`). |

---
