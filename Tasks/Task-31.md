
***

## **Task 31: Revenue Calculation Engine & Preview**

**Goal:** Implement the core, deterministic revenue split calculation engine (`calculateRevenueSplit`) that consumes a gross amount and a project's revenue model, applying platform fees and outputting a net payment breakdown *without* performing any database mutations (read-only function for previews).

**Service:** `Revenue Calculation & Payouts Service`
**Phase:** E - Payments, Escrow & Ledger
**Dependencies:** Task 12 (Project Model - for revenue split definition).

**Output Files:**
1.  `src/utils/revenueCalculator.ts` (New file: Core calculation logic/utility)
2.  `src/services/revenue.service.ts` (New file: `calculateRevenueSplit`)
3.  `src/controllers/revenue.controller.ts` (New file: `calculatePreviewController`)
4.  `src/routes/revenue.routes.ts` (New file: router for `/revenue`)
5.  `test/unit/revenue_calculator.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /revenue/calculate** | `{ projectId?, amount: number, currency: string, revenueModel?: {} }` | `RevenueBreakdownDTO` (Detailed breakdown) | Auth (Internal/Owner) |

**RevenueBreakdownDTO (Excerpt):**
```json
{
  "grossAmount": 200000,
  "platformFee": 10000,
  "totalDistributed": 190000,
  "breakdown": [
    { "recipientUserId": "user_a", "grossShare": 100000, "netAmount": 95000 },
    // ...
  ]
}
```

**Runtime & Env Constraints:**
*   **Determinism:** The calculation logic **must** be deterministic, including rounding rules (using the Largest Remainder Method or similar for split cents).
*   **Fees:** Platform fees (e.g., 5% of gross) must be applied as part of the calculation.
*   **Access:** This is exposed to the project owner for preview purposes, but also to internal services (Payments/Payouts) for execution.

**Acceptance Criteria:**
*   Unit tests for the rounding logic must pass (e.g., dividing 100 cents by 3 people).
*   The API returns a calculated breakdown reflecting the gross amount minus the platform fee, distributing the net amount based on the project's split percentages.
*   Validation must enforce the `amount` is $\geq 0$ and percentages sum to $100$ (if a percentage model is used).

**Tests to Generate:**
*   **Unit Test (Rounding):** Test 50/50 split on an odd number (e.g., 101 cents).
*   **Unit Test (Fees):** Test correct deduction of a flat percentage platform fee.
*   **Integration Test (Preview):** Test happy path API call and verify `netAmount` conservation: `Gross - Fees = Sum(Net Amounts)`.

***

### **Task 31 Code Implementation**

#### **31.1. `src/utils/revenueCalculator.ts` (New Utility File)**

```typescript
// src/utils/revenueCalculator.ts
import { IRevenueSplit } from '../models/project.model';
import { Types } from 'mongoose';

// DTOs for calculation inputs/outputs
interface ICalculationInput {
    amount: number; // In smallest unit (cents/paise)
    splits: IRevenueSplit[];
}
interface IRecipientShare {
    recipientId?: string;
    placeholder?: string;
    grossShare: number;
    platformFeeShare: number;
    netAmount: number;
}
interface ICalculationOutput {
    grossAmount: number;
    platformFee: number;
    taxWithheld: number;
    totalDistributed: number;
    breakdown: IRecipientShare[];
}

// Global Fee/Tax Constants (Configurable in a real service)
const PLATFORM_FEE_PERCENT = 5; // 5.0%
const TAX_WITHHOLDING_PERCENT = 0; // 0% for Phase 1 simplicity (Task 32 can add this)

/**
 * Distributes residual cents deterministically (Largest Remainder Method, Hamilton Method).
 * @param cents - The total number of residual cents to distribute.
 * @param shares - Array of recipient shares (must be non-integer parts).
 */
function distributeResidualCents(cents: number, shares: { recipient: string, fractional: number }[]): Map<string, number> {
    const distribution = new Map<string, number>();
    if (cents <= 0) return distribution;

    // Sort by fractional part descending
    shares.sort((a, b) => b.fractional - a.fractional);

    // Distribute 1 cent to the top 'cents' recipients
    for (let i = 0; i < cents && i < shares.length; i++) {
        distribution.set(shares[i].recipient, 1);
    }
    return distribution;
}


export function calculateRevenueSplit({ amount, splits }: ICalculationInput): ICalculationOutput {
    // 1. Calculate Platform Fee (deducted from gross)
    const platformFee = Math.round(amount * (PLATFORM_FEE_PERCENT / 100)); // Round to nearest cent
    const netAmountAfterFee = amount - platformFee;
    const taxWithheld = 0; // For Phase 1, no tax withholding

    // 2. Prepare Split Calculation
    const percentageSplits = splits.filter(s => s.percentage !== undefined);
    if (percentageSplits.length === 0) {
        throw new Error('PercentageModelRequired');
    }
    
    // Validate sum=100 (Critical check)
    const totalPercentage = percentageSplits.reduce((sum, s) => sum + (s.percentage || 0), 0);
    if (totalPercentage !== 100) {
         throw new Error('RevenueSplitInvalid:SumNot100'); // Mongoose hook should catch this on save
    }

    // 3. Determine Gross Shares (Before applying fee/tax on a per-recipient basis)
    const rawShares = percentageSplits.map(split => {
        const exactShare = netAmountAfterFee * (split.percentage! / 100);
        return {
            recipientId: split.userId?.toString() || split._id!.toString(), // Use userId or split ID as recipient key
            placeholder: split.placeholder,
            percentage: split.percentage!,
            exactShare: exactShare,
            floorShare: Math.floor(exactShare), // Integer part
            fractional: exactShare - Math.floor(exactShare), // Fractional part
        };
    });

    // 4. Distribute Residual Cents (Ensures sum(netAmount) == netAmountAfterFee)
    const floorSum = rawShares.reduce((sum, s) => sum + s.floorShare, 0);
    const residualCents = netAmountAfterFee - floorSum;

    const residualDistribution = distributeResidualCents(residualCents, rawShares.map(s => ({ 
        recipient: s.recipientId, 
        fractional: s.fractional 
    })));

    // 5. Final Breakdown Construction
    const breakdown: IRecipientShare[] = rawShares.map(share => {
        const centsAdjustment = residualDistribution.get(share.recipientId) || 0;
        const finalNet = share.floorShare + centsAdjustment;
        
        return {
            recipientId: share.recipientId,
            placeholder: share.placeholder,
            grossShare: finalNet, // For simplicity, net is set as grossShare in this model
            platformFeeShare: Math.round(platformFee * (share.percentage / 100)), // Split fee proportionally
            netAmount: finalNet,
        };
    });
    
    // Final check for conservation of currency (sum of final net should equal net after fees)
    const finalNetSum = breakdown.reduce((sum, s) => sum + s.netAmount, 0);
    if (finalNetSum !== netAmountAfterFee) {
        // This indicates a bug in the rounding logic or an unexpected float error
        console.error('CRITICAL ERROR: Currency conservation failed.', { finalNetSum, netAmountAfterFee });
    }

    return {
        grossAmount: amount,
        platformFee,
        taxWithheld,
        totalDistributed: finalNetSum,
        breakdown,
    };
}
```

#### **31.2. `src/services/revenue.service.ts` (New File)**

```typescript
// src/services/revenue.service.ts
import { ProjectModel, IProject } from '../models/project.model';
import { calculateRevenueSplit } from '../utils/revenueCalculator';
import { Types } from 'mongoose';

export class RevenueService {
    
    /**
     * Calculates the revenue split breakdown for a given amount, using Project data or provided splits.
     * @param data - Contains amount, currency, and optional projectId/revenueModel override.
     */
    public async calculateRevenueSplit(data: any): Promise<any> {
        const { projectId, amount, currency, revenueModel } = data;
        
        let splits: any[] = revenueModel?.splits;

        // 1. Fetch splits from Project if not provided
        if (projectId && !splits) {
            const project = await ProjectModel.findById(new Types.ObjectId(projectId)).select('revenueSplits').lean() as IProject;
            if (!project) { throw new Error('ProjectNotFound'); }
            splits = project.revenueSplits;
        }

        if (!splits || splits.length === 0) {
            throw new Error('RevenueModelNotFound');
        }

        // 2. Execute Deterministic Calculation
        const result = calculateRevenueSplit({ amount, splits });
        
        return { ...result, currency };
    }
}
```

#### **31.3. `src/controllers/revenue.controller.ts` (New File)**

```typescript
// src/controllers/revenue.controller.ts
import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { RevenueService } from '../services/revenue.service';

const revenueService = new RevenueService();

// --- Validation Middleware ---

export const calculateRevenueValidation = [
    body('amount').isInt({ min: 1 }).toInt().withMessage('Amount must be a positive integer (cents).').bail(),
    body('currency').isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be a 3-letter ISO code.'),
    body('projectId').optional().isMongoId().withMessage('Project ID must be valid Mongo ID.'),
    body('revenueModel.splits').optional().isArray().withMessage('Splits must be an array.'),
    // NOTE: Complex split validation is primarily handled in the service/calculator utility
];


/** Calculates the revenue split preview. POST /revenue/calculate */
export const calculatePreviewController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    // 2. Authorization Check (Owner/Admin or internal service token)
    // NOTE: No specific check here; rely on `authenticate` middleware and owner's ability to call this.

    try {
        // 3. Service Call
        const breakdown = await revenueService.calculateRevenueSplit(req.body);

        // 4. Success (200 OK)
        return res.status(200).json(breakdown);

    } catch (error: any) {
        // 5. Error Handling
        if (error.message === 'ProjectNotFound') { return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found.' } }); }
        if (error.message.includes('RevenueSplitInvalid')) { return res.status(422).json({ error: { code: 'split_invalid', message: 'Revenue splits must sum to 100%.' } }); }
        if (error.message === 'RevenueModelNotFound') { return res.status(422).json({ error: { code: 'model_missing', message: 'Revenue model not found for the project.' } }); }
        
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error during revenue calculation.' } });
    }
};
```

#### **31.4. `src/routes/revenue.routes.ts` (New File)**

```typescript
// src/routes/revenue.routes.ts
import { Router } from 'express';
import { calculatePreviewController, calculateRevenueValidation } from '../controllers/revenue.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// POST /revenue/calculate - Calculate split preview (Task 31)
router.post(
    '/calculate',
    authenticate,
    // RBAC: Requires Project Create permission for access to financial preview/project data
    authorize([PERMISSIONS.PROJECT_CREATE]), 
    calculateRevenueValidation,
    calculatePreviewController
);

// NOTE: Future endpoints (schedule payouts, reports) will be added here.

export default router;
```

#### **31.5. Test Specification**

| Test ID | Endpoint | Description | Condition | Expected Status | Expected Check |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T31.1** | `Unit Test` | Determinism Check | 50/50 split on 100 cents | N/A | Output: 50, 50 |
| **T31.2** | `Unit Test` | Rounding Check | 33.33/33.33/33.33 split on 100 cents | N/A | Output: 34, 33, 33 (Largest Remainder) |
| **T31.3** | `POST /calculate` | Happy Path API | Valid Project ID, `amount: 10000` | **200 OK** | `platformFee` is 500 (5%). `totalDistributed` is 9500. |
| **T31.4** | `POST /calculate` | Fail: Invalid Split | `{ splits: [{ percentage: 90 }] }` | **422 Unprocessable** | `split_invalid` |
| **T31.5** | `POST /calculate` | Fail: Not Authenticated | Anonymous | **401 Unauthorized** | N/A |

---

