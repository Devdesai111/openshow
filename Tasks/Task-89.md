Following the structured plan and focusing on completing the internal communication system, we proceed with **Task 89: Notification & Email Templates for System Events**.

This task implements the final set of standardized templates that allow the system to send automated, contextual messages for critical events like financial approvals, disputes, and verification status changes, leveraging the structure from Task 46.

***

## **Task 89: Notification & Email Templates for System Events**

**Goal:** Define and implement the necessary templates (using the structure from Task 46) for critical system events: `milestone.approved`, `project.disputed`, `verification.approved`, and `user.suspended`, ensuring they are ready for service consumption.

**Service:** `Notifications Service`
**Phase:** F - Revenue & Payouts execution, Accounting integration
**Dependencies:** Task 46 (Template CRUD/Preview), Task 11 (Notification Model).

**Output Files:**
1.  `src/jobs/seed/systemTemplates.ts` (New file: Seed data for system templates)
2.  `src/routes/notification.routes.ts` (No API change needed, relies on T46 API)

**Input/Output Shapes:**

| Template ID | Required Variables | Channels | Context |
| :--- | :--- | :--- | :--- |
| **milestone.approved** | `milestoneTitle`, `projectTitle`, `netAmount` | `in_app`, `email` | Triggers Task 30 event. |
| **project.disputed** | `projectTitle`, `disputingUser` | `in_app`, `email` | Triggers Task 30 event. |
| **verification.approved** | `creatorName` | `in_app`, `email` | Triggers Task 24 event. |
| **user.suspended** | `adminName`, `reason` | `email` | Triggers Task 6 event. |

**Runtime & Env Constraints:**
*   This task is focused on **data integrity**; the templates must pass the validation schema from Task 46.
*   The implementation is pure data definition, simulating the Admin team creating these templates via the API.

**Acceptance Criteria:**
*   The system includes valid template data for all four critical events.
*   Each template correctly defines `email` content (`subject`, `html`) and `in_app` content (`title`, `body`).
*   All required variables are correctly mapped in the template content.

**Tests to Generate:**
*   **Unit Test (Template Data):** Test each template object against the Task 46 schema validation to ensure required fields are present and correctly formatted.

***

### **Task 89 Code Implementation**

#### **89.1. `src/jobs/seed/systemTemplates.ts` (New Seed Data File)**

```typescript
// src/jobs/seed/systemTemplates.ts

/**
 * System-critical templates to be seeded into the NotificationTemplateModel (Task 46).
 */
export const SYSTEM_TEMPLATES = [
    {
        templateId: 'milestone.approved',
        name: 'Milestone Approved and Payout Initiated',
        channels: ['in_app', 'email'],
        requiredVariables: ['milestoneTitle', 'projectTitle', 'netAmount'],
        contentTemplate: {
            in_app: {
                title: '💰 Milestone Approved!',
                body: 'Your work on "{{milestoneTitle}}" for "{{projectTitle}}" has been approved. A payout of {{netAmount}} is now being processed.',
            },
            email: {
                subject: 'Payout Initiated: {{netAmount}} for Milestone: {{milestoneTitle}}',
                html: '<p>The Project Owner has approved your milestone, **{{milestoneTitle}}**, for the project <b>{{projectTitle}}</b>. The net payment of <b>{{netAmount}}</b> has been sent to your chosen payout method.</p>',
            },
        },
        version: 1,
        active: true,
    },
    {
        templateId: 'project.disputed',
        name: 'Milestone Disputed and Funds on Hold',
        channels: ['in_app', 'email'],
        requiredVariables: ['projectTitle', 'milestoneTitle', 'disputingUser'],
        contentTemplate: {
            in_app: {
                title: '⚠️ Milestone Disputed!',
                body: 'Milestone "{{milestoneTitle}}" for "{{projectTitle}}" has been disputed by {{disputingUser}}. Funds are now on hold.',
            },
            email: {
                subject: 'Urgent: Dispute Filed on Milestone "{{milestoneTitle}}"',
                html: '<p>A dispute has been filed against **{{milestoneTitle}}** in project **{{projectTitle}}**. The escrowed funds are immediately placed on hold pending resolution.</p>',
            },
        },
        version: 1,
        active: true,
    },
    {
        templateId: 'verification.approved',
        name: 'Verification Approved',
        channels: ['in_app', 'email'],
        requiredVariables: ['creatorName'],
        contentTemplate: {
            in_app: {
                title: '✅ You Are Verified!',
                body: 'Congratulations, {{creatorName}}! Your AI Creator profile is now verified. Your profile now features the verified badge.',
            },
            email: {
                subject: 'Congratulations, Your OpenShow Profile is Verified!',
                html: '<p>Your application was successful. You now have the verified badge and a higher ranking score on the Creator Directory.</p>',
            },
        },
        version: 1,
        active: true,
    },
    {
        templateId: 'user.suspended',
        name: 'Account Suspended by Admin',
        channels: ['email'],
        requiredVariables: ['adminName', 'reason'],
        contentTemplate: {
            email: {
                subject: 'Action Required: Your OpenShow Account Has Been Suspended',
                html: '<p>Your account has been suspended by Admin **{{adminName}}**. Reason: "{{reason}}". Please contact support if you believe this is an error.</p>',
            },
        },
        version: 1,
        active: true,
    },
];
```

#### **89.2. `src/services/notification.service.ts` (Updates - Seeding Utility)**

```typescript
// src/services/notification.service.ts (partial update)
// ... (All previous imports) ...
import { SYSTEM_TEMPLATES } from '../jobs/seed/systemTemplates';

export class NotificationService {
    // ... (All previous methods) ...
    
    /** System method to ensure all critical templates exist (called by a seeding job). */
    public async seedSystemTemplates(): Promise<void> {
        for (const templateData of SYSTEM_TEMPLATES) {
            try {
                // Upsert: Try to create, ignore if ID conflicts, or update version if logic requires
                await NotificationTemplateModel.findOneAndUpdate(
                    { templateId: templateData.templateId },
                    { $setOnInsert: templateData }, // Only set on insert
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
            } catch (e) {
                console.error(`Failed to seed template ${templateData.templateId}:`, e);
            }
        }
    }
}
```

#### **89.3. Test Specification**

| Test ID | Method | Description | Template Name | Required Variables Check |
| :--- | :--- | :--- | :--- | :--- |
| **T89.1** | `seedSystemTemplates` | Creation Check | `milestone.approved` | Verifies `requiredVariables` contains `milestoneTitle`, `projectTitle`, `netAmount`. |
| **T89.2** | `Unit Test` | Render Fidelity | `verification.approved` | Rendering with `{ creatorName: 'Alice' }` produces title "✅ You Are Verified!". |
| **T89.3** | `Unit Test` | Channel Check | `user.suspended` | Verifies `channels` only contains `email`. |

--