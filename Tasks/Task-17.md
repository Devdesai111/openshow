Following the project plan, we proceed with **Task 17: Project Chat Messages (CRUD, Read)**.

This task is the first step in implementing the core collaboration feature, establishing the data model and API endpoints for in-project team communication.

***

## **Task 17: Project Chat Messages (CRUD, Read)**

**Goal:** Implement the `Message` model and the API endpoints for sending, editing, soft-deleting, and listing project messages (`POST /projects/:id/messages`, `GET /projects/:id/messages`, `PUT/DELETE /projects/:id/messages/:mid`).

**Service:** `Collaboration Workspace Service`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 12 (Project Model), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/message.model.ts` (IMessage, MessageSchema/Model)
2.  `src/services/collaboration.service.ts` (New file: `sendMessage`, `getMessages`, `updateMessage`, `deleteMessage`)
3.  `src/controllers/collaboration.controller.ts` (New file: message controllers)
4.  `src/routes/collaboration.routes.ts` (New file: router for Collaboration endpoints)
5.  `test/integration/chat.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Query) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /projects/:id/messages** | `{ body: string, attachments?: string[] }` | `{ messageId, senderId, body, createdAt }` | Auth (Member only) |
| **GET /projects/:id/messages** | `query: { limit?, before? }` | `MessagesListResponse` (Cursor/Paginated) | Auth (Member only) |
| **PUT /projects/:id/messages/:mid** | `{ body: string }` | `MessageDTO` (updated) | Auth (Sender or Admin only) |
| **DELETE /projects/:id/messages/:mid** | N/A | **204 No Content** | Auth (Sender or Admin only) |

**MessagesListResponse (Excerpt):**
```json
{
  "meta": { "limit": 50, "returned": 42 },
  "data": [ { "messageId": "msg_abc", "senderId": "user_1", "body": "Hello team!", "createdAt": "..." } ]
}
```

**Runtime & Env Constraints:**
*   **Security:** Message operations (send, read, edit, delete) must be restricted to **project members**.
*   **Performance:** `GET /messages` must use an efficient index on `projectId` and `createdAt` (cursor pagination).
*   Message `body` must be sanitized if rich text is allowed (non-goal for now, but a consideration).

**Acceptance Criteria:**
*   All endpoints must return **403 Forbidden** if the user is not a member of the target project (checked in service).
*   `POST /messages` must validate `body` length.
*   `PUT /messages` and `DELETE /messages` must check that the requester is the original sender or an Admin (403).
*   `DELETE /messages` must be a **soft delete** (set `deleted=true` in DB).

**Tests to Generate:**
*   **Integration Test (Send/Read):** Test member success, non-member failure (403), and cursor pagination.
*   **Integration Test (Mutate):** Test sender edit success, Admin delete success, and non-sender edit/delete failure (403).

**Non-Goals / Out-of-Scope (for Task 17):**
*   Full thread/reply functionality (only `replyToMessageId` in schema).
*   Real-time delivery using WebSockets/Gateways.
*   Message search functionality.

***

### **Task 17 Code Implementation**

#### **17.1. `src/models/message.model.ts` (New Model)**

```typescript
// src/models/message.model.ts
import { Schema, model, Types } from 'mongoose';

export interface IMessage {
  _id?: Types.ObjectId;
  messageId: string; // Unique, short ID for public reference
  projectId: Types.ObjectId;
  senderId: Types.ObjectId;
  body: string; // Max 5000 chars for chat body
  attachments?: Types.ObjectId[]; // Asset IDs (Task 19)
  replyToMessageId?: Types.ObjectId | null;
  mentionedUserIds?: Types.ObjectId[];
  reactions?: Array<{ emoji: string; userIds: Types.ObjectId[] }>;
  editedAt?: Date | null;
  deleted: boolean; // Soft delete flag
  createdAt?: Date;
}

const MessageSchema = new Schema<IMessage>({
  messageId: { type: String, required: true, unique: true, default: () => `msg_${crypto.randomBytes(8).toString('hex')}` },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  body: { type: String, required: true, maxlength: 5000 },
  attachments: [{ type: Schema.Types.ObjectId, ref: 'Asset' }],
  replyToMessageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
  mentionedUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  reactions: { type: Schema.Types.Mixed, default: [] }, // Simplified for chat reactions
  editedAt: { type: Date, default: null },
  deleted: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } }); // Only track createdAt automatically

// PERFORMANCE: Primary index for chat history retrieval (cursor-based)
MessageSchema.index({ projectId: 1, createdAt: -1 });

export const MessageModel = model<IMessage>('Message', MessageSchema);```

#### **17.2. `src/services/collaboration.service.ts` (New File)**

```typescript
// src/services/collaboration.service.ts
import { MessageModel, IMessage } from '../models/message.model';
import { ProjectModel, IProject } from '../models/project.model';
import { Types } from 'mongoose';
import { IAuthUser } from '../middlewares/auth.middleware'; // For requester role/ID

interface ISendMessageDTO {
    body: string;
    attachments?: string[];
    replyToMessageId?: string;
    mentionedUserIds?: string[];
}

export class CollaborationService {

    /** Checks if the requester is a member of the project. @throws {Error} 'PermissionDenied' */
    private async checkMembership(projectId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<IProject> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) { throw new Error('ProjectNotFound'); }

        const isMember = project.teamMemberIds.some(id => id.toString() === requesterId);
        const isAdmin = requesterRole === 'admin';
        
        if (!isMember && !isAdmin) {
            throw new Error('PermissionDenied');
        }
        return project;
    }

    /** Sends and persists a new message. */
    public async sendMessage(projectId: string, senderId: string, senderRole: IAuthUser['role'], data: ISendMessageDTO): Promise<IMessage> {
        await this.checkMembership(projectId, senderId, senderRole); // Security check

        const newMessage = new MessageModel({
            projectId: new Types.ObjectId(projectId),
            senderId: new Types.ObjectId(senderId),
            body: data.body,
            attachments: data.attachments?.map(id => new Types.ObjectId(id)),
            replyToMessageId: data.replyToMessageId ? new Types.ObjectId(data.replyToMessageId) : undefined,
            // NOTE: MentionedUserIds parsing/mapping logic is omitted but assumed to be here
        });

        const savedMessage = await newMessage.save();
        
        // PRODUCTION: Emit 'chat.message.created' event (Task 11, Activity Feed subscribe)
        console.log(`[Event] Message ${savedMessage.messageId} sent in project ${projectId}.`);

        return savedMessage.toObject() as IMessage;
    }

    /** Retrieves paginated list of messages (cursor-based for infinite scroll). */
    public async getMessages(projectId: string, requesterId: string, requesterRole: IAuthUser['role'], limit: number, before?: string): Promise<any> {
        await this.checkMembership(projectId, requesterId, requesterRole); // Security check
        
        const filters: any = { projectId: new Types.ObjectId(projectId), deleted: false };
        
        // Cursor-based pagination: Find messages *older* than the 'before' cursor
        if (before) {
            // Assume 'before' is a messageId, look up its creation date
            const beforeMessage = await MessageModel.findOne({ messageId: before }).select('createdAt');
            if (beforeMessage) {
                filters.createdAt = { $lt: beforeMessage.createdAt };
            }
        }

        const messages = await MessageModel.find(filters)
            .sort({ createdAt: -1 }) // Newest first (descending)
            .limit(limit)
            .select('-__v')
            .lean() as IMessage[];

        // Map to DTO (convert IDs to strings)
        const data = messages.map(msg => ({
            ...msg,
            _id: msg._id!.toString(),
            senderId: msg.senderId.toString(),
            messageId: msg.messageId,
            createdAt: msg.createdAt!.toISOString(),
            // attachments, replyToMessageId conversions omitted for brevity
        }));

        return { data, meta: { limit, returned: data.length, before } };
    }
    
    /** Updates a message body/attachments. */
    public async updateMessage(projectId: string, messageId: string, requesterId: string, requesterRole: IAuthUser['role'], body: string): Promise<IMessage> {
        const message = await MessageModel.findOne({ messageId, projectId: new Types.ObjectId(projectId) });
        if (!message) { throw new Error('MessageNotFound'); }

        // Security: Check if sender or Admin
        if (message.senderId.toString() !== requesterId && requesterRole !== 'admin') {
            throw new Error('PermissionDenied');
        }
        
        message.body = body;
        message.editedAt = new Date();
        await message.save();

        // PRODUCTION: Emit 'chat.message.updated' event
        console.log(`[Event] Message ${messageId} updated.`);
        
        return message.toObject() as IMessage;
    }

    /** Soft-deletes a message. */
    public async deleteMessage(projectId: string, messageId: string, requesterId: string, requesterRole: IAuthUser['role']): Promise<void> {
        const message = await MessageModel.findOne({ messageId, projectId: new Types.ObjectId(projectId) });
        if (!message) { throw new Error('MessageNotFound'); }
        
        // Security: Check if sender or Admin
        if (message.senderId.toString() !== requesterId && requesterRole !== 'admin') {
            throw new Error('PermissionDenied');
        }
        
        // Soft delete operation
        const result = await MessageModel.updateOne(
            { _id: message._id },
            { $set: { deleted: true, body: '[Message Deleted]' } } // Replace body for immediate view update
        );

        if (result.modifiedCount === 0) { throw new Error('DeleteFailed'); }

        // PRODUCTION: Emit 'chat.message.deleted' event
        console.log(`[Event] Message ${messageId} soft-deleted.`);
    }
}
```

#### **17.3. `src/controllers/collaboration.controller.ts` (New File)**

```typescript
// src/controllers/collaboration.controller.ts
import { Request, Response } from 'express';
import { param, body, query, validationResult } from 'express-validator';
import { CollaborationService } from '../services/collaboration.service';

const collaborationService = new CollaborationService();

// --- Validation Middleware ---
export const messageBodyValidation = [
    body('body').isString().isLength({ min: 1, max: 5000 }).withMessage('Message body is required (1-5000 chars).'),
    body('attachments').optional().isArray().withMessage('Attachments must be an array of asset IDs.'),
    // ... other validations
];

export const messageIdParamValidation = [
    param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
    param('messageId').isString().withMessage('Invalid Message ID format.').bail(),
];

export const getMessagesValidation = [
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Limit must be between 1 and 100.'),
    query('before').optional().isString().withMessage('Before must be a valid message ID cursor.'),
];


// --- Message Controllers ---

/** Sends a new message. POST /projects/:id/messages */
export const sendMessageController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { projectId } = req.params;
        const senderId = req.user!.sub;

        const savedMessage = await collaborationService.sendMessage(projectId, senderId, req.user!.role, req.body);

        return res.status(201).json({
            messageId: savedMessage.messageId,
            senderId: savedMessage.senderId.toString(),
            body: savedMessage.body,
            createdAt: savedMessage.createdAt!.toISOString(),
        });
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_member', message: 'You must be a project member to send messages.' } }); }
        if (error.message === 'ProjectNotFound') { return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error sending message.' } });
    }
};

/** Retrieves paginated messages. GET /projects/:id/messages */
export const getMessagesController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { projectId } = req.params;
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
        const before = req.query.before as string | undefined;

        const result = await collaborationService.getMessages(projectId, req.user!.sub, req.user!.role, limit, before);

        return res.status(200).json(result);
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_member', message: 'You must be a project member to view messages.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error retrieving messages.' } });
    }
};

/** Updates a message. PUT /projects/:id/messages/:mid */
export const updateMessageController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { projectId, messageId } = req.params;
        const updatedMessage = await collaborationService.updateMessage(projectId, messageId, req.user!.sub, req.user!.role, req.body.body);

        return res.status(200).json({
            messageId: updatedMessage.messageId,
            body: updatedMessage.body,
            editedAt: updatedMessage.editedAt!.toISOString(),
        });
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_sender', message: 'You can only edit your own messages.' } }); }
        if (error.message === 'MessageNotFound') { return res.status(404).json({ error: { code: 'message_not_found', message: 'Message not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating message.' } });
    }
};

/** Soft-deletes a message. DELETE /projects/:id/messages/:mid */
export const deleteMessageController = async (req: Request, res: Response) => {
    try {
        const { projectId, messageId } = req.params;
        await collaborationService.deleteMessage(projectId, messageId, req.user!.sub, req.user!.role);

        return res.status(204).send();
    } catch (error: any) {
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_sender', message: 'You can only delete your own messages.' } }); }
        if (error.message === 'MessageNotFound') { return res.status(404).json({ error: { code: 'message_not_found', message: 'Message not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error deleting message.' } });
    }
};
```

#### **17.4. `src/routes/collaboration.routes.ts` (New File)**

```typescript
// src/routes/collaboration.routes.ts
import { Router } from 'express';
import { 
    sendMessageController, getMessagesController, updateMessageController, deleteMessageController,
    messageBodyValidation, messageIdParamValidation, getMessagesValidation
} from '../controllers/collaboration.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { param } from 'express-validator';

const router = Router();

// Define validation for projectId in the path
const projectIdValidation = [
    param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
];


// POST /projects/:projectId/messages - Send message (Task 17)
router.post(
    '/:projectId/messages',
    authenticate,
    projectIdValidation,
    messageBodyValidation,
    sendMessageController
);

// GET /projects/:projectId/messages - Fetch messages (Task 17)
router.get(
    '/:projectId/messages',
    authenticate,
    projectIdValidation,
    getMessagesValidation,
    getMessagesController
);

// PUT /projects/:projectId/messages/:messageId - Edit message (Task 17)
router.put(
    '/:projectId/messages/:messageId',
    authenticate,
    messageIdParamValidation,
    messageBodyValidation,
    updateMessageController
);

// DELETE /projects/:projectId/messages/:messageId - Delete message (Task 17)
router.delete(
    '/:projectId/messages/:messageId',
    authenticate,
    messageIdParamValidation,
    deleteMessageController
);

// NOTE: Future Activity/Reaction/Other endpoints will be added here.

export default router;
```

#### **17.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T17.1** | `POST /:id/messages` | Happy Path: Send Message | Authenticated Member | **201 Created** | N/A |
| **T17.2** | `POST /:id/messages` | Fail: Non-Member | Authenticated Non-Member | **403 Forbidden** | `not_member` |
| **T17.3** | `GET /:id/messages` | Happy Path: Cursor Retrieval | Authenticated Member | **200 OK** | Returns messages descending by `createdAt`. |
| **T17.4** | `PUT /:id/messages/:mid` | Happy Path: Sender Edit | Authenticated Sender | **200 OK** | `editedAt` populated. |
| **T17.5** | `PUT /:id/messages/:mid` | Fail: Non-Sender Edit | Authenticated Non-Sender | **403 Forbidden** | `not_sender` |
| **T17.6** | `DELETE /:id/messages/:mid` | Happy Path: Soft Delete | Authenticated Sender | **204 No Content** | N/A |

---

