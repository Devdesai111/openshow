# Task-105 Reference Map

**Purpose**: Quick lookup for which tasks need which sections of Task-105-Master.md

---

## How to Add References to Task Files

Add this note **at the top** of each task file (after the title):

```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines X-Y (Topic Name)
```

---

## 🔴 Critical Priority (4 tasks)

### Task-12: Project Management Core
**Add to top of Task-12.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 321-580 (Projects & Revenue Splits)
                   and lines 1601-1750 (Money & Currency)
```
**Topics**: RevenueSplitMapper, ProjectMemberMapper, MoneyAmount formatting

---

### Task-14: Project Milestones CRUD
**Add to top of Task-14.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 581-780 (Milestone State Machine)
```
**Topics**: MilestoneMapper, availableActions, state transitions

---

### Task-15: Project Read & Listing
**Add to top of Task-15.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 321-580 (Projects & Revenue Splits)
                   and lines 781-920 (Pagination)
```
**Topics**: Project DTOs, PaginatedResponse, member details

---

### Task-30: Milestone Approval & Dispute
**Add to top of Task-30.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 581-780 (Milestone State Machine)
```
**Topics**: MilestoneMapper, state validation, availableActions

---

## 🟡 High Priority (15 tasks)

### Auth & User Management

#### Task-1: Authentication Core (Signup/Login)
**Add to top of Task-1.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 80-320 (User DTOs & Authentication)
                   and lines 921-1080 (Error Handling)
```
**Topics**: UserDTOMapper.toAuthDTO, ResponseBuilder, password validation

#### Task-3: OAuth Login/Signup
**Add to top of Task-3.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 80-320 (User DTOs & Authentication)
```
**Topics**: UserDTOMapper.toAuthDTO for OAuth flows

#### Task-4: Token Refresh & /auth/me
**Add to top of Task-4.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 80-320 (User DTOs & Authentication)
```
**Topics**: UserDTOMapper.toAuthDTO, consistent user shape

#### Task-6: Admin User Management
**Add to top of Task-6.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 921-1080 (Error Handling)
                   and lines 80-320 (User DTOs)
```
**Topics**: ResponseBuilder error methods, UserDTOMapper

#### Task-8: User Profile CRUD
**Add to top of Task-8.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 80-320 (User DTOs & Authentication)
```
**Topics**: UserDTOMapper.toCreatorDTO, UserDTOMapper.toPrivateDTO, access control

#### Task-9: Creator Portfolio
**Add to top of Task-9.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1081-1200 (Serialization)
                   and lines 80-320 (User DTOs)
```
**Topics**: serializeDocument, PortfolioItemSummaryDTO

#### Task-10: Creator Directory
**Add to top of Task-10.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 80-320 (User DTOs & Authentication)
                   and lines 781-920 (Pagination)
```
**Topics**: UserDTOMapper.toCreatorDTO, ResponseBuilder.paginated

---

### Project Management

#### Task-13: Project Member Management
**Add to top of Task-13.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 321-580 (Projects & Revenue Splits)
```
**Topics**: ProjectMemberMapper, role assignments

#### Task-22: Project Applications
**Add to top of Task-22.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 781-920 (Pagination)
```
**Topics**: ResponseBuilder.paginated for application lists

#### Task-23: Project Search/Filter
**Add to top of Task-23.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 781-920 (Pagination)
```
**Topics**: ResponseBuilder.paginated for search results

#### Task-24: Milestone Funding
**Add to top of Task-24.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1601-1750 (Money & Currency)
```
**Topics**: MoneyAmount, parseMoney, formatMoneyAmount

---

### Assets

#### Task-16: Asset Upload Initiation
**Add to top of Task-16.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1201-1400 (Asset Management)
```
**Topics**: AssetUploadInitDTO, pre-signed URLs

#### Task-17: Asset Registration
**Add to top of Task-17.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1201-1400 (Asset Management)
```
**Topics**: AssetMapper.toRegisterResponseDTO, processing status

#### Task-19: Asset Upload Flow
**Add to top of Task-19.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1201-1400 (Asset Management)
```
**Topics**: AssetMapper, processing status, pollUrl

#### Task-20: Asset Download & Versioning
**Add to top of Task-20.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1201-1400 (Asset Management)
```
**Topics**: AssetMapper.toDetailDTO, AssetMapper.toStatusDTO

---

## 🟢 Medium Priority (26 tasks)

### Notifications

#### Task-11: Notification Templates
**Add to top of Task-11.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1401-1600 (Notifications)
```
**Topics**: Channel-specific content structures

#### Task-47: User Notifications Inbox
**Add to top of Task-47.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1401-1600 (Notifications)
                   and lines 781-920 (Pagination)
```
**Topics**: NotificationMapper.toInAppDTO, ResponseBuilder.paginated

#### Task-48: Mark Notification as Read
**Add to top of Task-48.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1401-1600 (Notifications)
```
**Topics**: NotificationMapper

#### Task-49: Notification Preferences
**Add to top of Task-49.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 921-1080 (Error Handling)
```
**Topics**: ResponseBuilder

#### Task-50: Notification Dispatch
**Add to top of Task-50.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1401-1600 (Notifications)
```
**Topics**: NotificationMapper with multi-channel support

---

### Payments & Transactions

#### Task-35: Transaction History
**Add to top of Task-35.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1601-1750 (Money & Currency)
                   and lines 781-920 (Pagination)
```
**Topics**: MoneyAmount, formatMoneyAmount, ResponseBuilder.paginated

#### Task-36: Transaction Detail
**Add to top of Task-36.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1601-1750 (Money & Currency)
```
**Topics**: MoneyAmount formatting

#### Task-37: Payout Requests
**Add to top of Task-37.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1601-1750 (Money & Currency)
                   and lines 781-920 (Pagination)
```
**Topics**: MoneyAmount, ResponseBuilder.paginated

#### Task-38: Payout Listing
**Add to top of Task-38.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1601-1750 (Money & Currency)
                   and lines 781-920 (Pagination)
```
**Topics**: MoneyAmount, ResponseBuilder.paginated

#### Task-39: Escrow Status
**Add to top of Task-39.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 1601-1750 (Money & Currency)
```
**Topics**: MoneyAmount formatting

#### Task-40: Payment Method CRUD
**Add to top of Task-40.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 921-1080 (Error Handling)
```
**Topics**: ResponseBuilder

---

### Reviews & Ratings (Tasks 41-46)

#### Task-41 through Task-46
**Add to top of each:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 781-920 (Pagination for lists)
                   and lines 921-1080 (Error Handling)
```
**Topics**: ResponseBuilder.paginated (for lists), ResponseBuilder error methods

---

### Admin Endpoints

#### Task-70: Admin User List
**Add to top of Task-70.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 781-920 (Pagination)
                   and lines 80-320 (User DTOs)
```
**Topics**: ResponseBuilder.paginated, UserDTOMapper

#### Task-71: Admin Project List
**Add to top of Task-71.md:**
```markdown
⚠️ **READ FIRST**: Task-105-Master.md lines 781-920 (Pagination)
                   and lines 321-580 (Project DTOs)
```
**Topics**: ResponseBuilder.paginated, Project DTOs

---

## ✅ No References Needed (55 tasks)

These tasks don't have payload responses or use simple patterns:

- **Task-2**: RBAC middleware (no response payload)
- **Task-5**: Logout (simple 204)
- **Task-7**: Health checks (simple JSON)
- **Task-21, 25-29, 31-34**: Background jobs, internal processing
- **Task-51-69, 72-99**: Various admin, internal, testing, deployment tasks
- **Task-100**: Test suite definition
- **Task-101**: Architectural fixes (utilities)
- **Task-102**: Payload standards (definitions)

---

## 📝 Quick Add Script

To add all references automatically, run:

```bash
# This script adds the reference notes to all 45 task files

#!/bin/bash

# Task-1
sed -i '' '3i\
⚠️ **READ FIRST**: Task-105-Master.md lines 80-320 (User DTOs) and lines 921-1080 (Error Handling)\
\
' Tasks/Task-1.md

# Task-3
sed -i '' '3i\
⚠️ **READ FIRST**: Task-105-Master.md lines 80-320 (User DTOs & Authentication)\
\
' Tasks/Task-3.md

# ... (continue for all 45 tasks)
```

Or add them manually as you implement each task.

---

## 🎯 Implementation Workflow

For each task you're implementing:

1. **Open Task-N.md** - Read business requirements
2. **Check this file** - Find which Task-105 lines to read
3. **Read Task-105** - Study the implementation patterns
4. **Code the task** - Apply the patterns from Task-105
5. **Result** - Production-ready code first time! ✅

---

**Total tasks requiring Task-105 references: 45 out of 100**

**Recommendation**: Add references as you start each task, not all at once. This keeps task files clean and focused.

