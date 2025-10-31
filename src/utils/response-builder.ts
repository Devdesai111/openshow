import { Response } from 'express';
import { serializeDocument } from './serialize';
import { APIErrorResponse, ErrorCode, ErrorDetail } from '../types/error-dtos';

export class ResponseBuilder {
  /**
   * Sends a success response with automatic serialization
   */
  static success<T>(res: Response, data: T, statusCode: number = 200): void {
    const serialized = serializeDocument(data);
    res.status(statusCode).json(serialized);
  }

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
    const totalPages = Math.ceil(totalItems / perPage);

    const response = {
      data: serializeDocument(data),
      pagination: {
        page,
        per_page: perPage,
        total_items: totalItems,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_prev: page > 1,
      },
    };

    res.status(statusCode).json(response);
  }

  /**
   * Sends an error response
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        requestId: (res.req as any).id,
      },
    };

    res.status(statusCode).json(errorResponse);
  }

  /**
   * 404 Not Found shortcut
   */
  static notFound(res: Response, resource: string = 'Resource'): void {
    this.error(res, ErrorCode.NOT_FOUND, `${resource} not found`, 404);
  }

  /**
   * 401 Unauthorized shortcut
   */
  static unauthorized(res: Response, message: string = 'Authentication required'): void {
    this.error(res, ErrorCode.UNAUTHORIZED, message, 401);
  }

  /**
   * 403 Forbidden shortcut
   */
  static forbidden(res: Response, message: string = 'Permission denied'): void {
    this.error(res, ErrorCode.PERMISSION_DENIED, message, 403);
  }

  /**
   * 422 Validation Error
   */
  static validationError(res: Response, details: ErrorDetail[]): void {
    this.error(res, ErrorCode.VALIDATION_ERROR, 'Input validation failed', 422, details);
  }
}
