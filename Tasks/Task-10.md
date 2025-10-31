Following the project structure and recognizing the high priority of the public-facing **Creator Directory** for platform viability, here is the detailed implementation for **Task 10: Creator Directory Search & Listing**.

This task establishes the core "Marketplace" functionality, allowing external and internal users to discover verified creators using filters and sorting.

***

## **Task 10: Creator Directory Search & Listing**

**Goal:** Implement the public, paginated endpoint (`GET /creators`) for the Creator Directory, supporting multiple query filters (skill, category, verified, availability) and sorting options, relying on the **Discovery/Search API** structure.

**Service:** `Marketplace / Discovery / Search API`
**Phase:** C - Project, Collaboration, Discovery plumbing
**Dependencies:** Task 8 (CreatorProfile Model, User Profile Logic), Task 2 (RBAC structure).

**Output Files:**
1.  `src/services/discovery.service.ts` (New file: `searchCreators`)
2.  `src/controllers/discovery.controller.ts` (New file: `searchCreatorsController`)
3.  `src/routes/userProfile.routes.ts` (Updated to mount new public route)
4.  `test/integration/directory_search.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Query Params) | Response (200 OK) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **GET /creators** | `q?: string, skill?: string, verified?: boolean, sort?: string, page?: int, per_page?: int` | `CreatorListResponse` (Paginated, Public DTOs) | Public |

**CreatorListResponse (Excerpt):**
```json
{
  "meta": { "page": 1, "per_page": 20, "total": 150 },
  "data": [
    { 
      "id": "6500a1b2...", "preferredName": "Dev Bhai", "headline": "AI prompt engineer", 
      "skills": ["prompt-engineering"], "verified": true, "rating": { "avg": 4.8, "count": 25 }
    }
  ]
}
```

**Runtime & Env Constraints:**
*   This endpoint is performance-critical (high traffic/public). It should use MongoDB aggregation/indexing or be designed to eventually query a dedicated search index (ES/OpenSearch). **We will simulate the search index behavior using a well-indexed Mongoose query for Phase 1.**
*   Pagination must be reliable (`page`/`per_page` style for Phase 1 simplicity, with future cursor-based pagination noted).

**Acceptance Criteria:**
*   Successfully filters results by `verified=true/false` and by `skill` (array contains).
*   Correctly applies `per_page` limit and returns accurate `meta` pagination data.
*   The search endpoint must be fully **Public** (no auth required).
*   The returned DTOs must be the **Public Profile** format (no emails/sensitive data).

**Tests to Generate:**
*   **Integration Test (Filters):** Test filtering by multiple criteria (e.g., `verified=true` AND `skill=video-editing`).
*   **Integration Test (Pagination):** Test `page` and `per_page` functionality and boundary conditions.
*   **Performance Note:** Add a note about the transition to a dedicated search engine (Task 41) for scale.

***

### **Task 10 Code Implementation**

#### **10.1. `src/services/discovery.service.ts` (New File)**

```typescript
// src/services/discovery.service.ts
import { CreatorProfileModel, ICreatorProfile } from '../models/creatorProfile.model';
import { UserModel } from '../models/user.model';

// DTOs for the list item (subset of ICreatorProfile + denormalized user data)
interface ICreatorListItem {
    id: string;
    userId: string;
    preferredName?: string;
    headline?: string;
    skills: string[];
    verified: boolean;
    rating: ICreatorProfile['rating'];
    availability: ICreatorProfile['availability'];
    // ... other public fields
}

interface ICreatorListResponse {
    meta: { page: number; per_page: number; total: number; total_pages: number };
    data: ICreatorListItem[];
}

export class DiscoveryService {
    /**
     * Searches and lists creators with pagination and filtering.
     * @param queryParams - Filters, search term, and pagination parameters.
     * @returns Paginated list of Creator DTOs.
     * 
     * NOTE: This implementation simulates a search index query using Mongoose for Phase 1. 
     * In production (Task 41), this would call an ElasticSearch/OpenSearch client.
     */
    public async searchCreators(queryParams: any): Promise<ICreatorListResponse> {
        const { 
            q, 
            skill, 
            verified, 
            availability, 
            sort = 'rating', 
            page = 1, 
            per_page = 20 
        } = queryParams;

        // 1. Build Query and Filter (Simulation of Search Engine Query)
        const limit = parseInt(per_page.toString());
        const skip = (parseInt(page.toString()) - 1) * limit;
        const profileFilters: any = {};
        
        // Apply Filters
        if (skill) profileFilters.skills = { $in: [skill] };
        if (verified !== undefined) profileFilters.verified = verified === 'true';
        if (availability) profileFilters.availability = availability;
        
        // 2. Build Sort Order
        let sortOrder: any = {};
        if (sort === 'rating') sortOrder['rating.avg'] = -1;
        if (sort === 'newest') sortOrder['createdAt'] = -1;
        // NOTE: Full-text search 'relevance' sort is omitted in this DB simulation.

        // 3. Execute DB Query (Efficient read-only queries with lean())
        const [totalResults, profiles] = await Promise.all([
            CreatorProfileModel.countDocuments(profileFilters),
            CreatorProfileModel.find(profileFilters)
                .sort(sortOrder)
                .skip(skip)
                .limit(limit)
                .populate({ path: 'userId', select: 'preferredName role email' }) // Denormalize required User fields
                .lean() as Promise<ICreatorProfile[]>,
        ]);
        
        // 4. Map to Public DTOs and Redact (Final security layer for public view)
        const data = profiles.map(profile => {
            const user = profile.userId as unknown as UserModel & { preferredName: string; role: string; email: string; }; // Cast populated user
            
            return {
                id: profile._id.toString(),
                userId: user._id.toString(),
                preferredName: user.preferredName,
                headline: profile.headline,
                skills: profile.skills,
                verified: profile.verified,
                rating: profile.rating,
                availability: profile.availability,
                // SECURITY: Explicitly omit sensitive fields like email and internal IDs
            } as ICreatorListItem;
        });

        // 5. Construct Paginated Response
        return {
            meta: {
                page: parseInt(page.toString()),
                per_page: limit,
                total: totalResults,
                total_pages: Math.ceil(totalResults / limit),
            },
            data,
        };
    }
}
```

#### **10.2. `src/controllers/discovery.controller.ts` (New File)**

```typescript
// src/controllers/discovery.controller.ts
import { Request, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { DiscoveryService } from '../services/discovery.service';

const discoveryService = new DiscoveryService();

// --- Validation Middleware ---
export const searchCreatorsValidation = [
    query('skill').optional().isString().withMessage('Skill must be a string.'),
    query('verified').optional().isBoolean().withMessage('Verified must be a boolean string.'),
    query('availability').optional().isIn(['open', 'busy', 'invite-only']).withMessage('Invalid availability status.'),
    query('sort').optional().isIn(['rating', 'newest', 'relevance']).withMessage('Invalid sort parameter.'),
    query('page').optional().isInt({ min: 1 }).toInt().withMessage('Page must be a positive integer.'),
    query('per_page').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Per_page must be between 1 and 100.'),
    // NOTE: 'q' (search term) validation is usually minimal (sanitization only)
];

/** Handles the search and listing of creators. GET /creators */
export const searchCreatorsController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ error: { code: 'validation_error', message: 'Query parameter validation failed.', details: errors.array() }});
    }

    try {
        // 2. Service Call
        const results = await discoveryService.searchCreators(req.query);

        // 3. Success (200 OK)
        // NOTE: The service returns the final DTO/Pagination structure directly.
        return res.status(200).json(results);

    } catch (error: any) {
        // Fallback for unexpected errors
        return res.status(500).json({ 
            error: { 
                code: 'server_error', 
                message: 'An unexpected error occurred during creator search.' 
            } 
        });
    }
};
```

#### **10.3. `src/routes/userProfile.routes.ts` (Updates)**

```typescript
// src/routes/userProfile.routes.ts (partial update - Renamed/Reorganized for clarity)
import { Router } from 'express';
// ... (All other imports from Task 9) ...
import { searchCreatorsController, searchCreatorsValidation } from '../controllers/discovery.controller';

const router = Router();

// --- Public/Discovery Endpoints ---

// GET /creators - Creator Directory Listing/Search (Task 10)
router.get(
    '/creators', 
    searchCreatorsValidation, 
    searchCreatorsController
);

// NOTE: To follow REST best practices, consider separating the Creator Directory to its own router (e.g., discovery.routes.ts). 
// For now, mounted on /creators to match spec and simplicity.


// ... (Task 8/9 endpoints mounted on /users/:userId or /:creatorId ) ...

export default router;
```

#### **10.4. Test Specification**

| Test ID | Endpoint | Description | Query Params | Expected Status | Expected Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T10.1** | `GET /creators` | Happy Path: Basic Pagination | `page=1&per_page=10` | **200 OK** | `data` array length <= 10. `meta` is correct. |
| **T10.2** | `GET /creators` | Filter: Verified Status | `verified=true&per_page=50` | **200 OK** | All items in `data` have `"verified": true`. |
| **T10.3** | `GET /creators` | Filter: Skill Match (Simulated) | `skill=prompt-engineering` | **200 OK** | Only profiles matching the skill are returned. |
| **T10.4** | `GET /creators` | Filter Fail: Invalid Per Page | `per_page=200` | **422 Unprocessable** | `validation_error` (max 100 enforced) |
| **T10.5** | `GET /creators` | Security: Public DTO | N/A | **200 OK** | Response **MUST NOT** contain `email` or `hashedPassword`. |

---
