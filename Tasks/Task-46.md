Following the structured plan and focusing on the completion of the `Notifications Service` (Phase G component), we proceed with **Task 46: Notifications Templating Engine**.

This task establishes the models and logic required for the administrative management of notification templates, which is a key dependency for all automated messaging.

***

## **Task 46: Notifications Templating Engine**

**Goal:** Implement the Admin-only CRUD for `NotificationTemplate`s (create, read, update, delete) and the API endpoint to preview a rendered template (`POST /notifications/templates/preview`) using a set of test variables.

**Service:** `Notifications Service`
**Phase:** G - Notifications, Webhooks...
**Dependencies:** Task 11 (Notification Model, Service Structure), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/notification.service.ts` (Updated: `createTemplate`, `updateTemplate`, `deleteTemplate`, `previewTemplate`)
2.  `src/controllers/notification.controller.ts` (Updated: template CRUD/preview controllers)
3.  `src/routes/notification.routes.ts` (Updated: new protected routes for template management)
4.  `test/integration/template_manage.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /notifications/templates** | `{ templateId, channels: [], contentTemplate: {}, requiredVariables: [] }` | `{ templateId, version: 1 }` | Auth (Admin/System Only) |
| **POST /notifications/templates/preview** | `{ templateId, variables: {} }` | `{ email: { subject, html }, in_app: { title, body } }` | Auth (Admin/System Only) |

**Template Preview Response (Excerpt):**
```json
{
  "email": { "subject": "Welcome, John Doe!", "html": "<h1>Welcome</h1>..." },
  "in_app": { "title": "New User", "body": "Thank you for signing up." }
}
```

**Runtime & Env Constraints:**
*   **Security:** Template management endpoints are highly sensitive (control all user communication) and must be restricted to Admin/System roles (`ADMIN_DASHBOARD`).
*   **Immutability:** Template updates should ideally version the template, which is handled by a simple `version` field incrementation in the service logic.
*   **Templating:** The `preview` endpoint must use the same underlying rendering logic as the send service (Task 11) to ensure fidelity.

**Acceptance Criteria:**
*   Template CRUD endpoints enforce Admin-only access (403 Forbidden).
*   `POST /templates` must validate that the `templateId` is unique (409 Conflict).
*   `POST /templates/preview` returns the rendered content and validates that all `requiredVariables` are supplied.
*   `DELETE /templates/:id` successfully marks the template as inactive/deleted and returns **204 No Content**.

**Tests to Generate:**
*   **Integration Test (CRUD/Security):** Test creation/deletion by Admin and failure on unauthorized access.
*   **Integration Test (Preview):** Test happy path rendering and failure on missing required variables (422).

***

### **Task 46 Code Implementation**

#### **46.1. `src/services/notification.service.ts` (Updates)**

```typescript
// src/services/notification.service.ts (partial update)
// ... (Imports from Task 11, NotificationTemplateModel, etc.) ...
import { IChannelParts, INotificationTemplate } from '../models/notificationTemplate.model';
import { Types } from 'mongoose';


// --- Admin Template Management ---

/** Creates a new notification template (Admin/System use). */
public async createTemplate(data: any): Promise<INotificationTemplate> {
    const existing = await NotificationTemplateModel.findOne({ templateId: data.templateId });
    if (existing) { throw new Error('TemplateIDConflict'); }

    // PRODUCTION: Full template object validation would occur here
    const newTemplate = new NotificationTemplateModel({
        ...data,
        version: 1,
        active: true,
    });
    
    const savedTemplate = await newTemplate.save();
    return savedTemplate.toObject() as INotificationTemplate;
}

/** Updates an existing template, incrementing the version. (Soft deletion of old content) */
public async updateTemplate(templateId: string, data: any): Promise<INotificationTemplate> {
    const template = await NotificationTemplateModel.findOne({ templateId });
    if (!template) { throw new Error('TemplateNotFound'); }

    // Increment version on update
    const newVersion = template.version + 1;
    
    const updatedTemplate = await NotificationTemplateModel.findOneAndUpdate(
        { templateId },
        { 
            $set: { ...data, version: newVersion, updatedAt: new Date() }
        },
        { new: true }
    );
    
    if (!updatedTemplate) { throw new Error('TemplateNotFound'); }
    
    return updatedTemplate.toObject() as INotificationTemplate;
}

/** Deletes/Deactivates a template. */
public async deleteTemplate(templateId: string): Promise<void> {
    const result = await NotificationTemplateModel.updateOne({ templateId }, { $set: { active: false, updatedAt: new Date() } });
    if (result.matchedCount === 0) { throw new Error('TemplateNotFound'); }
}


/** Previews a rendered template with mock variables. */
public async previewTemplate(templateId: string, variables: Record<string, string>): Promise<any> {
    const template = await NotificationTemplateModel.findOne({ templateId, active: true }).lean() as INotificationTemplate;
    if (!template) { throw new Error('TemplateNotFound'); }

    const renderedContent: any = {};
    
    // 1. Check for Missing Variables
    template.requiredVariables.forEach(key => {
        if (!variables.hasOwnProperty(key)) { throw new Error(`VariableMissing: ${key}`); }
    });

    // 2. Render content for each channel (using the renderContent utility from Task 11 logic)
    for (const channel of template.channels) {
        const contentTemplate = template.contentTemplate[channel];
        if (contentTemplate) {
            // Reusing the render logic from Task 11 (mocked Handlebars utility)
            const templateSource = JSON.stringify(contentTemplate);
            const compiledTemplate = handlebars.compile(templateSource);
            let renderedJson = compiledTemplate(variables);
            
            // Re-parse the rendered string back into an object
            try {
                renderedContent[channel] = JSON.parse(renderedJson);
            } catch (e) {
                // If rendering fails to produce valid JSON (e.g., if contentTemplate wasn't a valid JSON structure)
                renderedContent[channel] = renderedJson;
            }
        }
    }
    
    return renderedContent;
}
```

#### **46.2. `src/controllers/notification.controller.ts` (Updates)**

```typescript
// src/controllers/notification.controller.ts (partial update)
// ... (Imports, notificationService initialization, Task 11 controllers) ...
import { body, param, validationResult } from 'express-validator';
import { TemplateSchema } from '../models/notificationTemplate.model'; // Assuming schema exists

// --- Validation Middleware ---

export const templateBaseValidation = [
    body('templateId').isString().isLength({ min: 3 }).withMessage('Template ID is required.').bail(),
    body('channels').isArray({ min: 1 }).withMessage('At least one channel is required.'),
    body('contentTemplate').isObject().withMessage('Content template is required.'),
    body('requiredVariables').isArray().withMessage('Required variables must be an array.'),
];

export const templateIdParamValidation = [
    param('templateId').isString().withMessage('Template ID is required.'),
];


// --- Admin Template Controllers ---

/** Creates a new template. POST /notifications/templates */
export const createTemplateController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const savedTemplate = await notificationService.createTemplate(req.body);

        return res.status(201).json({
            templateId: savedTemplate.templateId,
            version: savedTemplate.version,
            createdAt: savedTemplate.createdAt!.toISOString(),
        });
    } catch (error: any) {
        if (error.message === 'TemplateIDConflict') { return res.status(409).json({ error: { code: 'id_conflict', message: 'Template ID already exists.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error creating template.' } });
    }
};

/** Previews a rendered template. POST /notifications/templates/preview */
export const previewTemplateController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { templateId, variables } = req.body;
        const renderedContent = await notificationService.previewTemplate(templateId, variables);

        return res.status(200).json(renderedContent);
    } catch (error: any) {
        if (error.message === 'TemplateNotFound') { return res.status(404).json({ error: { code: 'template_not_found', message: 'Template not found or is inactive.' } }); }
        if (error.message.startsWith('VariableMissing')) { return res.status(422).json({ error: { code: 'template_error', message: `Template rendering failed: ${error.message}` } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error rendering preview.' } });
    }
};

/** Deletes/Deactivates a template. DELETE /notifications/templates/:id */
export const deleteTemplateController = async (req: Request, res: Response) => {
    try {
        await notificationService.deleteTemplate(req.params.templateId);

        return res.status(204).send();
    } catch (error: any) {
        if (error.message === 'TemplateNotFound') { return res.status(404).json({ error: { code: 'template_not_found', message: 'Template not found.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error deleting template.' } });
    }
};
```

#### **46.3. `src/routes/notification.routes.ts` (Updates)**

```typescript
// src/routes/notification.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 11) ...
import { 
    createTemplateController, previewTemplateController, deleteTemplateController,
    templateBaseValidation, templateIdParamValidation,
} from '../controllers/notification.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const adminAccess = [PERMISSIONS.ADMIN_DASHBOARD]; // Admin/System access for template management


// ... (POST /notifications/send from Task 11) ...

// --- Admin Template Management Endpoints (Task 46) ---

// POST /notifications/templates - Create new template
router.post(
    '/templates',
    authenticate,
    authorize(adminAccess),
    templateBaseValidation,
    createTemplateController
);

// POST /notifications/templates/preview - Preview template
router.post(
    '/templates/preview',
    authenticate,
    authorize(adminAccess),
    previewTemplateController
);

// DELETE /notifications/templates/:templateId - Delete/Deactivate template
router.delete(
    '/templates/:templateId',
    authenticate,
    authorize(adminAccess),
    templateIdParamValidation,
    deleteTemplateController
);

export default router;
```

#### **46.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T46.1** | `POST /templates` | Happy Path: Creation | Auth Admin, Valid Template | **201 Created** | N/A |
| **T46.2** | `POST /templates/preview` | Happy Path: Render Preview | Auth Admin, Valid Template/Variables | **200 OK** | Returns fully rendered email/in-app content. |
| **T46.3** | `POST /templates/preview` | Fail: Missing Variable | Auth Admin, Missing required variable | **422 Unprocessable** | `template_error` (VariableMissing) |
| **T46.4** | `DELETE /templates/:id` | Fail: Unauthorized Delete | Auth Creator/Owner | **403 Forbidden** | `permission_denied` |

---
