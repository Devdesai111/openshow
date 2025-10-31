# Task 102: Payload Standardization & API Contract

**Priority**: 🔴 CRITICAL  
**Dependencies**: All tasks (cross-cutting concern)  
**Deliverable**: Standardized DTOs, serialization utilities, and OpenAPI specification

---

## Overview

This task addresses critical payload inconsistencies across all API endpoints that would cause integration failures. These fixes must be applied BEFORE implementing any task code.

---

## 📦 Part 1: Core Serialization Utilities

### File: `src/utils/serialize.ts`

```typescript
import { Types } from 'mongoose';

/**
 * Recursively serializes MongoDB documents, converting ObjectIds to strings
 * and Dates to ISO strings. Ensures consistent JSON responses.
 */
export function serializeDocument<T = any>(doc: any): T {
  if (!doc) return doc;
  
  // Handle Mongoose documents
  const obj = doc.toObject ? doc.toObject() : doc;
  
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    // Convert ObjectIds to strings
    if (value && value._bsontype === 'ObjectID') {
      return value.toString();
    }
    
    // Convert Dates to ISO strings
    if (value instanceof Date) {
      return value.toISOString();
    }
    
    // Convert Mongoose ObjectIds
    if (value instanceof Types.ObjectId) {
      return value.toString();
    }
    
    return value;
  }));
}

/**
 * Converts all Date fields to ISO 8601 strings.
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

/**
 * Ensures all ObjectId references are strings (never ObjectId instances).
 */
export function stringifyIds<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  
  const result: any = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Types.ObjectId || (value && (value as any)._bsontype === 'ObjectID')) {
      result[key] = value.toString();
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => 
        (item instanceof Types.ObjectId || (item && (item as any)._bsontype === 'ObjectID'))
          ? item.toString()
          : stringifyIds(item)
      );
    } else if (value && typeof value === 'object') {
      result[key] = stringifyIds(value);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}
```

---

## 📦 Part 2: Standardized User DTOs

### File: `src/types/user-dtos.ts`

```typescript
/**
 * Base public user profile (visible to all authenticated users).
 */
export interface UserPublicDTO {
  id: string;
  preferredName: string;
  role: 'creator' | 'owner' | 'admin';
  avatar?: string;
  createdAt: string; // ISO 8601
}

/**
 * Extended user profile (visible only to the user themselves and admins).
 */
export interface UserPrivateDTO extends UserPublicDTO {
  email: string;
  fullName?: string;
  status: 'active' | 'pending' | 'suspended';
  twoFAEnabled: boolean;
  lastSeenAt?: string; // ISO 8601
}

/**
 * Full authenticated user response (for /auth/me and login/signup).
 */
export interface AuthUserDTO extends UserPrivateDTO {
  socialAccounts: Array<{
    provider: string;
    providerId: string;
    connectedAt: string; // ISO 8601
  }>;
}

/**
 * Creator-specific public profile extension.
 */
export interface CreatorProfileDTO extends UserPublicDTO {
  headline?: string;
  bio?: string;
  verified: boolean;
  skills: string[];
  languages: string[];
  portfolio?: PortfolioItemSummaryDTO[];
  rating?: {
    average: number; // 0-5
    count: number;
  };
  hourlyRate?: MoneyAmount;
}

export interface PortfolioItemSummaryDTO {
  itemId: string;
  title: string;
  thumbnailUrl?: string;
  createdAt: string; // ISO 8601
}

/**
 * Money amount with consistent currency representation.
 */
export interface MoneyAmount {
  amount: number; // Always in smallest currency unit (cents, pence, etc.)
  currency: string; // ISO 4217 code (USD, EUR, GBP, etc.)
  display: string; // Human-readable format: "$12.34", "€10,00"
}
```

### Mapper Functions

```typescript
import { IUser } from '../models/User';
import { ICreatorProfile } from '../models/CreatorProfile';
import { serializeDocument } from '../utils/serialize';

export class UserDTOMapper {
  /**
   * Maps User model to public DTO (safe for any authenticated user).
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
   * Maps User model to private DTO (only for self + admins).
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
   * Maps User model to full authenticated DTO (for /auth/me, login, signup).
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
   * Maps User + CreatorProfile to creator-specific DTO.
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

/**
 * Formats money amount for display.
 */
function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
  });
  return formatter.format(amount);
}
```

---

## 📦 Part 3: Standardized Error Response

### File: `src/types/error-dtos.ts`

```typescript
/**
 * Standardized API error response format.
 * ALL errors must conform to this structure.
 */
export interface APIErrorResponse {
  error: {
    code: string; // Machine-readable error code (e.g., "email_exists", "permission_denied")
    message: string; // Human-readable error message
    details?: ErrorDetail[]; // Optional array of field-specific errors
    requestId?: string; // For tracing/debugging
    timestamp: string; // ISO 8601 timestamp
    documentation?: string; // Link to error docs
  };
}

export interface ErrorDetail {
  field?: string; // Field name (e.g., "email", "roles[0].slots")
  reason: string; // Specific reason for this field error
  value?: any; // The invalid value (redacted for sensitive fields)
}

/**
 * Standard error codes (extend as needed).
 */
export enum ErrorCode {
  // Authentication & Authorization
  UNAUTHORIZED = 'unauthorized',
  INVALID_CREDENTIALS = 'invalid_credentials',
  PERMISSION_DENIED = 'permission_denied',
  TOKEN_EXPIRED = 'token_expired',
  TOKEN_INVALID = 'token_invalid',
  
  // Validation
  VALIDATION_ERROR = 'validation_error',
  INVALID_INPUT = 'invalid_input',
  MISSING_FIELD = 'missing_field',
  
  // Resource Errors
  NOT_FOUND = 'not_found',
  ALREADY_EXISTS = 'already_exists',
  CONFLICT = 'conflict',
  
  // Business Logic
  INSUFFICIENT_BALANCE = 'insufficient_balance',
  MILESTONE_NOT_COMPLETE = 'milestone_not_complete',
  ROLE_CAPACITY_EXCEEDED = 'role_capacity_exceeded',
  
  // System Errors
  INTERNAL_SERVER_ERROR = 'internal_server_error',
  SERVICE_UNAVAILABLE = 'service_unavailable',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
}
```

### Error Handler Middleware

```typescript
import { Request, Response, NextFunction } from 'express';
import { AppError } from './errors';
import { APIErrorResponse, ErrorCode } from '../types/error-dtos';
import { Logger } from './logger';

/**
 * Global error handler middleware.
 * Converts all errors to standardized APIErrorResponse format.
 */
export function errorResponseMiddleware(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = (req as any).id || 'unknown';
  const timestamp = new Date().toISOString();
  
  let statusCode = 500;
  let errorCode = ErrorCode.INTERNAL_SERVER_ERROR;
  let message = 'An unexpected error occurred';
  let details: ErrorDetail[] | undefined;

  // Handle AppError instances
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    errorCode = err.code as ErrorCode;
    message = err.message;
    details = err.details;
  }
  // Handle Mongoose validation errors
  else if (err.name === 'ValidationError') {
    statusCode = 400;
    errorCode = ErrorCode.VALIDATION_ERROR;
    message = 'Input validation failed';
    details = Object.keys(err.errors || {}).map(field => ({
      field,
      reason: err.errors[field].message,
    }));
  }
  // Handle Mongoose duplicate key errors
  else if (err.code === 11000) {
    statusCode = 409;
    errorCode = ErrorCode.ALREADY_EXISTS;
    const field = Object.keys(err.keyPattern || {})[0];
    message = `${field} already exists`;
    details = [{ field, reason: 'Duplicate value' }];
  }
  // Handle JWT errors
  else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    errorCode = ErrorCode.TOKEN_INVALID;
    message = 'Invalid authentication token';
  }
  else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    errorCode = ErrorCode.TOKEN_EXPIRED;
    message = 'Authentication token has expired';
  }

  // Log error (with PII redaction)
  if (statusCode >= 500) {
    Logger.error('Internal server error', {
      requestId,
      error: err.message,
      stack: err.stack,
      path: req.path,
    });
  } else {
    Logger.warn('Client error', {
      requestId,
      errorCode,
      message,
      path: req.path,
    });
  }

  // Build standardized error response
  const errorResponse: APIErrorResponse = {
    error: {
      code: errorCode,
      message,
      details,
      requestId,
      timestamp,
    },
  };

  res.status(statusCode).json(errorResponse);
}
```

---

## 📦 Part 4: Standardized Pagination

### File: `src/types/pagination-dtos.ts`

```typescript
/**
 * Standardized pagination response wrapper.
 * ALL paginated endpoints must use this structure.
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface PaginationMeta {
  page: number; // Current page (1-indexed)
  per_page: number; // Items per page
  total_items: number; // Total number of items across all pages
  total_pages: number; // Total number of pages
  has_next: boolean; // True if there's a next page
  has_prev: boolean; // True if there's a previous page
  next_cursor?: string; // Optional cursor for cursor-based pagination
  prev_cursor?: string; // Optional cursor for previous page
}

/**
 * Query parameters for pagination.
 */
export interface PaginationQuery {
  page?: number; // Default: 1
  per_page?: number; // Default: 20, Max: 100
  cursor?: string; // Optional cursor for cursor-based pagination
}

/**
 * Helper function to build pagination metadata.
 */
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
    has_next: page < totalPages,
    has_prev: page > 1,
    next_cursor: options?.nextCursor,
    prev_cursor: options?.prevCursor,
  };
}

/**
 * Helper function to create paginated response.
 */
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

---

## 📦 Part 5: Project & Revenue Split DTOs

### File: `src/types/project-dtos.ts`

```typescript
import { MoneyAmount } from './user-dtos';

/**
 * Base revenue split DTO.
 */
export interface RevenueSplitBaseDTO {
  splitId: string;
  type: 'percentage' | 'fixed';
}

/**
 * Percentage-based revenue split.
 */
export interface PercentageRevenueSplitDTO extends RevenueSplitBaseDTO {
  type: 'percentage';
  percentage: number; // 0-100, required
  assignee?: {
    userId: string;
    name: string;
  };
  placeholder?: string; // "Director", "Team Pool", etc.
}

/**
 * Fixed-amount revenue split.
 */
export interface FixedRevenueSplitDTO extends RevenueSplitBaseDTO {
  type: 'fixed';
  amount: MoneyAmount;
  assignee: {
    userId: string;
    name: string;
  };
}

export type RevenueSplitDTO = PercentageRevenueSplitDTO | FixedRevenueSplitDTO;

/**
 * Project role DTO with consistent ID naming.
 */
export interface ProjectRoleDTO {
  roleId: string; // NOT _id!
  title: string;
  description?: string;
  slots: number;
  filled: number; // Count of assignedUserIds
  assignedUserIds: string[]; // Hidden for non-members
  skills?: string[];
  compensation?: MoneyAmount;
}

/**
 * Milestone DTO with state machine.
 */
export interface MilestoneDTO {
  milestoneId: string; // NOT _id!
  title: string;
  description?: string;
  dueDate?: string; // ISO 8601
  status: MilestoneStatus;
  amount?: MoneyAmount;
  assetId?: string;
  availableActions: MilestoneAction[]; // ✅ Explicit actions!
  stateHistory: MilestoneStateChange[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export type MilestoneStatus = 'pending' | 'funded' | 'in_progress' | 'completed' | 'approved' | 'disputed' | 'rejected';

export type MilestoneAction = 'edit' | 'delete' | 'fund' | 'start' | 'complete' | 'approve' | 'dispute' | 'resolve';

export interface MilestoneStateChange {
  status: MilestoneStatus;
  timestamp: string; // ISO 8601
  userId?: string; // Who triggered this change
  reason?: string;
}

/**
 * Project member DTO (replaces just teamMemberIds).
 */
export interface ProjectMemberDTO {
  userId: string;
  name: string;
  avatar?: string;
  roles: Array<{
    roleId: string;
    title: string;
  }>;
  joinedAt: string; // ISO 8601
}

/**
 * Project summary DTO (for listings).
 */
export interface ProjectSummaryDTO {
  projectId: string;
  title: string;
  description?: string;
  ownerId: string;
  ownerName: string;
  status: 'draft' | 'published' | 'in_progress' | 'completed' | 'archived';
  rolesSummary: Array<{
    title: string;
    slots: number;
    filled: number;
  }>;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Full project detail DTO.
 */
export interface ProjectDetailDTO extends ProjectSummaryDTO {
  roles: ProjectRoleDTO[];
  milestones: MilestoneDTO[];
  revenueSplits: RevenueSplitDTO[];
  members: ProjectMemberDTO[];
  totalBudget?: MoneyAmount;
  visibility: 'public' | 'private';
}
```

---

## 📦 Part 6: Notification DTOs

### File: `src/types/notification-dtos.ts`

```typescript
/**
 * Base notification DTO.
 */
export interface NotificationBaseDTO {
  notificationId: string;
  userId: string;
  type: string; // "project_invite", "milestone_approved", etc.
  read: boolean;
  createdAt: string; // ISO 8601
}

/**
 * In-app notification content.
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
 * Email notification content.
 */
export interface EmailNotificationDTO extends NotificationBaseDTO {
  channel: 'email';
  content: {
    subject: string;
    previewText: string; // First line of email
    htmlBody: string;
    textBody?: string; // Fallback plain text
  };
  recipient: string; // Email address
}

/**
 * Push notification content.
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

---

## 📦 Part 7: Asset Upload & Processing DTOs

### File: `src/types/asset-dtos.ts`

```typescript
/**
 * Asset upload initiation response (Step 1).
 */
export interface AssetUploadInitDTO {
  sessionId: string;
  uploadUrl: string; // Pre-signed URL
  storageKey: string;
  expiresAt: string; // ISO 8601
  maxFileSize: number; // In bytes
  allowedMimeTypes: string[];
}

/**
 * Asset registration request (Step 2).
 */
export interface AssetRegisterRequestDTO {
  sessionId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
}

/**
 * Asset registration response (Step 2).
 */
export interface AssetRegisterResponseDTO {
  assetId: string;
  status: AssetProcessingStatus;
  processingJobId?: string;
  pollUrl: string; // GET /assets/:assetId/status
  estimatedProcessingTime?: number; // In seconds
  createdAt: string; // ISO 8601
}

export type AssetProcessingStatus = 'pending' | 'processing' | 'ready' | 'failed';

/**
 * Asset detail DTO.
 */
export interface AssetDetailDTO {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  status: AssetProcessingStatus;
  downloadUrl?: string; // Pre-signed URL (only if status === 'ready')
  downloadUrlExpiresAt?: string; // ISO 8601
  versionsCount: number;
  uploadedBy: string; // User ID
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Asset processing status response.
 */
export interface AssetStatusDTO {
  assetId: string;
  status: AssetProcessingStatus;
  progress?: number; // 0-100
  error?: string; // Error message if status === 'failed'
  processingStartedAt?: string; // ISO 8601
  processingCompletedAt?: string; // ISO 8601
}
```

---

## 📦 Part 8: Query Parameter Standardization

### File: `src/types/query-params.ts`

```typescript
/**
 * Search and filter query parameters.
 */
export interface SearchQueryParams {
  q?: string; // Search term
  skills?: string[]; // Multiple skills: ?skills[]=a&skills[]=b
  verified?: 'true' | 'false'; // String boolean
  minHourlyRate?: number;
  maxHourlyRate?: number;
  languages?: string[];
  sort?: 'relevance' | 'rating' | 'recent' | 'hourlyRate';
  page?: number;
  per_page?: number;
}

/**
 * Date range filter.
 */
export interface DateRangeFilter {
  from?: string; // ISO 8601 date
  to?: string; // ISO 8601 date
}

/**
 * Numeric range filter.
 */
export interface NumericRangeFilter {
  min?: number;
  max?: number;
}

/**
 * Helper to parse boolean query params.
 */
export function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Helper to parse array query params.
 */
export function parseArrayParam(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}
```

---

## 📦 Part 9: Response Builder Utility

### File: `src/utils/response-builder.ts`

```typescript
import { Response } from 'express';
import { serializeDocument } from './serialize';
import { PaginatedResponse, paginatedResponse } from '../types/pagination-dtos';
import { APIErrorResponse, ErrorCode } from '../types/error-dtos';

/**
 * Centralized response builder for consistent formatting.
 */
export class ResponseBuilder {
  /**
   * Sends a successful JSON response with automatic serialization.
   */
  static success<T>(res: Response, data: T, statusCode: number = 200): void {
    const serialized = serializeDocument(data);
    res.status(statusCode).json(serialized);
  }

  /**
   * Sends a paginated response.
   */
  static paginated<T>(
    res: Response,
    data: T[],
    page: number,
    perPage: number,
    total: number,
    statusCode: number = 200
  ): void {
    const response = paginatedResponse(serializeDocument(data), page, perPage, total);
    res.status(statusCode).json(response);
  }

  /**
   * Sends a standardized error response.
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
      },
    };
    res.status(statusCode).json(errorResponse);
  }

  /**
   * Sends a 404 Not Found error.
   */
  static notFound(res: Response, resource: string = 'Resource'): void {
    this.error(res, ErrorCode.NOT_FOUND, `${resource} not found`, 404);
  }

  /**
   * Sends a 401 Unauthorized error.
   */
  static unauthorized(res: Response, message: string = 'Authentication required'): void {
    this.error(res, ErrorCode.UNAUTHORIZED, message, 401);
  }

  /**
   * Sends a 403 Forbidden error.
   */
  static forbidden(res: Response, message: string = 'Permission denied'): void {
    this.error(res, ErrorCode.PERMISSION_DENIED, message, 403);
  }
}
```

---

## 📦 Part 10: OpenAPI Specification Template

### File: `api-spec.yaml`

```yaml
openapi: 3.1.0
info:
  title: OpenShow API
  version: 1.0.0
  description: Standardized API specification for OpenShow platform

servers:
  - url: https://api.openshow.com/v1
    description: Production
  - url: http://localhost:3000/api/v1
    description: Development

components:
  schemas:
    # ==================== User DTOs ====================
    UserPublicDTO:
      type: object
      required: [id, preferredName, role, createdAt]
      properties:
        id: { type: string, format: uuid }
        preferredName: { type: string }
        role: { type: string, enum: [creator, owner, admin] }
        avatar: { type: string, format: uri }
        createdAt: { type: string, format: date-time }

    UserPrivateDTO:
      allOf:
        - $ref: '#/components/schemas/UserPublicDTO'
        - type: object
          required: [email, status, twoFAEnabled]
          properties:
            email: { type: string, format: email }
            fullName: { type: string }
            status: { type: string, enum: [active, pending, suspended] }
            twoFAEnabled: { type: boolean }
            lastSeenAt: { type: string, format: date-time }

    AuthUserDTO:
      allOf:
        - $ref: '#/components/schemas/UserPrivateDTO'
        - type: object
          required: [socialAccounts]
          properties:
            socialAccounts:
              type: array
              items:
                type: object
                properties:
                  provider: { type: string }
                  providerId: { type: string }
                  connectedAt: { type: string, format: date-time }

    # ==================== Error DTOs ====================
    APIErrorResponse:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message, timestamp]
          properties:
            code: { type: string }
            message: { type: string }
            details:
              type: array
              items:
                type: object
                properties:
                  field: { type: string }
                  reason: { type: string }
            requestId: { type: string }
            timestamp: { type: string, format: date-time }

    # ==================== Pagination ====================
    PaginationMeta:
      type: object
      required: [page, per_page, total_items, total_pages, has_next, has_prev]
      properties:
        page: { type: integer, minimum: 1 }
        per_page: { type: integer, minimum: 1, maximum: 100 }
        total_items: { type: integer, minimum: 0 }
        total_pages: { type: integer, minimum: 0 }
        has_next: { type: boolean }
        has_prev: { type: boolean }
        next_cursor: { type: string }
        prev_cursor: { type: string }

    # ==================== Money ====================
    MoneyAmount:
      type: object
      required: [amount, currency, display]
      properties:
        amount: { type: integer, description: "Amount in smallest currency unit (cents)" }
        currency: { type: string, pattern: "^[A-Z]{3}$", description: "ISO 4217 code" }
        display: { type: string, description: "Human-readable format" }

    # ==================== Project DTOs ====================
    ProjectRoleDTO:
      type: object
      required: [roleId, title, slots, filled, assignedUserIds]
      properties:
        roleId: { type: string }
        title: { type: string }
        description: { type: string }
        slots: { type: integer, minimum: 1 }
        filled: { type: integer, minimum: 0 }
        assignedUserIds: { type: array, items: { type: string } }
        skills: { type: array, items: { type: string } }
        compensation: { $ref: '#/components/schemas/MoneyAmount' }

    MilestoneDTO:
      type: object
      required: [milestoneId, title, status, availableActions, stateHistory, createdAt, updatedAt]
      properties:
        milestoneId: { type: string }
        title: { type: string }
        description: { type: string }
        dueDate: { type: string, format: date-time }
        status:
          type: string
          enum: [pending, funded, in_progress, completed, approved, disputed, rejected]
        amount: { $ref: '#/components/schemas/MoneyAmount' }
        assetId: { type: string }
        availableActions:
          type: array
          items:
            type: string
            enum: [edit, delete, fund, start, complete, approve, dispute, resolve]
        stateHistory:
          type: array
          items:
            type: object
            properties:
              status: { type: string }
              timestamp: { type: string, format: date-time }
              userId: { type: string }
              reason: { type: string }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }

paths:
  # ==================== Auth Endpoints ====================
  /auth/signup:
    post:
      summary: Create new user account
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email, password, role]
              properties:
                email: { type: string, format: email }
                password: { type: string, minLength: 8 }
                fullName: { type: string }
                preferredName: { type: string }
                role: { type: string, enum: [creator, owner] }
      responses:
        '201':
          description: User created successfully
          content:
            application/json:
              schema:
                type: object
                properties:
                  user: { $ref: '#/components/schemas/AuthUserDTO' }
                  accessToken: { type: string }
                  refreshToken: { type: string }
        '400':
          $ref: '#/components/responses/BadRequest'
        '409':
          $ref: '#/components/responses/Conflict'

  /auth/me:
    get:
      summary: Get current authenticated user
      security:
        - BearerAuth: []
      responses:
        '200':
          description: Current user details
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AuthUserDTO'
        '401':
          $ref: '#/components/responses/Unauthorized'

  # ==================== User Endpoints ====================
  /users/{userId}:
    get:
      summary: Get user profile (public or private based on permissions)
      parameters:
        - name: userId
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: User profile
          content:
            application/json:
              schema:
                oneOf:
                  - $ref: '#/components/schemas/UserPublicDTO'
                  - $ref: '#/components/schemas/UserPrivateDTO'
                  - $ref: '#/components/schemas/CreatorProfileDTO'
        '404':
          $ref: '#/components/responses/NotFound'

components:
  responses:
    BadRequest:
      description: Invalid request
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/APIErrorResponse'
    Unauthorized:
      description: Authentication required
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/APIErrorResponse'
    Forbidden:
      description: Permission denied
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/APIErrorResponse'
    NotFound:
      description: Resource not found
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/APIErrorResponse'
    Conflict:
      description: Resource conflict
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/APIErrorResponse'

  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
```

---

## 🔧 Part 11: Integration Guide

### Step 1: Install OpenAPI Tools

```bash
npm install --save-dev openapi-typescript @openapitools/openapi-generator-cli
```

### Step 2: Generate TypeScript Types

```bash
npx openapi-typescript api-spec.yaml --output src/types/api-generated.ts
```

### Step 3: Update All Controllers

Replace direct JSON responses with `ResponseBuilder`:

```typescript
// ❌ OLD
return res.status(200).json({
  id: user._id.toString(),
  email: user.email,
  // ...
});

// ✅ NEW
import { ResponseBuilder } from '../utils/response-builder';
import { UserDTOMapper } from '../types/user-dtos';

const userDTO = UserDTOMapper.toAuthDTO(user);
ResponseBuilder.success(res, userDTO, 200);
```

### Step 4: Update All Service Methods

Use serialization utilities:

```typescript
// ❌ OLD
return project;

// ✅ NEW
import { serializeDocument } from '../utils/serialize';

return serializeDocument<ProjectDetailDTO>(project);
```

### Step 5: Update Error Handling

```typescript
// ❌ OLD
throw new Error('Not found');

// ✅ NEW
import { AppError } from '../utils/errors';
import { ErrorCode } from '../types/error-dtos';

throw new AppError(ErrorCode.NOT_FOUND, 'Project not found', 404);
```

---

## 📋 Verification Checklist

- [ ] All User responses use `UserPublicDTO`, `UserPrivateDTO`, or `AuthUserDTO`
- [ ] All ObjectIds are converted to strings via `serializeDocument()`
- [ ] All Dates are ISO 8601 strings
- [ ] All subdocument IDs use semantic names (`roleId`, `milestoneId`, not `_id`)
- [ ] All errors use `APIErrorResponse` format
- [ ] All paginated endpoints use `PaginatedResponse<T>`
- [ ] All money amounts use `MoneyAmount` type
- [ ] All milestone responses include `availableActions`
- [ ] All notification responses use discriminated unions by channel
- [ ] All asset upload flows return processing status
- [ ] OpenAPI spec is complete and validated
- [ ] TypeScript types are generated from OpenAPI spec
- [ ] All controllers use `ResponseBuilder`
- [ ] Frontend team has reviewed and approved all DTOs

---

## 🚨 Critical Migration Notes

1. **Breaking Changes**: These fixes will break existing frontend code. Coordinate deployment!
2. **Version API**: Consider versioning (`/api/v1`, `/api/v2`) to maintain backward compatibility.
3. **Database Migration**: No schema changes required, only response transformations.
4. **Testing**: Update all integration tests to expect new response formats.
5. **Documentation**: Update API documentation and client SDKs.

---

**Status**: Ready for implementation  
**Priority**: Must be completed BEFORE any other task implementation  
**Review Required**: Frontend team sign-off on all DTOs

