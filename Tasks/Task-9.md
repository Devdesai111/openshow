Following the structured plan, we proceed with **Task 9: Portfolio Asset Linkage & CRUD**.

This task extends the profile functionality from Task 8, allowing authenticated users (creators/owners) to manage the list of items displayed in their public portfolio by linking assets from the forthcoming Assets Service (Task 19).

***

## **Task 9: Portfolio Asset Linkage & CRUD**

**Goal:** Implement the full CRUD functionality for a creator's portfolio items (`POST /creators/:creatorId/portfolio`, `PUT /creators/:creatorId/portfolio/:itemId`, `DELETE /creators/:creatorId/portfolio/:itemId`) by adding, removing, and updating links to assets or external URLs.

**Service:** `User Profile & Creator Directory Service`
**Phase:** B - Core Platform Primitives
**Dependencies:** Task 8 (CreatorProfile Model), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/services/userProfile.service.ts` (Updated: `addPortfolioItem`, `updatePortfolioItem`, `deletePortfolioItem`)
2.  `src/controllers/userProfile.controller.ts` (Updated: new portfolio controllers)
3.  `src/routes/userProfile.routes.ts` (Updated: new protected routes)
4.  `test/integration/portfolio.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (201 Created/200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /creators/:id/portfolio** | `Body: { title, assetId?: string, externalLink?: string }` | `{ id: string, title: string, assetId?: string, ... }` | Auth (Owner only) |
| **PUT /creators/:id/portfolio/:itemId** | `Params: { itemId: string }`, Body: `{ title?, ... }` | `{ id: string, title: string, ... }` | Auth (Owner only) |
| **DELETE /creators/:id/portfolio/:itemId** | `Params: { itemId: string }` | **204 No Content** | Auth (Owner only) |

**Portfolio Item Requirement:** Must contain either `assetId` (MongoId string) OR `externalLink` (URL string).

**Runtime & Env Constraints:**
*   Requires unique identifier for embedded documents (Mongoose subdocuments need `_id`).
*   Asset ID validation must check for valid MongoId format (mock check for existence, full check in later tasks).

**Acceptance Criteria:**
*   `POST` returns **201 Created** and the embedded subdocument now has a unique `_id`.
*   All portfolio mutating endpoints **must** perform Identity Validation: `req.user.sub === params.creatorId` OR `req.user.role === 'admin'`.
*   Attempting to add an item without `assetId` OR `externalLink` returns **422 Unprocessable**.
*   `DELETE` successfully removes the embedded document and returns **204 No Content**.

**Tests to Generate:**
*   **Integration Test (Add):** Test successful addition with `assetId`, addition with `externalLink`, and failure on missing required fields (422).
*   **Integration Test (CRUD):** Test unauthorized deletion attempt (403).

**Non-Goals / Out-of-Scope (for Task 9):**
*   Validation that the `assetId` actually exists in the Assets Service (will be done in Task 19).
*   Portfolio sorting/reordering via dedicated endpoint (implicit update/reorder is allowed for now).

***

### **Task 9 Code Implementation**

#### **9.1. `src/services/userProfile.service.ts` (Updates)**

```typescript
// src/services/userProfile.service.ts (partial update)
// ... (Imports from Task 8) ...

import { Types } from 'mongoose';
import { ICreatorProfile } from '../models/creatorProfile.model';

// DTO for incoming portfolio data
interface IPortfolioData {
    title?: string;
    description?: string;
    assetId?: string; // string representation of ObjectId
    externalLink?: string;
}

export class UserProfileService {
    // ... (getUserProfile and updateUserProfile methods from Task 8) ...

    /**
     * Adds a new portfolio item to a creator's profile.
     * @throws {Error} - 'UserNotFound', 'PortfolioDataMissing'.
     */
    public async addPortfolioItem(creatorId: string, itemData: IPortfolioData): Promise<ICreatorProfile['portfolioItems'][number]> {
        const creatorObjectId = new Types.ObjectId(creatorId);

        // 1. Validation: Must have at least assetId or externalLink
        if (!itemData.assetId && !itemData.externalLink) {
            throw new Error('PortfolioDataMissing');
        }

        // 2. Build new item object (Mongoose will assign _id on push)
        const newItem = {
            _id: new Types.ObjectId(), // Client needs the ID immediately
            title: itemData.title,
            description: itemData.description,
            assetId: itemData.assetId ? new Types.ObjectId(itemData.assetId) : undefined,
            externalLink: itemData.externalLink,
        };

        // 3. Push new item to the embedded array (Upsert/findAndUpdate is best for this)
        const updatedProfile = await CreatorProfileModel.findOneAndUpdate(
            { userId: creatorObjectId },
            { $push: { portfolioItems: newItem } },
            { new: true, upsert: true, select: 'portfolioItems' } // Ensure we return the updated array for consistency
        );

        if (!updatedProfile) {
             throw new Error('UserNotFound'); // Should not happen with upsert=true, but safest check
        }

        // 4. Return the newly created item DTO
        const addedItem = updatedProfile.portfolioItems.find(item => item._id?.equals(newItem._id));

        if (!addedItem) {
             throw new Error('InternalSaveFailed');
        }

        // PRODUCTION: Emit 'creator.portfolio.added' event
        console.log(`[Event] Creator ${creatorId} added portfolio item ${addedItem._id.toString()}`);

        // Return sanitized DTO with string IDs
        return {
            ...addedItem.toObject(), 
            id: addedItem._id.toString(), 
            assetId: addedItem.assetId?.toString() 
        };
    }

    /**
     * Updates an existing portfolio item.
     * @throws {Error} - 'ProfileNotFound', 'ItemNotFound', 'PermissionDenied'.
     */
    public async updatePortfolioItem(creatorId: string, itemId: string, updateData: IPortfolioData): Promise<ICreatorProfile['portfolioItems'][number]> {
        const creatorObjectId = new Types.ObjectId(creatorId);
        const itemObjectId = new Types.ObjectId(itemId);

        // 1. Build dynamic update path for the embedded subdocument
        const setUpdate: any = {};
        if (updateData.title !== undefined) setUpdate['portfolioItems.$.title'] = updateData.title;
        if (updateData.description !== undefined) setUpdate['portfolioItems.$.description'] = updateData.description;
        
        // Handle assetId/externalLink mutual exclusivity or updates
        if (updateData.assetId !== undefined) {
             setUpdate['portfolioItems.$.assetId'] = updateData.assetId ? new Types.ObjectId(updateData.assetId) : null;
             // Clear externalLink if assetId is set/cleared
             if (updateData.assetId !== undefined) setUpdate['portfolioItems.$.externalLink'] = null;
        }
        if (updateData.externalLink !== undefined) {
             setUpdate['portfolioItems.$.externalLink'] = updateData.externalLink;
             // Clear assetId if externalLink is set
             if (updateData.externalLink !== undefined) setUpdate['portfolioItems.$.assetId'] = null;
        }

        // 2. Execute atomic update
        const updatedProfile = await CreatorProfileModel.findOneAndUpdate(
            { 
                userId: creatorObjectId, 
                'portfolioItems._id': itemObjectId // Match on the parent user and the subdocument ID
            },
            { $set: setUpdate },
            { new: true } // Return the full updated document
        );

        if (!updatedProfile) {
            throw new Error('ItemNotFound'); // Either profile or item not found
        }
        
        // 3. Return the specific updated item (Manual find in array needed as $ updates don't return the element directly)
        const updatedItem = updatedProfile.portfolioItems.find(item => item._id?.equals(itemObjectId));

        if (!updatedItem) {
             throw new Error('ItemNotFound'); // Should not happen, but a safety net
        }
        
        // PRODUCTION: Emit 'creator.portfolio.updated' event
        console.log(`[Event] Creator ${creatorId} updated portfolio item ${itemId}`);
        
        return {
            ...updatedItem.toObject(), 
            id: updatedItem._id.toString(), 
            assetId: updatedItem.assetId?.toString() 
        };
    }

    /**
     * Deletes a portfolio item.
     * @throws {Error} - 'ItemNotFound'.
     */
    public async deletePortfolioItem(creatorId: string, itemId: string): Promise<void> {
        const creatorObjectId = new Types.ObjectId(creatorId);
        const itemObjectId = new Types.ObjectId(itemId);

        // 1. Execute atomic pull operation (remove from embedded array)
        const result = await CreatorProfileModel.updateOne(
            { userId: creatorObjectId },
            { $pull: { portfolioItems: { _id: itemObjectId } } }
        );

        // 2. Check if anything was modified
        if (result.modifiedCount === 0) {
            // Find just to ensure the user exists before throwing 'ItemNotFound'
            const userExists = await UserModel.exists({ _id: creatorObjectId });
            if (!userExists) {
                throw new Error('UserNotFound');
            }
            throw new Error('ItemNotFound'); 
        }
        
        // PRODUCTION: Emit 'creator.portfolio.deleted' event
        console.log(`[Event] Creator ${creatorId} deleted portfolio item ${itemId}`);
    }
}
```

#### **9.2. `src/controllers/userProfile.controller.ts` (Updates)**

```typescript
// src/controllers/userProfile.controller.ts (partial update)
// ... (Imports, userProfileService initialization, Task 8 controllers) ...

import { Types } from 'mongoose'; // Used for isMongoId validation logic

// --- Validation Middleware (New) ---

// Reusable validation for portfolio item body
export const portfolioItemValidation = [
    // Must contain either assetId or externalLink
    body().custom(value => {
        if (!value.assetId && !value.externalLink) {
            throw new Error('Portfolio item must contain either assetId or externalLink.');
        }
        return true;
    }),
    body('assetId').optional().isMongoId().withMessage('Asset ID must be a valid Mongo ID.').bail(),
    body('externalLink').optional().isURL({ protocols: ['http', 'https'] }).withMessage('External link must be a valid URL.'),
    body('title').optional().isString().isLength({ max: 200 }).withMessage('Title max 200 chars.'),
];

// Reusable validation for portfolio item ID param
export const portfolioItemIdParamValidation = [
    param('itemId').isMongoId().withMessage('Invalid Portfolio Item ID format.'),
];

// --- Portfolio Controllers ---

/** Adds a new portfolio item. POST /creators/:creatorId/portfolio */
export const addPortfolioItemController = async (req: Request, res: Response) => {
    // 1. Input Validation (including custom assetId/externalLink check)
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: errors.array() }});
    }

    const creatorId = req.params.creatorId;

    try {
        // 2. Service Call
        const newItem = await userProfileService.addPortfolioItem(creatorId, req.body);

        // 3. Success (201 Created)
        return res.status(201).json({
            id: newItem.id, // Return the newly assigned ID
            ...newItem,
            assetId: newItem.assetId, // Ensure string ID is returned
            createdAt: newItem.createdAt?.toISOString(),
        });

    } catch (error: any) {
        if (error.message === 'PortfolioDataMissing') {
             return res.status(422).json({ error: { code: 'data_missing', message: 'Portfolio item requires an Asset ID or an external link.' } });
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error adding portfolio item.' } });
    }
};

/** Updates an existing portfolio item. PUT /creators/:creatorId/portfolio/:itemId */
export const updatePortfolioItemController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: errors.array() }});
    }

    const { creatorId, itemId } = req.params;

    try {
        // 2. Service Call
        const updatedItem = await userProfileService.updatePortfolioItem(creatorId, itemId, req.body);

        // 3. Success (200 OK)
        return res.status(200).json({
            id: updatedItem.id, 
            ...updatedItem,
            assetId: updatedItem.assetId, 
            updatedAt: updatedItem.updatedAt?.toISOString(),
        });

    } catch (error: any) {
        if (error.message === 'ItemNotFound') {
            return res.status(404).json({ error: { code: 'item_not_found', message: 'Portfolio item not found for this creator.' } });
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error updating portfolio item.' } });
    }
};


/** Deletes a portfolio item. DELETE /creators/:creatorId/portfolio/:itemId */
export const deletePortfolioItemController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Invalid ID format.' }});
    }

    const { creatorId, itemId } = req.params;

    try {
        // 2. Service Call
        await userProfileService.deletePortfolioItem(creatorId, itemId);

        // 3. Success (204 No Content)
        return res.status(204).send();

    } catch (error: any) {
        if (error.message === 'ItemNotFound') {
            return res.status(404).json({ error: { code: 'item_not_found', message: 'Portfolio item not found.' } });
        }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error deleting portfolio item.' } });
    }
};
```

#### **9.3. `src/routes/userProfile.routes.ts` (Updates)**

```typescript
// src/routes/userProfile.routes.ts (partial update)
import { Router } from 'express';
import { 
    // ... (Task 8 Imports)
    addPortfolioItemController,
    updatePortfolioItemController,
    deletePortfolioItemController,
    portfolioItemValidation,
    portfolioItemIdParamValidation,
} from '../controllers/userProfile.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';

const router = Router();

// --- Protected Portfolio Endpoints (Creator/Owner only) ---
const portfolioAccess = [PERMISSIONS.CREATOR_PROFILE_EDIT]; // RBAC permission check

// POST /creators/:creatorId/portfolio - Add portfolio item (Task 9)
router.post(
    '/:creatorId/portfolio',
    authenticate,
    portfolioItemValidation,
    authorize(portfolioAccess), // RBAC check: only allowed to edit own profile
    addPortfolioItemController
);

// PUT /creators/:creatorId/portfolio/:itemId - Update portfolio item (Task 9)
router.put(
    '/:creatorId/portfolio/:itemId',
    authenticate,
    portfolioItemIdParamValidation,
    portfolioItemValidation, // Reused for PUT (update)
    authorize(portfolioAccess),
    updatePortfolioItemController
);

// DELETE /creators/:creatorId/portfolio/:itemId - Delete portfolio item (Task 9)
router.delete(
    '/:creatorId/portfolio/:itemId',
    authenticate,
    portfolioItemIdParamValidation,
    authorize(portfolioAccess),
    deletePortfolioItemController
);

// ... (GET/PUT /users/:userId from Task 8) ...

export default router;
```

#### **9.4. Test Specification**

| Test ID | Endpoint | Description | Input | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T9.1** | `POST /:id/portfolio` | Happy Path: Add with Asset ID | `{ title: "VFX Demo", assetId: "60f1a2b3c4d5e6f7a8b9c0d1" }` | **201 Created** | N/A |
| **T9.2** | `POST /:id/portfolio` | Happy Path: Add with External Link | `{ title: "YouTube Link", externalLink: "https://youtu.be/abc" }` | **201 Created** | N/A |
| **T9.3** | `POST /:id/portfolio` | Fail: Missing Link/Asset | `{ title: "Invalid" }` | **422 Unprocessable** | `data_missing` |
| **T9.4** | `PUT /:id/portfolio/:item` | Happy Path: Update Item Title | `{ title: "VFX Demo (Final)" }` | **200 OK** | N/A |
| **T9.5** | `DELETE /:id/portfolio/:item` | Happy Path: Delete Item | N/A | **204 No Content** | N/A |
| **T9.6** | `PUT /:id/portfolio/:item` | Fail: Unauthorized User | Valid Creator Token (not owner) | **403 Forbidden** | `permission_denied` |

---
