# Task-105: Master Implementation Patterns & Standards

**Version**: 1.0  
**Purpose**: Centralized implementation guide for all OpenShow backend tasks  
**Status**: 🔴 REQUIRED - Read relevant sections before implementing any task  

---

## 📖 How to Use This File

### For Developers:
1. Open your assigned task (e.g., Task-12.md)
2. Note will say: "⚠️ READ FIRST: Task-105-Master.md lines X-Y"
3. Read those lines in THIS file for implementation patterns
4. Implement your task using these standards
5. Result: Production-ready code first time ✅

### Quick Reference Index

| Task(s) | Topic | Lines | What You'll Learn |
|---------|-------|-------|-------------------|
| **1, 3, 4, 6, 8, 10** | User DTOs & Auth | 80-320 | UserDTOMapper, AuthUserDTO, CreatorProfileDTO |
| **12, 13, 15, 22-24** | Projects & Revenue | 321-580 | RevenueSplitMapper, ProjectMemberMapper, MoneyAmount |
| **14, 30** | Milestone State Machine | 581-780 | MilestoneMapper, availableActions[] |
| **10, 15, 22, 23, 37, 38, 70, 71** | Pagination | 781-920 | PaginatedResponse, has_next/has_prev |
| **ALL TASKS** | Error Handling | 921-1080 | ResponseBuilder, ErrorCode, APIErrorResponse |
| **ALL TASKS** | Serialization | 1081-1200 | serializeDocument, stringifyIds, Date formatting |
| **16-20** | Asset Management | 1201-1400 | AssetMapper, processing status, polling |
| **11, 47-50** | Notifications | 1401-1600 | NotificationMapper, channel-specific content |
| **24, 35-40** | Payments & Money | 1601-1750 | MoneyAmount, currency formatting |
| **ALL TASKS** | Response Patterns | 1751-1900 | Success/Error response templates |
| **ALL TASKS** | Validation Patterns | 1901-2050 | Input validation, password rules |

---

## Lines 1-79: Introduction & Prerequisites

### Philosophy

**Separation of Concerns:**
- **Task-N.md** = WHAT to build (business requirements, endpoints, logic)
- **Task-105.md** = HOW to build it (implementation patterns, code standards)

### Prerequisites (Implement These First!)

Before coding ANY task, these files MUST exist:

```typescript
// Foundation utilities (from Task-102)
src/utils/serialize.ts              // ObjectId & Date conversion
src/utils/response-builder.ts       // Standardized responses
src/utils/logger.ts                  // PII-safe logging
src/utils/validation.ts              // Password & input rules

// Type definitions
src/types/user-dtos.ts              // User DTO interfaces + mapper
src/types/error-dtos.ts             // Error response standard
src/types/pagination-dtos.ts        // Pagination wrapper
src/types/project-dtos.ts           // Project, Revenue, Milestone DTOs
src/types/asset-dtos.ts             // Asset upload/download DTOs
src/types/notification-dtos.ts      // Notification channel DTOs

// Middleware
src/middleware/error-handler.ts     // Global error middleware
src/middleware/rate-limiter.ts      // Rate limiting
```

**Setup Time**: 1-2 days to implement all foundation files  
**Payoff**: Every subsequent task is 2-3x faster and bug-free

---

## Lines 80-320: User DTOs & Authentication Patterns
**Referenced by Tasks**: 1, 3, 4, 6, 8, 10

### Problem Statement

Tasks 1, 4, and 8 return DIFFERENT user shapes:
- Task-1 (signup): Basic user fields
- Task-4 (/auth/me): Adds twoFAEnabled, socialAccounts, lastSeenAt
- Task-8 (profile): Adds headline, bio, verified, skills

**This breaks frontend caching and type safety!**

### Solution: Standardized User DTOs

#### Step 1: Define Types (`src/types/user-dtos.ts`)

```typescript
/**
 * Base public user profile (visible to all authenticated users)
 */
export interface UserPublicDTO {
  id: string;                    // ALWAYS string (never ObjectId)
  preferredName: string;
  role: 'creator' | 'owner' | 'admin';
  avatar?: string;
  createdAt: string;            // ALWAYS ISO 8601 string
}

/**
 * Private user profile (visible to self + admins)
 */
export interface UserPrivateDTO extends UserPublicDTO {
  email: string;
  fullName?: string;
  status: 'active' | 'pending' | 'suspended';
  twoFAEnabled: boolean;
  lastSeenAt?: string;          // ISO 8601
}

/**
 * Full authenticated user (for /auth/me, signup, login)
 */
export interface AuthUserDTO extends UserPrivateDTO {
  socialAccounts: Array<{
    provider: string;
    providerId: string;
    connectedAt: string;        // ISO 8601
  }>;
}

/**
 * Creator-specific profile (extends public with portfolio data)
 */
export interface CreatorProfileDTO extends UserPublicDTO {
  headline?: string;
  bio?: string;
  verified: boolean;
  skills: string[];
  languages: string[];
  portfolio?: PortfolioItemSummaryDTO[];
  rating?: {
    average: number;            // 0-5
    count: number;
  };
  hourlyRate?: MoneyAmount;
}

export interface PortfolioItemSummaryDTO {
  itemId: string;
  title: string;
  thumbnailUrl?: string;
  createdAt: string;
}

export interface MoneyAmount {
  amount: number;               // In cents (e.g., 1234 = $12.34)
  currency: string;             // ISO 4217 code (USD, EUR, GBP)
  display: string;              // "$12.34", "€10,00"
}
```

#### Step 2: Create Mapper Class

```typescript
import { IUser } from '../models/user.model';
import { ICreatorProfile } from '../models/CreatorProfile';

export class UserDTOMapper {
  /**
   * Maps User to public DTO (safe for any authenticated user)
   */
  static toPublicDTO(user: IUser): UserPublicDTO {
    return {
      id: user._id!.toString(),
      preferredName: user.preferredName || 'Anonymous',
      role: user.role,
      avatar: user.avatar,
      createdAt: user.createdAt!.toISOString(),
    };
  }

  /**
   * Maps User to private DTO (for self + admins)
   */
  static toPrivateDTO(user: IUser): UserPrivateDTO {
    return {
      ...this.toPublicDTO(user),
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      twoFAEnabled: user.twoFA?.enabled || false,
      lastSeenAt: user.lastSeenAt?.toISOString(),
    };
  }

  /**
   * Maps User to full authenticated DTO (for /auth/me, login, signup)
   */
  static toAuthDTO(user: IUser): AuthUserDTO {
    return {
      ...this.toPrivateDTO(user),
      socialAccounts: (user.socialAccounts || []).map(acc => ({
        provider: acc.provider,
        providerId: acc.providerId,
        connectedAt: acc.connectedAt.toISOString(),
      })),
    };
  }

  /**
   * Maps User + CreatorProfile to creator DTO
   */
  static toCreatorDTO(user: IUser, profile: ICreatorProfile | null): CreatorProfileDTO {
    return {
      ...this.toPublicDTO(user),
      headline: profile?.headline,
      bio: profile?.bio,
      verified: profile?.verified || false,
      skills: profile?.skills || [],
      languages: profile?.languages || user.languages || [],
      rating: profile?.rating ? {
        average: profile.rating.average,
        count: profile.rating.count,
      } : undefined,
      hourlyRate: profile?.hourlyRate ? {
        amount: profile.hourlyRate.amount,
        currency: profile.hourlyRate.currency || 'USD',
        display: formatMoney(profile.hourlyRate.amount, profile.hourlyRate.currency || 'USD'),
      } : undefined,
    };
  }
}

function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  });
  return formatter.format(amount);
}
```

#### Step 3: Usage in Controllers

**Task-1 (Signup/Login):**
```typescript
import { UserDTOMapper } from '../types/user-dtos';
import { ResponseBuilder } from '../utils/response-builder';

export const signupController = async (req: Request, res: Response) => {
  // ... validation, service call ...
  const { user, accessToken, refreshToken, expiresIn } = await authService.signup(req.body);

  // ✅ Use mapper instead of manual DTO construction
  const userDTO = UserDTOMapper.toAuthDTO(user);

  return ResponseBuilder.success(res, {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn,
    user: userDTO,  // ✅ Consistent shape
  }, 201);
};
```

**Task-4 (/auth/me):**
```typescript
export const meController = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const user = await authService.getAuthMe(userId);

  // ✅ Same mapper, same shape as signup/login
  const userDTO = UserDTOMapper.toAuthDTO(user);

  return ResponseBuilder.success(res, userDTO, 200);
};
```

**Task-8 (User Profile):**
```typescript
export const getUserController = async (req: Request, res: Response) => {
  const { userId } = req.params;
  const [user, creatorProfile] = await Promise.all([
    UserModel.findById(userId),
    CreatorProfileModel.findOne({ userId }),
  ]);

  const requesterId = req.user?.sub;
  const isOwner = userId === requesterId;
  const isAdmin = req.user?.role === 'admin';

  // ✅ Choose appropriate mapper based on access level
  if (user.role === 'creator') {
    const creatorDTO = UserDTOMapper.toCreatorDTO(user, creatorProfile);
    
    if (isOwner || isAdmin) {
      // Add private fields for self/admin
      return ResponseBuilder.success(res, {
        ...creatorDTO,
        email: user.email,
        status: user.status,
      }, 200);
    }
    return ResponseBuilder.success(res, creatorDTO, 200);
  }

  // For non-creators
  const userDTO = (isOwner || isAdmin) 
    ? UserDTOMapper.toPrivateDTO(user)
    : UserDTOMapper.toPublicDTO(user);

  return ResponseBuilder.success(res, userDTO, 200);
};
```

**Task-10 (Creator Directory):**
```typescript
export const searchCreatorsController = async (req: Request, res: Response) => {
  const { creators, total } = await discoveryService.searchCreators(req.query);

  // ✅ Map all creators to CreatorProfileDTO
  const creatorDTOs = creators.map(({ user, profile }) => 
    UserDTOMapper.toCreatorDTO(user, profile)
  );

  return ResponseBuilder.paginated(res, creatorDTOs, page, perPage, total, 200);
};
```

### Key Takeaways

✅ **ALWAYS use UserDTOMapper** - Never construct user objects manually  
✅ **Choose correct mapper** - toAuthDTO for auth, toCreatorDTO for profiles  
✅ **ObjectIds → strings** - Mapper handles this automatically  
✅ **Dates → ISO 8601** - Mapper handles this automatically  
✅ **Consistent shape** - Frontend can cache/type safely  

---

## Lines 321-580: Projects & Revenue Splits
**Referenced by Tasks**: 12, 13, 15, 22, 23, 24

### Problem Statement

Task-12 and Task-15 have multiple payload mismatches:
1. **Revenue splits**: All fields optional (userId?, percentage?, placeholder?)
2. **Money format**: Sometimes cents, sometimes dollars, sometimes missing currency
3. **Subdocument IDs**: Use `_id` instead of semantic names like `roleId`
4. **Team members**: Return just IDs, not full member details

### Solution: Project DTOs with Discriminated Unions

#### Step 1: Define Revenue Split Types (`src/types/project-dtos.ts`)

```typescript
/**
 * Base revenue split (discriminated union)
 */
export interface RevenueSplitBaseDTO {
  splitId: string;
  type: 'percentage' | 'fixed';
}

/**
 * Percentage-based split (0-100%)
 */
export interface PercentageRevenueSplitDTO extends RevenueSplitBaseDTO {
  type: 'percentage';
  percentage: number;           // REQUIRED (not optional!)
  assignee?: {                  // Optional: only if assigned
    userId: string;
    name: string;
  };
  placeholder?: string;         // "Director", "Team Pool", etc.
}

/**
 * Fixed-amount split ($X per transaction)
 */
export interface FixedRevenueSplitDTO extends RevenueSplitBaseDTO {
  type: 'fixed';
  amount: MoneyAmount;          // Structured money object
  assignee: {                   // REQUIRED for fixed splits
    userId: string;
    name: string;
  };
}

export type RevenueSplitDTO = PercentageRevenueSplitDTO | FixedRevenueSplitDTO;

/**
 * Project role with semantic naming
 */
export interface ProjectRoleDTO {
  roleId: string;               // NOT _id!
  title: string;
  description?: string;
  slots: number;
  filled: number;
  assignedUserIds: string[];    // Hidden for non-members
  skills?: string[];
  compensation?: MoneyAmount;
}

/**
 * Full project member details (not just IDs!)
 */
export interface ProjectMemberDTO {
  userId: string;
  name: string;
  avatar?: string;
  roles: Array<{
    roleId: string;
    title: string;
  }>;
  joinedAt: string;             // ISO 8601
}
```

#### Step 2: Create Revenue Split Mapper

```typescript
export class RevenueSplitMapper {
  /**
   * Maps IRevenueSplit to standardized DTO
   * @param split - Database model
   * @param showDetails - Show assignee details (member view)
   */
  static toDTO(split: IRevenueSplit, showDetails: boolean = false): RevenueSplitDTO {
    const base = {
      splitId: split._id!.toString(),
      type: split.fixedAmount ? 'fixed' : 'percentage' as const,
    };

    // Fixed amount split
    if (split.fixedAmount) {
      return {
        ...base,
        type: 'fixed',
        amount: {
          amount: split.fixedAmount,
          currency: split.currency || 'USD',
          display: formatMoney(split.fixedAmount, split.currency || 'USD'),
        },
        assignee: showDetails && split.userId ? {
          userId: split.userId.toString(),
          name: split.assigneeName || 'Assignee',
        } : undefined,
      } as FixedRevenueSplitDTO;
    }

    // Percentage split
    return {
      ...base,
      type: 'percentage',
      percentage: split.percentage || 0,  // Default 0 if missing
      assignee: showDetails && split.userId ? {
        userId: split.userId.toString(),
        name: split.assigneeName || 'Assignee',
      } : undefined,
      placeholder: split.placeholder,
    } as PercentageRevenueSplitDTO;
  }
}
```

#### Step 3: Create Project Member Mapper

```typescript
export class ProjectMemberMapper {
  /**
   * Maps teamMemberIds to full member details
   */
  static async toDTOArray(
    project: IProject,
    includeRoles: boolean = true
  ): Promise<ProjectMemberDTO[]> {
    // Fetch all members in one query
    const users = await UserModel.find({
      _id: { $in: project.teamMemberIds }
    }).select('_id preferredName avatar').lean();

    return users.map(user => ({
      userId: user._id.toString(),
      name: user.preferredName || 'Unknown',
      avatar: user.avatar,
      roles: includeRoles ? project.roles
        .filter(r => r.assignedUserIds.some(id => id.toString() === user._id.toString()))
        .map(r => ({
          roleId: r._id!.toString(),
          title: r.title,
        })) : [],
      joinedAt: project.createdAt!.toISOString(),
    }));
  }
}
```

#### Step 4: Usage in Controllers

**Task-12 (Project Creation):**
```typescript
export const createProjectController = async (req: Request, res: Response) => {
  const project = await projectService.createProject(req.body, req.user!.sub);

  // ✅ Serialize response with proper DTOs
  return ResponseBuilder.success(res, {
    projectId: project._id!.toString(),
    title: project.title,
    status: project.status,
    roles: project.roles.map(r => ({
      roleId: r._id!.toString(),      // ✅ Semantic naming
      title: r.title,
      slots: r.slots,
    })),
    revenueSplits: project.revenueSplits.map(split => 
      RevenueSplitMapper.toDTO(split, true)  // ✅ Consistent shape
    ),
    createdAt: project.createdAt!.toISOString(),
  }, 201);
};
```

**Task-15 (Project Detail):**
```typescript
export const getProjectController = async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const project = await ProjectModel.findById(projectId);

  const userId = req.user?.sub;
  const isMember = project.teamMemberIds.some(id => id.toString() === userId);

  // ✅ Full member details (not just IDs)
  const members = await ProjectMemberMapper.toDTOArray(project, isMember);

  return ResponseBuilder.success(res, {
    projectId: project._id!.toString(),
    title: project.title,
    description: project.description,
    status: project.status,
    ownerId: project.ownerId.toString(),
    roles: project.roles.map(r => ({
      roleId: r._id!.toString(),
      title: r.title,
      slots: r.slots,
      filled: r.assignedUserIds.length,
      assignedUserIds: isMember ? r.assignedUserIds.map(id => id.toString()) : [],
    })),
    milestones: project.milestones.map(m => ({
      milestoneId: m._id!.toString(),
      title: m.title,
      status: m.status,
      amount: m.amount ? formatMoneyAmount(m.amount, 'USD') : undefined,
    })),
    revenueSplits: project.revenueSplits.map(split => 
      RevenueSplitMapper.toDTO(split, isMember)
    ),
    members: members,                    // ✅ Full details
    totalBudget: formatMoneyAmount(project.totalBudget, 'USD'),
    createdAt: project.createdAt!.toISOString(),
    updatedAt: project.updatedAt!.toISOString(),
  }, 200);
};
```

### Key Takeaways

✅ **Discriminated unions** for revenue splits (type: 'percentage' | 'fixed')  
✅ **MoneyAmount** for all currency values  
✅ **Semantic naming** (roleId, not _id)  
✅ **Full member details** (not just IDs)  
✅ **Access control** (hide assignees for non-members)  

---

## Lines 581-780: Milestone State Machine
**Referenced by Tasks**: 14, 30

### Problem Statement

Tasks 14 and 30 return milestone status but don't tell frontend:
- What actions are valid from current state?
- Can I approve a pending milestone? (No!)
- Can I dispute an approved milestone? (Depends!)

**Frontend has to guess → Invalid state transitions!**

### Solution: Explicit State Machine with availableActions

#### Step 1: Define Milestone Types

```typescript
export type MilestoneStatus = 
  | 'pending' 
  | 'funded' 
  | 'in_progress' 
  | 'completed' 
  | 'approved' 
  | 'disputed' 
  | 'rejected';

export type MilestoneAction = 
  | 'edit' 
  | 'delete' 
  | 'fund' 
  | 'start' 
  | 'complete' 
  | 'approve' 
  | 'dispute' 
  | 'resolve';

export interface MilestoneStateChange {
  status: MilestoneStatus;
  timestamp: string;
  userId?: string;
  reason?: string;
}

export interface MilestoneDTO {
  milestoneId: string;
  title: string;
  description?: string;
  dueDate?: string;
  status: MilestoneStatus;
  amount?: MoneyAmount;
  assetId?: string;
  availableActions: MilestoneAction[];  // ✅ Explicit state machine!
  stateHistory: MilestoneStateChange[];
  createdAt: string;
  updatedAt: string;
}
```

#### Step 2: Create Milestone Mapper with State Logic

```typescript
export class MilestoneMapper {
  static toDTO(
    milestone: IMilestone,
    userRole: string,
    isProjectMember: boolean,
    isProjectOwner: boolean
  ): MilestoneDTO {
    return {
      milestoneId: milestone._id!.toString(),
      title: milestone.title,
      description: milestone.description,
      dueDate: milestone.dueDate?.toISOString(),
      status: milestone.status as MilestoneStatus,
      amount: milestone.amount ? formatMoneyAmount(milestone.amount, 'USD') : undefined,
      assetId: milestone.assetId?.toString(),
      availableActions: this.getAvailableActions(
        milestone.status as MilestoneStatus,
        userRole,
        isProjectMember,
        isProjectOwner
      ),
      stateHistory: milestone.stateHistory || [],
      createdAt: milestone.createdAt!.toISOString(),
      updatedAt: milestone.updatedAt!.toISOString(),
    };
  }

  /**
   * State machine logic - defines valid transitions
   */
  private static getAvailableActions(
    status: MilestoneStatus,
    userRole: string,
    isProjectMember: boolean,
    isProjectOwner: boolean
  ): MilestoneAction[] {
    const actions: MilestoneAction[] = [];

    switch (status) {
      case 'pending':
        if (isProjectOwner || userRole === 'admin') {
          actions.push('edit', 'delete', 'fund');
        }
        break;

      case 'funded':
        if (isProjectMember) {
          actions.push('start');
        }
        if (isProjectOwner || userRole === 'admin') {
          actions.push('edit');
        }
        break;

      case 'in_progress':
        if (isProjectMember) {
          actions.push('complete');
        }
        break;

      case 'completed':
        if (isProjectOwner || userRole === 'admin') {
          actions.push('approve', 'dispute');
        }
        break;

      case 'disputed':
        if (userRole === 'admin') {
          actions.push('resolve');  // Admin mediation
        }
        break;

      case 'approved':
        // Final state - no further actions
        break;

      case 'rejected':
        if (userRole === 'admin') {
          actions.push('resolve');
        }
        break;
    }

    return actions;
  }
}
```

#### Step 3: Usage in Controllers

**Task-14 (Complete Milestone):**
```typescript
export const completeMilestoneController = async (req: Request, res: Response) => {
  const { projectId, milestoneId } = req.params;
  const userId = req.user!.sub;

  const project = await ProjectModel.findById(projectId);
  const milestone = project.milestones.id(milestoneId);

  // Validation
  if (milestone.status !== 'in_progress') {
    return ResponseBuilder.error(
      res,
      ErrorCode.INVALID_INPUT,
      `Cannot complete milestone in ${milestone.status} state`,
      400
    );
  }

  // Update status
  milestone.status = 'completed';
  milestone.completedAt = new Date();
  milestone.completedBy = new Types.ObjectId(userId);
  await project.save();

  // ✅ Return with availableActions
  const isOwner = project.ownerId.toString() === userId;
  const isMember = project.teamMemberIds.some(id => id.toString() === userId);

  const milestoneDTO = MilestoneMapper.toDTO(
    milestone,
    req.user!.role,
    isMember,
    isOwner
  );

  return ResponseBuilder.success(res, milestoneDTO, 200);
};
```

**Task-30 (Approve/Dispute Milestone):**
```typescript
export const approveMilestoneController = async (req: Request, res: Response) => {
  const { projectId, milestoneId } = req.params;
  const userId = req.user!.sub;

  const project = await ProjectModel.findById(projectId);
  const milestone = project.milestones.id(milestoneId);

  // State validation
  if (milestone.status !== 'completed') {
    return ResponseBuilder.error(
      res,
      ErrorCode.INVALID_INPUT,
      'Only completed milestones can be approved',
      400,
      [{ field: 'status', reason: `Current status is ${milestone.status}` }]
    );
  }

  // Authorization check
  const isOwner = project.ownerId.toString() === userId;
  const isAdmin = req.user!.role === 'admin';
  if (!isOwner && !isAdmin) {
    return ResponseBuilder.forbidden('Only project owner or admin can approve milestones');
  }

  // Update status
  milestone.status = 'approved';
  milestone.approvedAt = new Date();
  milestone.approvedBy = new Types.ObjectId(userId);
  await project.save();

  // ✅ Return with new availableActions (should be empty for approved)
  const milestoneDTO = MilestoneMapper.toDTO(
    milestone,
    req.user!.role,
    true,
    isOwner
  );

  return ResponseBuilder.success(res, milestoneDTO, 200);
};
```

### State Transition Diagram

```
pending → [fund] → funded → [start] → in_progress → [complete] → completed
                                                                     ↓
                                                         [approve] → approved ✅
                                                                     ↓
                                                         [dispute] → disputed
                                                                     ↓
                                                         [resolve] → approved/rejected
```

### Key Takeaways

✅ **availableActions[]** explicitly tells frontend what's valid  
✅ **State machine** prevents invalid transitions  
✅ **Role-based actions** (member vs owner vs admin)  
✅ **Frontend can disable buttons** based on availableActions  
✅ **Backend validates** before state change  

---

## Lines 781-920: Pagination Standard
**Referenced by Tasks**: 10, 15, 22, 23, 37, 38, 70, 71

### Problem Statement

All paginated endpoints return:
```json
{
  "meta": { "page": 1, "per_page": 20, "total": 150, "total_pages": 10 },
  "data": [...]
}
```

**Missing:**
- `has_next` - Does next page exist?
- `has_prev` - Does previous page exist?
- `next_cursor` - For cursor-based pagination (future)

**Result:** Frontend calculates these manually (error-prone!)

### Solution: PaginatedResponse Wrapper

#### Step 1: Define Types (`src/types/pagination-dtos.ts`)

```typescript
export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface PaginationMeta {
  page: number;                 // Current page (1-indexed)
  per_page: number;             // Items per page
  total_items: number;          // Total across all pages
  total_pages: number;          // Calculated pages
  has_next: boolean;            // ✅ Convenience flag
  has_prev: boolean;            // ✅ Convenience flag
  next_cursor?: string;         // For cursor pagination (optional)
  prev_cursor?: string;
}

export interface PaginationQuery {
  page?: number;                // Default: 1
  per_page?: number;            // Default: 20, Max: 100
  cursor?: string;
}
```

#### Step 2: Create Helper Functions

```typescript
export function buildPaginationMeta(
  page: number,
  perPage: number,
  totalItems: number,
  options?: { nextCursor?: string; prevCursor?: string }
): PaginationMeta {
  const totalPages = Math.ceil(totalItems / perPage);
  
  return {
    page,
    per_page: perPage,
    total_items: totalItems,
    total_pages: totalPages,
    has_next: page < totalPages,        // ✅ Auto-calculated
    has_prev: page > 1,                 // ✅ Auto-calculated
    next_cursor: options?.nextCursor,
    prev_cursor: options?.prevCursor,
  };
}

export function paginatedResponse<T>(
  data: T[],
  page: number,
  perPage: number,
  totalItems: number,
  options?: { nextCursor?: string; prevCursor?: string }
): PaginatedResponse<T> {
  return {
    data,
    pagination: buildPaginationMeta(page, perPage, totalItems, options),
  };
}
```

#### Step 3: Add to ResponseBuilder

```typescript
// In src/utils/response-builder.ts

export class ResponseBuilder {
  // ... other methods ...

  /**
   * Sends a paginated response
   */
  static paginated<T>(
    res: Response,
    data: T[],
    page: number,
    perPage: number,
    totalItems: number,
    statusCode: number = 200
  ): void {
    const response = paginatedResponse(data, page, perPage, totalItems);
    res.status(statusCode).json(response);
  }
}
```

#### Step 4: Usage in Controllers

**Task-10 (Creator Directory):**
```typescript
export const searchCreatorsController = async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const perPage = Math.min(parseInt(req.query.per_page as string) || 20, 100);

  const { creators, total } = await discoveryService.searchCreators({
    ...req.query,
    page,
    perPage,
  });

  // Map to DTOs
  const creatorDTOs = creators.map(({ user, profile }) => 
    UserDTOMapper.toCreatorDTO(user, profile)
  );

  // ✅ Use ResponseBuilder.paginated (includes has_next/has_prev)
  return ResponseBuilder.paginated(res, creatorDTOs, page, perPage, total, 200);
};

// Frontend receives:
// {
//   "data": [...],
//   "pagination": {
//     "page": 1,
//     "per_page": 20,
//     "total_items": 150,
//     "total_pages": 8,
//     "has_next": true,    ← ✅ No manual calculation!
//     "has_prev": false    ← ✅ No manual calculation!
//   }
// }
```

**Task-15 (Project Listing):**
```typescript
export const listProjectsController = async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const perPage = Math.min(parseInt(req.query.per_page as string) || 20, 100);

  const { projects, total } = await projectService.listProjects({
    ...req.query,
    page,
    perPage,
  });

  const projectDTOs = projects.map(project => ({
    projectId: project._id!.toString(),
    title: project.title,
    status: project.status,
    ownerId: project.ownerId.toString(),
    rolesSummary: project.roles.map(r => ({
      title: r.title,
      slots: r.slots,
      filled: r.assignedUserIds.length,
    })),
    createdAt: project.createdAt!.toISOString(),
  }));

  // ✅ Standardized pagination
  return ResponseBuilder.paginated(res, projectDTOs, page, perPage, total, 200);
};
```

### Frontend Usage Example

```typescript
// Frontend can now use has_next/has_prev directly
const response = await api.searchCreators({ page: 2 });

console.log(`Page ${response.pagination.page} of ${response.pagination.total_pages}`);

// Enable/disable navigation buttons
nextButton.disabled = !response.pagination.has_next;
prevButton.disabled = !response.pagination.has_prev;
```

### Key Takeaways

✅ **Always use ResponseBuilder.paginated()** for list endpoints  
✅ **has_next/has_prev** auto-calculated  
✅ **Consistent structure** across all endpoints  
✅ **Future-ready** for cursor pagination (next_cursor)  
✅ **Max per_page** enforced (100 items)  

---

## Lines 921-1080: Error Handling Standard
**Referenced by**: ALL TASKS

### Problem Statement

Current tasks return errors in different shapes:
```javascript
// Task-1
{ error: { code: 'email_exists', message: '...' } }

// Task-12
{ error: { code: 'validation_error', message: '...', details: [...] } }

// Task-30
{ error: { code: 'milestone_not_complete', message: '...' } }
```

**Inconsistent structure makes frontend error handling complex!**

### Solution: Standardized APIErrorResponse

#### Step 1: Define Error Types (`src/types/error-dtos.ts`)

```typescript
export interface APIErrorResponse {
  error: {
    code: string;               // Machine-readable (e.g., 'email_exists')
    message: string;            // Human-readable
    details?: ErrorDetail[];    // Optional field-level errors
    requestId?: string;         // For debugging/support
    timestamp: string;          // ISO 8601
    documentation?: string;     // Link to docs
  };
}

export interface ErrorDetail {
  field?: string;               // 'email', 'roles[0].slots'
  reason: string;               // Why this field failed
  value?: any;                  // The invalid value (redacted for sensitive)
}

export enum ErrorCode {
  // Auth errors
  UNAUTHORIZED = 'unauthorized',
  INVALID_CREDENTIALS = 'invalid_credentials',
  PERMISSION_DENIED = 'permission_denied',
  TOKEN_EXPIRED = 'token_expired',
  TOKEN_INVALID = 'token_invalid',
  
  // Validation errors
  VALIDATION_ERROR = 'validation_error',
  INVALID_INPUT = 'invalid_input',
  MISSING_FIELD = 'missing_field',
  
  // Resource errors
  NOT_FOUND = 'not_found',
  ALREADY_EXISTS = 'already_exists',
  CONFLICT = 'conflict',
  
  // Business logic errors
  INSUFFICIENT_BALANCE = 'insufficient_balance',
  MILESTONE_NOT_COMPLETE = 'milestone_not_complete',
  ROLE_CAPACITY_EXCEEDED = 'role_capacity_exceeded',
  
  // System errors
  INTERNAL_SERVER_ERROR = 'internal_server_error',
  SERVICE_UNAVAILABLE = 'service_unavailable',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
}
```

#### Step 2: ResponseBuilder Error Methods

```typescript
// In src/utils/response-builder.ts

export class ResponseBuilder {
  /**
   * Generic error response
   */
  static error(
    res: Response,
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: ErrorDetail[]
  ): void {
    const errorResponse: APIErrorResponse = {
      error: {
        code,
        message,
        details,
        timestamp: new Date().toISOString(),
        requestId: (res.req as any).id, // From tracing middleware
      },
    };
    res.status(statusCode).json(errorResponse);
  }

  /**
   * 404 Not Found shortcut
   */
  static notFound(res: Response, resource: string = 'Resource'): void {
    this.error(
      res,
      ErrorCode.NOT_FOUND,
      `${resource} not found`,
      404
    );
  }

  /**
   * 401 Unauthorized shortcut
   */
  static unauthorized(res: Response, message: string = 'Authentication required'): void {
    this.error(
      res,
      ErrorCode.UNAUTHORIZED,
      message,
      401
    );
  }

  /**
   * 403 Forbidden shortcut
   */
  static forbidden(res: Response, message: string = 'Permission denied'): void {
    this.error(
      res,
      ErrorCode.PERMISSION_DENIED,
      message,
      403
    );
  }

  /**
   * 422 Validation Error
   */
  static validationError(
    res: Response,
    details: ErrorDetail[]
  ): void {
    this.error(
      res,
      ErrorCode.VALIDATION_ERROR,
      'Input validation failed',
      422,
      details
    );
  }
}
```

#### Step 3: Usage in Controllers

**Simple Error:**
```typescript
if (!user) {
  return ResponseBuilder.notFound(res, 'User');
}
// Returns: { error: { code: 'not_found', message: 'User not found', timestamp: '...' } }
```

**Authorization Error:**
```typescript
if (project.ownerId.toString() !== userId) {
  return ResponseBuilder.forbidden(res, 'Only project owner can perform this action');
}
```

**Validation Error with Details:**
```typescript
const errors = validationResult(req);
if (!errors.isEmpty()) {
  return ResponseBuilder.validationError(
    res,
    errors.array().map(err => ({
      field: err.type === 'field' ? (err as any).path : undefined,
      reason: err.msg,
    }))
  );
}
// Returns:
// {
//   error: {
//     code: 'validation_error',
//     message: 'Input validation failed',
//     details: [
//       { field: 'email', reason: 'Email must be valid' },
//       { field: 'password', reason: 'Password must be at least 8 characters' }
//     ],
//     timestamp: '...'
//   }
// }
```

**Business Logic Error:**
```typescript
if (milestone.status !== 'completed') {
  return ResponseBuilder.error(
    res,
    ErrorCode.MILESTONE_NOT_COMPLETE,
    'Only completed milestones can be approved',
    400,
    [{ field: 'status', reason: `Current status is ${milestone.status}` }]
  );
}
```

#### Step 4: Global Error Handler Middleware

```typescript
// src/middleware/error-handler.ts

import { Request, Response, NextFunction } from 'express';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';
import { Logger } from '../utils/logger';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = (req as any).id || 'unknown';

  // Log error (with PII redaction)
  if (err.statusCode >= 500) {
    Logger.error('Internal server error', {
      requestId,
      error: err.message,
      stack: err.stack,
      path: req.path,
    });
  } else {
    Logger.warn('Client error', {
      requestId,
      errorCode: err.code,
      message: err.message,
      path: req.path,
    });
  }

  // Handle specific error types
  if (err.name === 'ValidationError') {
    return ResponseBuilder.validationError(
      res,
      Object.keys(err.errors || {}).map(field => ({
        field,
        reason: err.errors[field].message,
      }))
    );
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0];
    return ResponseBuilder.error(
      res,
      ErrorCode.ALREADY_EXISTS,
      `${field} already exists`,
      409,
      [{ field, reason: 'Duplicate value' }]
    );
  }

  if (err.name === 'JsonWebTokenError') {
    return ResponseBuilder.unauthorized(res, 'Invalid authentication token');
  }

  if (err.name === 'TokenExpiredError') {
    return ResponseBuilder.unauthorized(res, 'Authentication token has expired');
  }

  // Fallback
  return ResponseBuilder.error(
    res,
    ErrorCode.INTERNAL_SERVER_ERROR,
    'An unexpected error occurred',
    500
  );
}
```

### Key Takeaways

✅ **Always use ResponseBuilder** for errors  
✅ **Consistent structure** across all endpoints  
✅ **Field-level details** for validation errors  
✅ **Request ID** for debugging  
✅ **Timestamp** for logging  
✅ **Global handler** catches unhandled errors  

---

## Lines 1081-1200: Serialization Standard
**Referenced by**: ALL TASKS

### Problem Statement

MongoDB documents contain:
- **ObjectIds** (BSON type, not strings)
- **Date objects** (not ISO strings)
- **Subdocuments** with nested ObjectIds

**Frontend receives invalid types → parse errors!**

### Solution: Auto-Serialization Utilities

#### Step 1: Serialization Functions (`src/utils/serialize.ts`)

```typescript
import { Types } from 'mongoose';

/**
 * Recursively serializes MongoDB documents:
 * - ObjectIds → strings
 * - Dates → ISO 8601 strings
 * - Nested documents → plain objects
 */
export function serializeDocument<T = any>(doc: any): T {
  if (!doc) return doc;
  
  // Handle Mongoose documents (.toObject())
  const obj = doc.toObject ? doc.toObject() : doc;
  
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    // Convert ObjectIds
    if (value && (value._bsontype === 'ObjectID' || value instanceof Types.ObjectId)) {
      return value.toString();
    }
    
    // Convert Dates
    if (value instanceof Date) {
      return value.toISOString();
    }
    
    return value;
  }));
}

/**
 * Ensures all ObjectId references are strings
 */
export function stringifyIds<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  
  const result: any = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Types.ObjectId || (value && (value as any)._bsontype === 'ObjectID')) {
      result[key] = value.toString();
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => 
        (item instanceof Types.ObjectId) ? item.toString() : stringifyIds(item)
      );
    } else if (value && typeof value === 'object') {
      result[key] = stringifyIds(value);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * Converts all Date fields to ISO 8601 strings
 */
export function serializeDates(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  
  const result: any = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Date) {
      result[key] = value.toISOString();
    } else if (value && typeof value === 'object') {
      result[key] = serializeDates(value);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}
```

#### Step 2: ResponseBuilder Integration

```typescript
// In src/utils/response-builder.ts

import { serializeDocument } from './serialize';

export class ResponseBuilder {
  /**
   * Sends success response with automatic serialization
   */
  static success<T>(res: Response, data: T, statusCode: number = 200): void {
    const serialized = serializeDocument(data);  // ✅ Auto-convert ObjectIds/Dates
    res.status(statusCode).json(serialized);
  }

  // ... other methods also use serializeDocument internally ...
}
```

#### Step 3: Usage Examples

**Automatic (via ResponseBuilder):**
```typescript
const project = await ProjectModel.findById(projectId);

// ❌ BAD: ObjectIds and Dates leak
return res.status(200).json(project);

// ✅ GOOD: ResponseBuilder auto-serializes
return ResponseBuilder.success(res, project, 200);
// Frontend receives all strings, no BSON types
```

**Manual (for service layer):**
```typescript
export class ProjectService {
  async getProject(projectId: string): Promise<any> {
    const project = await ProjectModel.findById(projectId);
    
    // ✅ Serialize before returning from service
    return serializeDocument(project);
  }
}
```

**Complex Nested Objects:**
```typescript
const response = {
  project: {
    _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
    ownerId: new Types.ObjectId('507f191e810c19729de860ea'),
    createdAt: new Date('2025-10-30T12:00:00Z'),
    roles: [
      {
        _id: new Types.ObjectId('507f191e810c19729de860eb'),
        assignedUserIds: [new Types.ObjectId('507f191e810c19729de860ec')]
      }
    ]
  }
};

const serialized = serializeDocument(response);
// All ObjectIds → strings
// All Dates → ISO 8601 strings
// ✅ Safe to send to frontend
```

### Key Takeaways

✅ **Always use ResponseBuilder** (auto-serializes)  
✅ **Never send raw Mongoose docs** to frontend  
✅ **serializeDocument()** handles nested objects  
✅ **All ObjectIds → strings** automatically  
✅ **All Dates → ISO 8601** automatically  

---

## Lines 1201-1400: Asset Management Patterns
**Referenced by Tasks**: 16, 17, 19, 20

### Problem Statement

Task-19 and Task-20 don't return processing status:
- Is the asset ready to download?
- Is it still processing?
- Did processing fail?

**Frontend doesn't know when to poll or show errors!**

### Solution: Asset DTOs with Processing Status

#### Step 1: Define Asset Types (`src/types/asset-dtos.ts`)

```typescript
export type AssetProcessingStatus = 'pending' | 'processing' | 'ready' | 'failed';

/**
 * Asset upload initiation response (Step 1)
 */
export interface AssetUploadInitDTO {
  sessionId: string;
  uploadUrl: string;            // Pre-signed URL
  storageKey: string;
  expiresAt: string;
  maxFileSize: number;
  allowedMimeTypes: string[];
}

/**
 * Asset registration request (Step 2)
 */
export interface AssetRegisterRequestDTO {
  sessionId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
}

/**
 * Asset registration response (Step 2)
 */
export interface AssetRegisterResponseDTO {
  assetId: string;
  status: AssetProcessingStatus;  // ✅ Explicit status
  processingJobId?: string;
  pollUrl: string;                // ✅ Where to check status
  estimatedProcessingTime?: number; // Seconds
  createdAt: string;
}

/**
 * Asset detail DTO
 */
export interface AssetDetailDTO {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  status: AssetProcessingStatus;
  downloadUrl?: string;           // Only if status === 'ready'
  downloadUrlExpiresAt?: string;
  versionsCount: number;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Asset processing status (for polling)
 */
export interface AssetStatusDTO {
  assetId: string;
  status: AssetProcessingStatus;
  progress?: number;              // 0-100
  error?: string;
  processingStartedAt?: string;
  processingCompletedAt?: string;
}
```

#### Step 2: Create Asset Mapper

```typescript
export class AssetMapper {
  static toDetailDTO(asset: IAsset, includeDownloadUrl: boolean = false): AssetDetailDTO {
    return {
      assetId: asset._id!.toString(),
      filename: asset.filename,
      mimeType: asset.mimeType,
      size: asset.size,
      sha256: asset.sha256,
      status: asset.processingStatus || 'ready',
      downloadUrl: includeDownloadUrl && asset.processingStatus === 'ready'
        ? generateDownloadUrl(asset._id!.toString())
        : undefined,
      downloadUrlExpiresAt: includeDownloadUrl
        ? new Date(Date.now() + 3600000).toISOString()  // 1 hour
        : undefined,
      versionsCount: asset.versions?.length || 1,
      uploadedBy: asset.uploadedBy.toString(),
      createdAt: asset.createdAt!.toISOString(),
      updatedAt: asset.updatedAt!.toISOString(),
    };
  }

  static toStatusDTO(asset: IAsset): AssetStatusDTO {
    return {
      assetId: asset._id!.toString(),
      status: asset.processingStatus || 'ready',
      progress: asset.processingProgress,
      error: asset.processingError,
      processingStartedAt: asset.processingStartedAt?.toISOString(),
      processingCompletedAt: asset.processingCompletedAt?.toISOString(),
    };
  }

  static toRegisterResponseDTO(asset: IAsset): AssetRegisterResponseDTO {
    return {
      assetId: asset._id!.toString(),
      status: asset.processingStatus || 'pending',
      processingJobId: asset.processingJobId,
      pollUrl: `/api/v1/assets/${asset._id}/status`,
      estimatedProcessingTime: estimateProcessingTime(asset.mimeType, asset.size),
      createdAt: asset.createdAt!.toISOString(),
    };
  }
}

function estimateProcessingTime(mimeType: string, size: number): number {
  if (mimeType.startsWith('video/')) {
    return Math.ceil(size / 1000000) * 5;  // ~5 seconds per MB
  }
  if (mimeType.startsWith('image/')) {
    return 10;  // ~10 seconds
  }
  return 5;  // Default
}
```

#### Step 3: Usage in Controllers

**Task-19 (Register Asset):**
```typescript
export const registerAssetController = async (req: Request, res: Response) => {
  const { sessionId, filename, mimeType, size, sha256 } = req.body;
  const userId = req.user!.sub;

  // Create asset record
  const asset = await AssetModel.create({
    uploadedBy: new Types.ObjectId(userId),
    filename,
    mimeType,
    size,
    sha256,
    processingStatus: 'pending',
  });

  // Trigger async processing job
  await queueProcessingJob(asset._id!.toString());

  // ✅ Return with processing status and poll URL
  const responseDTO = AssetMapper.toRegisterResponseDTO(asset);
  return ResponseBuilder.success(res, responseDTO, 201);
};

// Frontend receives:
// {
//   "assetId": "...",
//   "status": "pending",
//   "pollUrl": "/api/v1/assets/.../status",
//   "estimatedProcessingTime": 30,
//   "createdAt": "..."
// }
```

**Task-20 (Get Asset Status - for polling):**
```typescript
export const getAssetStatusController = async (req: Request, res: Response) => {
  const { assetId } = req.params;
  const asset = await AssetModel.findById(assetId);

  if (!asset) {
    return ResponseBuilder.notFound(res, 'Asset');
  }

  // ✅ Return current processing status
  const statusDTO = AssetMapper.toStatusDTO(asset);
  return ResponseBuilder.success(res, statusDTO, 200);
};

// Frontend can poll this endpoint until status === 'ready' or 'failed'
```

**Task-20 (Download Asset):**
```typescript
export const getAssetController = async (req: Request, res: Response) => {
  const { assetId } = req.params;
  const asset = await AssetModel.findById(assetId);

  if (!asset) {
    return ResponseBuilder.notFound(res, 'Asset');
  }

  // ✅ Check processing status
  if (asset.processingStatus !== 'ready') {
    return ResponseBuilder.error(
      res,
      ErrorCode.INVALID_INPUT,
      `Asset is ${asset.processingStatus}. Cannot download yet.`,
      400,
      [{ field: 'status', reason: `Current status: ${asset.processingStatus}` }]
    );
  }

  const assetDTO = AssetMapper.toDetailDTO(asset, true);  // Include download URL
  return ResponseBuilder.success(res, assetDTO, 200);
};
```

### Frontend Polling Pattern

```typescript
// Frontend code
async function uploadAndWaitForProcessing(file: File) {
  // Step 1: Register asset
  const registerResponse = await api.registerAsset({
    sessionId,
    filename: file.name,
    // ...
  });

  console.log(`Asset ${registerResponse.assetId} is ${registerResponse.status}`);
  console.log(`Estimated time: ${registerResponse.estimatedProcessingTime}s`);

  // Step 2: Poll status until ready
  let status = registerResponse.status;
  while (status === 'pending' || status === 'processing') {
    await sleep(2000);  // Wait 2 seconds
    
    const statusResponse = await api.getAssetStatus(registerResponse.assetId);
    status = statusResponse.status;
    
    console.log(`Progress: ${statusResponse.progress}%`);
  }

  if (status === 'failed') {
    throw new Error(`Processing failed: ${statusResponse.error}`);
  }

  // Step 3: Asset is ready, get download URL
  const assetDetail = await api.getAsset(registerResponse.assetId);
  return assetDetail.downloadUrl;
}
```

### Key Takeaways

✅ **Always return processing status** for assets  
✅ **Provide pollUrl** for status checking  
✅ **estimatedProcessingTime** for better UX  
✅ **Block downloads** until status === 'ready'  
✅ **Return progress percentage** during processing  

---

## Lines 1401-1600: Notification Patterns
**Referenced by Tasks**: 11, 47, 48, 49, 50

### Problem Statement

Task-11 and Task-50 store notifications with different content per channel:
- In-app: title + body + action URL
- Email: subject + HTML + text
- Push: title + body + icon + badge

**But responses mix these structures!**

### Solution: Channel-Specific DTOs

#### Step 1: Define Notification Types (`src/types/notification-dtos.ts`)

```typescript
export interface NotificationBaseDTO {
  notificationId: string;
  userId: string;
  type: string;                 // "project_invite", "milestone_approved", etc.
  read: boolean;
  createdAt: string;
}

/**
 * In-app notification
 */
export interface InAppNotificationDTO extends NotificationBaseDTO {
  channel: 'in_app';
  content: {
    title: string;
    body: string;
    actionUrl?: string;
    metadata?: Record<string, any>;
  };
}

/**
 * Email notification
 */
export interface EmailNotificationDTO extends NotificationBaseDTO {
  channel: 'email';
  content: {
    subject: string;
    previewText: string;        // First 100 chars
    htmlBody: string;
    textBody?: string;
  };
  recipient: string;            // Email address
}

/**
 * Push notification
 */
export interface PushNotificationDTO extends NotificationBaseDTO {
  channel: 'push';
  content: {
    title: string;
    body: string;
    icon?: string;
    badge?: number;
    actionUrl?: string;
  };
}

export type NotificationDTO = InAppNotificationDTO | EmailNotificationDTO | PushNotificationDTO;
```

#### Step 2: Create Notification Mapper

```typescript
export class NotificationMapper {
  static toDTO(
    notification: INotification,
    channel: 'in_app' | 'email' | 'push'
  ): NotificationDTO {
    const base = {
      notificationId: notification._id!.toString(),
      userId: notification.userId.toString(),
      type: notification.type,
      read: notification.read || false,
      createdAt: notification.createdAt!.toISOString(),
    };

    if (channel === 'in_app') {
      return {
        ...base,
        channel: 'in_app',
        content: {
          title: notification.content.in_app?.title || '',
          body: notification.content.in_app?.body || '',
          actionUrl: notification.content.in_app?.metadata?.actionUrl,
          metadata: notification.content.in_app?.metadata,
        },
      } as InAppNotificationDTO;
    }

    if (channel === 'email') {
      return {
        ...base,
        channel: 'email',
        content: {
          subject: notification.content.email?.subject || '',
          previewText: notification.content.email?.text?.substring(0, 100) || '',
          htmlBody: notification.content.email?.html || '',
          textBody: notification.content.email?.text,
        },
        recipient: notification.recipientEmail || '',
      } as EmailNotificationDTO;
    }

    // Push
    return {
      ...base,
      channel: 'push',
      content: {
        title: notification.content.push?.title || '',
        body: notification.content.push?.body || '',
        icon: notification.content.push?.icon,
        badge: notification.content.push?.badge,
        actionUrl: notification.content.push?.actionUrl,
      },
    } as PushNotificationDTO;
  }

  /**
   * Maps to in-app DTO (most common)
   */
  static toInAppDTO(notification: INotification): InAppNotificationDTO {
    return this.toDTO(notification, 'in_app') as InAppNotificationDTO;
  }
}
```

#### Step 3: Usage in Controllers

**Task-47 (User Inbox - In-App Notifications):**
```typescript
export const getUserNotificationsController = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const page = parseInt(req.query.page as string) || 1;
  const perPage = 20;

  const [notifications, total] = await Promise.all([
    NotificationModel.find({ userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage),
    NotificationModel.countDocuments({ userId }),
  ]);

  // ✅ Map to in-app DTOs
  const notificationDTOs = notifications.map(n => 
    NotificationMapper.toInAppDTO(n)
  );

  return ResponseBuilder.paginated(res, notificationDTOs, page, perPage, total, 200);
};

// Frontend receives:
// {
//   "data": [
//     {
//       "notificationId": "...",
//       "channel": "in_app",
//       "content": {
//         "title": "New Project Invite",
//         "body": "You've been invited to 'Film Project'",
//         "actionUrl": "/projects/123"
//       },
//       "read": false,
//       "createdAt": "..."
//     }
//   ],
//   "pagination": { ... }
// }
```

**Task-50 (Send Notification - Multi-Channel):**
```typescript
export const sendNotificationController = async (req: Request, res: Response) => {
  const { templateId, recipients, variables, channels } = req.body;

  const notifications = await notificationService.sendFromTemplate({
    templateId,
    recipients,
    variables,
    channels: channels || ['in_app'],  // Default to in-app
  });

  // ✅ Return appropriate DTO per channel
  const notificationDTOs = notifications.map(n => {
    const channel = n.channels[0];  // Primary channel
    return NotificationMapper.toDTO(n, channel);
  });

  return ResponseBuilder.success(res, { notifications: notificationDTOs }, 200);
};
```

### Key Takeaways

✅ **Channel-specific content** structures  
✅ **Discriminated unions** (channel: 'in_app' | 'email' | 'push')  
✅ **Type-safe frontend** (TypeScript knows content shape)  
✅ **toInAppDTO()** shortcut for common case  

---

## Lines 1601-1750: Money & Currency Patterns
**Referenced by Tasks**: 24, 35, 36, 37, 38, 39, 40

### Problem Statement

Money amounts appear in different formats:
```javascript
amount: 1234          // Is this cents or dollars?
amount: 12.34         // Float (loses precision!)
currency: 'USD'       // Sometimes present, sometimes not
```

**Result: Currency conversion bugs, display issues!**

### Solution: Standardized MoneyAmount Interface

#### Step 1: Money Type Definition

```typescript
// Already defined in user-dtos.ts, but repeated here for clarity

export interface MoneyAmount {
  amount: number;       // ALWAYS in smallest currency unit (cents, pence, etc.)
  currency: string;     // ISO 4217 code (USD, EUR, GBP, JPY, etc.)
  display: string;      // Human-readable: "$12.34", "€10,00", "¥1,234"
}
```

#### Step 2: Money Formatting Utilities

```typescript
/**
 * Formats cents to MoneyAmount object
 */
export function formatMoneyAmount(cents: number, currency: string = 'USD'): MoneyAmount {
  return {
    amount: cents,
    currency,
    display: formatMoney(cents, currency),
  };
}

/**
 * Formats cents to localized string
 */
function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  });
  return formatter.format(amount);
}

/**
 * Parses user input (e.g., "12.34") to cents
 */
export function parseMoney(displayAmount: string | number): number {
  const amount = typeof displayAmount === 'string' 
    ? parseFloat(displayAmount) 
    : displayAmount;
  return Math.round(amount * 100);  // Convert to cents
}

/**
 * Adds two money amounts (same currency)
 */
export function addMoney(a: MoneyAmount, b: MoneyAmount): MoneyAmount {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} and ${b.currency}`);
  }
  return formatMoneyAmount(a.amount + b.amount, a.currency);
}
```

#### Step 3: Usage in Controllers

**Task-12 (Project Creation with Budget):**
```typescript
export const createProjectController = async (req: Request, res: Response) => {
  // User sends: { totalBudget: 5000.00, currency: 'USD' }
  const budgetCents = parseMoney(req.body.totalBudget);  // Convert to cents

  const project = await ProjectModel.create({
    ...req.body,
    totalBudget: budgetCents,  // Store as cents
    currency: req.body.currency || 'USD',
  });

  return ResponseBuilder.success(res, {
    projectId: project._id!.toString(),
    totalBudget: formatMoneyAmount(project.totalBudget, project.currency),
    // Response: { amount: 500000, currency: 'USD', display: '$5,000.00' }
  }, 201);
};
```

**Task-24 (Fund Milestone):**
```typescript
export const fundMilestoneController = async (req: Request, res: Response) => {
  const { projectId, milestoneId } = req.params;
  const { amount } = req.body;  // User sends dollars

  const amountCents = parseMoney(amount);  // Convert to cents

  // Validate user balance
  const user = await UserModel.findById(req.user!.sub);
  if (user.balance < amountCents) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INSUFFICIENT_BALANCE,
      'Insufficient balance to fund milestone',
      400,
      [{
        field: 'amount',
        reason: `Required: ${formatMoney(amountCents, 'USD')}, Available: ${formatMoney(user.balance, 'USD')}`
      }]
    );
  }

  // Update milestone
  const project = await ProjectModel.findById(projectId);
  const milestone = project.milestones.id(milestoneId);
  milestone.status = 'funded';
  milestone.fundedAmount = amountCents;
  await project.save();

  return ResponseBuilder.success(res, {
    milestoneId: milestone._id!.toString(),
    status: milestone.status,
    fundedAmount: formatMoneyAmount(amountCents, 'USD'),
  }, 200);
};
```

**Task-37 (Transaction History):**
```typescript
export const getTransactionsController = async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const transactions = await TransactionModel.find({ userId });

  const transactionDTOs = transactions.map(txn => ({
    transactionId: txn._id!.toString(),
    type: txn.type,
    amount: formatMoneyAmount(txn.amount, txn.currency),  // ✅ Consistent format
    status: txn.status,
    createdAt: txn.createdAt!.toISOString(),
  }));

  return ResponseBuilder.success(res, { transactions: transactionDTOs }, 200);
};

// Frontend receives:
// {
//   "transactions": [
//     {
//       "transactionId": "...",
//       "amount": {
//         "amount": 500000,
//         "currency": "USD",
//         "display": "$5,000.00"
//       }
//     }
//   ]
// }
```

### Currency-Specific Formatting

```typescript
// USD: $1,234.56
formatMoneyAmount(123456, 'USD');
// { amount: 123456, currency: 'USD', display: '$1,234.56' }

// EUR: €1.234,56
formatMoneyAmount(123456, 'EUR');
// { amount: 123456, currency: 'EUR', display: '€1.234,56' }

// JPY: ¥1,235 (no decimals)
formatMoneyAmount(123456, 'JPY');
// { amount: 123456, currency: 'JPY', display: '¥1,235' }

// GBP: £1,234.56
formatMoneyAmount(123456, 'GBP');
// { amount: 123456, currency: 'GBP', display: '£1,234.56' }
```

### Key Takeaways

✅ **ALWAYS store in cents** (smallest unit)  
✅ **ALWAYS use MoneyAmount** interface in responses  
✅ **Use Intl.NumberFormat** for localization  
✅ **parseMoney()** for user input  
✅ **Never use floats** for money (precision loss!)  

---

## Lines 1751-1900: Standard Response Patterns
**Referenced by**: ALL TASKS

### All Response Templates

#### Success Responses

**Simple Success (200 OK):**
```typescript
return ResponseBuilder.success(res, { data }, 200);
```

**Created (201):**
```typescript
return ResponseBuilder.success(res, { resourceId, ...data }, 201);
```

**No Content (204) - for DELETE or logout:**
```typescript
return res.status(204).send();
```

#### Error Responses

**Validation Error (422):**
```typescript
return ResponseBuilder.validationError(res, [
  { field: 'email', reason: 'Email must be valid' },
  { field: 'password', reason: 'Password too short' },
]);
```

**Not Found (404):**
```typescript
return ResponseBuilder.notFound(res, 'Resource');
```

**Unauthorized (401):**
```typescript
return ResponseBuilder.unauthorized(res);
```

**Forbidden (403):**
```typescript
return ResponseBuilder.forbidden(res, 'Only project owner can perform this action');
```

**Conflict (409):**
```typescript
return ResponseBuilder.error(
  res,
  ErrorCode.ALREADY_EXISTS,
  'Email already registered',
  409
);
```

**Internal Server Error (500):**
```typescript
return ResponseBuilder.error(
  res,
  ErrorCode.INTERNAL_SERVER_ERROR,
  'An unexpected error occurred',
  500
);
```

---

## Lines 1901-2050: Validation Patterns
**Referenced by**: ALL TASKS

### Input Validation

#### Step 1: Password Validation Rules

```typescript
// src/utils/validation.ts

import { body } from 'express-validator';

export const passwordValidationRules = [
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number')
    .matches(/[!@#$%^&*(),.?":{}|<>]/)
    .withMessage('Password must contain at least one special character'),
];

export function validatePasswordStrength(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[!@#$%^&*(),.?":{}|<>]/.test(password)
  );
}
```

#### Step 2: Common Validation Rules

```typescript
export const emailValidationRules = [
  body('email')
    .isEmail()
    .withMessage('Email must be valid')
    .normalizeEmail(),
];

export const mongoIdValidationRules = (field: string) => [
  param(field)
    .isMongoId()
    .withMessage(`${field} must be a valid MongoDB ObjectId`),
];

export const paginationValidationRules = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('page must be a positive integer'),
  query('per_page')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('per_page must be between 1 and 100'),
];
```

#### Step 3: Usage in Controllers

```typescript
import { passwordValidationRules } from '../utils/validation';

export const signupValidation = [
  ...emailValidationRules,
  ...passwordValidationRules,
  body('role')
    .optional()
    .isIn(['creator', 'owner'])
    .withMessage('Role must be creator or owner'),
];

router.post('/signup', signupValidation, signupController);
```

---

## Lines 2051-2150: Final Checklist

### Before Implementing ANY Task

✅ Read this file (Task-105-Master.md) for relevant patterns  
✅ Implement foundation utilities first (serialize, response-builder, etc.)  
✅ Use appropriate DTO mapper (User, Project, Milestone, etc.)  
✅ Always use ResponseBuilder (never res.json())  
✅ Apply serializeDocument() for ObjectIds/Dates  
✅ Use MoneyAmount for all currency values  
✅ Include availableActions for state machines  
✅ Use PaginatedResponse for list endpoints  
✅ Return processing status for async operations  
✅ Use channel-specific DTOs for notifications  

### Quick Decision Tree

**Q: Does this task return user data?**  
→ Yes: Use `UserDTOMapper.toAuthDTO()` / `.toCreatorDTO()` / etc.

**Q: Does this task return a list?**  
→ Yes: Use `ResponseBuilder.paginated()`

**Q: Does this task handle money?**  
→ Yes: Store in cents, return `MoneyAmount`

**Q: Does this task have state transitions?**  
→ Yes: Include `availableActions[]`

**Q: Does this task handle file uploads?**  
→ Yes: Return processing status + poll URL

**Q: Does this task return ObjectIds or Dates?**  
→ Yes: Use `ResponseBuilder.success()` (auto-serializes)

---

## Summary

This file is your **single source of truth** for implementing all 100 backend tasks correctly.

**Remember:**
- Task-N.md = WHAT to build (requirements)
- Task-105.md = HOW to build it (patterns)

**Follow these patterns and every task will be production-ready on the first try!** ✅

