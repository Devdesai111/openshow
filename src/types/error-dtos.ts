export interface APIErrorResponse {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
    timestamp: string;
    documentation?: string;
  };
}

export interface ErrorDetail {
  field?: string;
  reason: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value?: any;
}

export enum ErrorCode {
  // Auth errors
  UNAUTHORIZED = 'unauthorized',
  INVALID_CREDENTIALS = 'invalid_credentials',
  PERMISSION_DENIED = 'permission_denied',
  TOKEN_EXPIRED = 'token_expired',
  TOKEN_INVALID = 'token_invalid',
  ACCOUNT_INACTIVE = 'account_inactive',

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

