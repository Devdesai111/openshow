Following the structured plan and moving into monetization and accounting infrastructure, we proceed with **Task 93: Billing Metrics & Usage Metering Export**.

This task establishes the foundational mechanism for tracking usage of billable features (e.g., storage, jobs, transactions) and generating a standardized usage report for an external billing system.

***

## **Task 93: Billing Metrics & Usage Metering Export**

**Goal:** Define a service utility to increment usage counters for billable events (e.g., storage use, job execution) and implement an Admin endpoint (`GET /admin/billing/usage`) to generate a per-tenant/per-user usage report.

**Service:** `Utility & System Features` (Billing)
**Phase:** F - Revenue & Payouts execution, Accounting integration
**Dependencies:** Task 75 (Metrics/Gauge), Task 2 (RBAC Middleware), Task 60 (AuditLog - for source data).

**Output Files:**
1.  `src/utils/billing.utility.ts` (New file: Metering interface and logic)
2.  `src/services/admin.service.ts` (Updated: `getUsageReport`)
3.  `src/controllers/admin.controller.ts` (Updated: `getUsageReportController`)
4.  `src/routes/admin.routes.ts` (Updated: new protected route)
5.  `test/unit/billing_metering.test.ts` (Test specification)

**Input/Output Shapes:**

| Utility Action | Input | Side Effect | Key Metric Tracked |
| :--- | :--- | :--- | :--- |
| **meterUsage** | `{ tenantId, feature: string, quantity: number }` | Increments counter in simulated DB/cache. | Storage (GB-months), Jobs (count), Transactions (count). |
| **GET /admin/billing/usage** | `query: { tenantId?, from?, to? }` | Queries UsageLog (simulated). | `totalGbStored`, `totalJobsExecuted`, `totalTransactions`. |

**Runtime & Env Constraints:**
*   **Performance (CRITICAL):** Metering updates must be highly performant (fast writes/increments) and should not block the primary application flow. We will use a fast counter store (mocked).
*   **Security:** Report generation is strictly restricted to Admin roles (`FINANCE_MANAGE`).
*   **Accuracy:** Usage must be tracked per feature and accurately summed for the report.

**Acceptance Criteria:**
*   The `meterUsage` utility successfully increments a counter for a billable event.
*   The `getUsageReport` endpoint successfully aggregates the totals for the requested period.
*   The report accurately reflects the total sum of metered usage for the period.

**Tests to Generate:**
*   **Unit Test (Metering):** Test multiple calls to `meterUsage` for the same user/feature and verify the incremented total.
*   **Integration Test (Report):** Test Admin fetching a report and verifying that the final DTO sums are correct.

***

### **Task 93 Code Implementation**

#### **93.1. `src/utils/billing.utility.ts` (New Utility File)**

```typescript
// src/utils/billing.utility.ts
import { logger } from './logger.utility';

// Mock Fast Counter Store (Simulated Redis Hashes or Time-Series DB)
const usageCounters = new Map<string, number>();

/** Generates a deterministic key for metering. */
const generateMeteringKey = (tenantId: string, feature: string, period: 'monthly' = 'monthly'): string => {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
    return `${tenantId}:${feature}:${yearMonth}`;
};

/**
 * Utility to track usage of billable features.
 * Non-blocking operation.
 */
export class BillingUtility {
    
    // Defines the features that are actively metered
    public static readonly FEATURES = {
        STORAGE_GB_MONTH: 'storage_gb_month',
        JOB_EXECUTION_UNIT: 'job_execution_unit',
        PREMIUM_API_CALL: 'premium_api_call',
    };

    /**
     * Increments a counter for a specific metered feature.
     * @param tenantId - The user's tenant ID.
     * @param feature - The feature key (e.g., 'storage_gb_month').
     * @param quantity - The amount to increment (e.g., 1.5 for 1.5 GB).
     */
    public static async meterUsage(tenantId: string, feature: string, quantity: number): Promise<void> {
        const key = generateMeteringKey(tenantId, feature);
        
        // This simulates an HINCRBYFLOAT or ZADD operation in a non-blocking way
        let current = usageCounters.get(key) || 0;
        current += quantity;
        usageCounters.set(key, current);
        
        // PRODUCTION: This logs the granular event, often stored in a time-series DB for audit.
        logger.info('Usage Metered', { tenantId, feature, quantity, total: current });
    }
    
    /**
     * Aggregates and returns all usage for a period (Admin/Reporting use).
     * @returns A map of { feature: { tenantId: totalQuantity } }.
     */
    public static async getUsageReportData(tenantId?: string): Promise<Record<string, Record<string, number>>> {
        const report: Record<string, Record<string, number>> = {};

        for (const [key, quantity] of usageCounters.entries()) {
            const [keyTenantId, feature] = key.split(':');
            
            if (tenantId && keyTenantId !== tenantId) continue;

            if (!report[feature]) {
                report[feature] = {};
            }
            report[feature][keyTenantId] = quantity;
        }
        
        return report;
    }
    
    // Helper for testing
    public static resetCounters() {
         usageCounters.clear();
    }
}
```

#### **93.2. `src/services/admin.service.ts` (Updates)**

```typescript
// src/services/admin.service.ts (partial update)
// ... (Imports, AdminService class definition) ...
import { BillingUtility } from '../utils/billing.utility';
import { IAuthUser } from '../middlewares/auth.middleware';


export class AdminService {
    // ... (All previous methods) ...

    /** Generates a detailed usage report for external billing/accounting systems. */
    public async getUsageReport(filters: any, requesterRole: IAuthUser['role']): Promise<any> {
        const { tenantId } = filters;
        
        // 1. Fetch Aggregated Usage Data (Mock)
        const rawReport = await BillingUtility.getUsageReportData(tenantId);

        // 2. Format into Billing Report DTO
        const reportDTO = {
            generationDate: new Date().toISOString(),
            tenantIdFilter: tenantId || 'ALL',
            metrics: [] as any[],
        };

        for (const feature in rawReport) {
            for (const tId in rawReport[feature]) {
                reportDTO.metrics.push({
                    tenantId: tId,
                    feature,
                    quantity: rawReport[feature][tId],
                    unit: feature.includes('gb_month') ? 'GB-Month' : 'Count',
                });
            }
        }
        
        // 3. Audit Log (CRITICAL)
        await auditService.logAuditEntry({
            resourceType: 'billing',
            action: 'billing.report.generated',
            actorId: requesterRole === 'admin' ? requesterRole : undefined,
            details: { filters, recordCount: reportDTO.metrics.length },
        });

        return reportDTO;
    }
}
```

#### **93.3. `src/controllers/admin.controller.ts` (Updates)**

```typescript
// src/controllers/admin.controller.ts (partial update)
// ... (Imports, services initialization, previous controllers) ...
import { query, validationResult } from 'express-validator';
import { IAuthUser } from '../middlewares/auth.middleware';

// --- Validation Middleware ---

export const usageReportValidation = [
    query('tenantId').optional().isString().withMessage('Tenant ID must be a string.'),
    query('from').optional().isISO8601(), // Time-based filtering (logic deferred/simplified)
];


// --- Admin Billing Controllers ---

/** Generates a metered usage report. GET /admin/billing/usage */
export const getUsageReportController = async (req: Request, res: Response) => {
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Query validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const report = await adminService.getUsageReport(req.query, req.user!.role as IAuthUser['role']);
        return res.status(200).json(report);
    } catch (error: any) {
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error generating usage report.' } });
    }
};
```

#### **93.4. `src/routes/admin.routes.ts` (Updates)**

```typescript
// src/routes/admin.routes.ts (partial update)
import { Router } from 'express';
// ... (Imports from Task 72) ...
import { getUsageReportController, usageReportValidation } from '../controllers/admin.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();
const financeAccess = [PERMISSIONS.FINANCE_MANAGE]; 


// ... (Admin Audit/Financial/Dispute Endpoints) ...


// --- Admin Billing/Usage Endpoints (Task 93) ---

// GET /admin/billing/usage - Generate metered usage report
router.get(
    '/billing/usage',
    authenticate,
    authorize(financeAccess), // RBAC check
    usageReportValidation,
    getUsageReportController
);


export default router;
```

#### **93.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T93.1** | `Unit Test` | Metering Check | Call `meterUsage('T1', 'job_execution_unit', 5)` | Internal counter for T1/jobs is 5. |
| **T93.2** | `GET /billing/usage` | Happy Path: Report Generation | Auth Admin, Data present in mock store. | **200 OK** | Returns `metrics` array with calculated quantities. |
| **T93.3** | `GET /billing/usage` | Fail: Unauthorized | Auth Creator | **403 Forbidden** | `permission_denied`. |