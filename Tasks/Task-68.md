The next task in the plan is **Task 68: Payout Recipient Management & KYC Checks**.

We will now proceed with this task, which focuses on the administrative and compliance aspects of setting up a user's financial receiving accounts, ensuring they are verified before any funds are transferred.

***

## **Task 68: Payout Recipient Management & KYC Checks**

**Goal:** Implement Admin-only endpoints to manage a user's payout method status (`PUT /admin/users/:id/payout-status`) and to simulate/force KYC verification, linking the user's account to an external provider ID.

**Service:** `Auth & Identity Service` / `User Settings Service`
**Phase:** F - Revenue & Payouts execution, Accounting integration
**Dependencies:** Task 44 (User Settings Model - for payoutMethod), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/userSettings.service.ts` (Updated: `updatePayoutStatus`, `linkProviderAccount`)
2.  `src/controllers/admin.controller.ts` (Updated: new Admin controllers)
3.  `src/routes/admin.routes.ts` (Updated: new protected routes)
4.  `test/integration/kyc_admin.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **PUT /admin/users/:id/payout-status** | `{ isVerified: boolean, providerAccountId: string, reason: string }` | `{ userId, isVerified, providerAccountId }` | Auth (Admin/Finance) |

**Runtime & Env Constraints:**
*   **Authorization:** Strictly restricted to Admin roles (`FINANCE_MANAGE`).
*   **Audit:** All manual changes to payout status must be recorded in the `AuditService` (Task 60).
*   **Data Integrity:** The update must target the embedded `payoutMethod` subdocument within the user's settings.

**Acceptance Criteria:**
*   The `updatePayoutStatus` service method successfully updates `payoutMethod.isVerified` and records the `providerAccountId`.
*   The update triggers an `audit.created` event with the admin's action and reason.
*   Access attempts by non-Admin users return **403 Forbidden**.

**Tests to Generate:**
*   **Integration Test (Verification):** Test Admin successfully marking a user's payout method as verified and linking a mock provider account ID.
*   **Integration Test (Security):** Test unauthorized access (403).

***

### **Task 68 Code Implementation**

#### **68.1. `src/services/userSettings.service.ts` (Updates)**

```typescript
// src/services/userSettings.service.ts (partial update)
// ... (Imports from Task 44) ...
import { AuditService } from './audit.service'; // Task 60 dependency

const auditService = new AuditService();

interface IPayoutStatusUpdateDTO {
    isVerified: boolean;
    providerAccountId: string;
    reason: string;
}

export class UserSettingsService {
    // ... (All previous settings methods) ...

    /** Admin function to manually update a user's payout status (KYC/Verification override). */
    public async updatePayoutStatus(targetUserId: string, adminId: string, data: IPayoutStatusUpdateDTO): Promise<IUserSettings> {
        const targetObjectId = new Types.ObjectId(targetUserId);

        const update: any = {
            'payoutMethod.isVerified': data.isVerified,
            'payoutMethod.providerAccountId': data.providerAccountId,
        };
        
        // 1. Execute Update (Uses upsert=true to ensure settings exist)
        const updatedSettings = await UserSettingsModel.findOneAndUpdate(
            { userId: targetObjectId },
            { $set: update },
            { new: true, upsert: true }
        ).lean() as IUserSettings;

        if (!updatedSettings) { throw new Error('UpdateFailed'); }

        // 2. Audit Log (CRITICAL)
        await auditService.logAuditEntry({
            resourceType: 'user_payout',
            resourceId: targetUserId,
            action: data.isVerified ? 'payout.kyc_verified' : 'payout.kyc_unverified',
            actorId: adminId,
            details: { isVerified: data.isVerified, providerAccountId: data.providerAccountId, reason: data.reason },
        });

        // 3. Return DTO (Redacted Details)
        const settingsDTO = { ...updatedSettings };
        delete (settingsDTO as any).payoutMethod?.details; 
        
        return settingsDTO;
    }
}
```

#### **68.2. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { UserSettingsService } from '../services/userSettings.service';

const userSettingsService = new UserSettingsService(); // New dependency

// --- Validation Middleware ---

export const updatePayoutStatusValidation = [
    param('userId').isMongoId().withMessage('Invalid User ID format.').bail(),
    body('isVerified').isBoolean().withMessage('isVerified flag is required.'),
    body('providerAccountId').isString().isLength({ min: 5 }).withMessage('Provider Account ID is required.'),
    body('reason').isString().isLength({ min: 10 }).withMessage('Reason for action is required.'),
];


// --- Admin Payout/KYC Controllers ---

/** Admin updates a user's payout status/KYC. PUT /admin/users/:id/payout-status */
export const updatePayoutStatusController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const targetUserId = req.params.userId;
        const adminId = req.user!.sub;

        const updatedSettings = await userSettingsService.updatePayoutStatus(targetUserId, adminId, req.body);

        return res.status(200).json({
            userId: updatedSettings.userId.toString(),
            isVerified: updatedSettings.payoutMethod?.isVerified,
            providerAccountId: updatedSettings.payoutMethod?.providerAccountId,
            message: `Payout status updated to verified=${updatedSettings.payoutMethod?.isVerified}.`,
        });
    } catch (error: any) {
        if (error.message === 'UpdateFailed') { return res.status(404).json({ error: { code: 'user_not_found', message: 'User settings update failed.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating payout status.' } });
    }
};
```

#### **68.3. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 66) ...
import { 
    updatePayoutStatusController, 
    updatePayoutStatusValidation
} from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const financeAccess = [PERMISSIONS.FINANCE_MANAGE]; 


// ... (Admin User Management/Financial/Dispute Endpoints) ...


// --- Admin Payout/KYC Management (Task 68) ---

// PUT /admin/users/:userId/payout-status - Admin manual verification/linking
router.put(
    '/users/:userId/payout-status',
    authenticate,
    authorize(financeAccess),
    updatePayoutStatusValidation,
    updatePayoutStatusController
);


export default router;
```

#### **68.4. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T68.1** | `PUT /users/:id/payout-status` | Happy Path: Verify | Auth Admin, `isVerified: true`, Valid Account ID | **200 OK** | DB `isVerified` is true, Audit Log written. |
| **T68.2** | `PUT /users/:id/payout-status` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied` |
| **T68.3** | `PUT /users/:id/payout-status` | Fail: Invalid Account ID | Auth Admin, `providerAccountId` too short | **422 Unprocessable** | `validation_error` |