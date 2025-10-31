import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AuthService } from '../services/auth.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const authService = new AuthService();

// Define input validation middleware (reusable)
export const signupValidation = [
  body('email').isEmail().withMessage('Email must be valid.').bail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.').bail(),
  body('role').optional().isIn(['creator', 'owner']).withMessage('Role must be creator or owner.'),
];

export const loginValidation = [
  body('email').isEmail().withMessage('Email must be valid.').bail(),
  body('password').exists().withMessage('Password is required.'),
  body('rememberMe').optional().isBoolean(),
];

export const oauthValidation = [
  body('provider')
    .isIn(['google', 'github', 'linkedin'])
    .withMessage('Invalid OAuth provider.'),
  body('providerAccessToken').isString().withMessage('Provider access token is required.'),
  body('role').optional().isIn(['creator', 'owner']),
];

export const passwordResetRequestValidation = [
  body('email').isEmail().withMessage('Invalid email format.'),
  body('redirectUrl')
    .isURL({ require_tld: false })
    .withMessage('A valid redirect URL is required in the request.'),
];

// DTO for sanitized user data in response
interface UserResponseDTO {
  id: string;
  email: string;
  fullName?: string;
  preferredName?: string;
  role: 'creator' | 'owner' | 'admin';
  status: 'pending' | 'active' | 'suspended' | 'deleted';
  createdAt?: string;
}

/**
 * Handles user registration. POST /auth/signup
 */
export const signupController = async (req: Request, res: Response): Promise<void> => {
  // 1. Input Validation (REST Best Practice)
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? err.path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? err.value : undefined,
      }))
    );
  }

  try {
    // 2. Service Call
    const { accessToken, refreshToken, expiresIn, user } = await authService.signup(req.body, req);

    // 3. Response Mapping (Strict Typing DTO)
    const responseUser: UserResponseDTO = {
      id: user._id?.toString() as string,
      email: user.email,
      fullName: user.fullName,
      preferredName: user.preferredName,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt?.toISOString(),
    };

    // 4. Success (201 Created)
    const responseData = {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn,
      user: responseUser,
    };

    return ResponseBuilder.success(res, responseData, 201);
  } catch (error: unknown) {
    // 5. Error Handling (Clean Architecture: Map Service Error to HTTP Response)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'EmailAlreadyExists') {
      return ResponseBuilder.error(
        res,
        ErrorCode.ALREADY_EXISTS,
        'The provided email is already registered.',
        409
      );
    }
    // Fallback for unexpected errors (500 Server Error)
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'An unexpected error occurred during signup.',
      500
    );
  }
};

/**
 * Handles user login. POST /auth/login
 */
export const loginController = async (req: Request, res: Response): Promise<void> => {
  // 1. Input Validation
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? err.path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? err.value : undefined,
      }))
    );
  }

  try {
    // 2. Service Call
    const { accessToken, refreshToken, expiresIn, user } = await authService.login(req.body, req);

    // 3. Response Mapping (Login DTO is slightly simpler)
    const responseUser = {
      id: user._id?.toString() as string,
      email: user.email,
      role: user.role,
      status: user.status,
    };

    // 4. Success (200 OK)
    const responseData = {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn,
      user: responseUser,
    };

    return ResponseBuilder.success(res, responseData, 200);
  } catch (error: unknown) {
    // 5. Error Handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'InvalidCredentials') {
      return ResponseBuilder.error(
        res,
        ErrorCode.INVALID_CREDENTIALS,
        'Email or password incorrect.',
        401
      );
    }
    if (errorMessage === 'AccountSuspended') {
      return ResponseBuilder.error(
        res,
        ErrorCode.ACCOUNT_INACTIVE,
        'Your account is suspended.',
        403
      );
    }
    // Fallback for unexpected errors
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'An unexpected error occurred during login.',
      500
    );
  }
};

/**
 * Handles OAuth login/signup. POST /auth/oauth
 */
export const oauthController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? err.path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? err.value : undefined,
      }))
    );
  }

  try {
    const { accessToken, refreshToken, expiresIn, user } = await authService.oauthLogin(
      req.body,
      req
    );

    // Determine status code based on whether the user was created (simplistic check for Phase 1)
    const isNewUser = user.createdAt?.getTime() === user.updatedAt?.getTime();
    const statusCode = isNewUser ? 201 : 200;

    // Response mapping
    const responseUser: UserResponseDTO = {
      id: user._id?.toString() as string,
      email: user.email,
      fullName: user.fullName,
      preferredName: user.preferredName,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt?.toISOString(),
    };

    const responseData = {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn,
      user: responseUser,
    };

    return ResponseBuilder.success(res, responseData, statusCode);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('Provider token validation failed.')) {
      return ResponseBuilder.error(
        res,
        ErrorCode.INVALID_INPUT,
        'The provided provider token is invalid.',
        400
      );
    }
    // Assuming other errors are server errors (500)
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'An unexpected error occurred during OAuth flow.',
      500
    );
  }
};

/**
 * Handles initiating the password reset. POST /auth/password-reset/request
 */
export const requestPasswordResetController = async (
  req: Request,
  res: Response
): Promise<void> => {
  // 1. Input Validation
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? err.path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? err.value : undefined,
      }))
    );
  }

  try {
    // 2. Service Call (handles security and email logic)
    await authService.requestPasswordReset(req.body);

    // 3. Security Best Practice: Always return 200 OK regardless of user existence
    const responseData = {
      status: 'ok',
      message: 'If an account is registered with this email, a password reset link has been sent.',
    };

    return ResponseBuilder.success(res, responseData, 200);
  } catch {
    // Only return 500 for actual server/DB failure, not user error
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'An unexpected server error occurred.',
      500
    );
  }
};

