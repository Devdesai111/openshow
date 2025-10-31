import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { AuthService } from '../services/auth.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';
import { UserDTOMapper } from '../types/user-dtos';

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

/**
 * Handles refresh token renewal and rotation. POST /auth/refresh
 */
export const refreshController = async (req: Request, res: Response): Promise<void> => {
  // 1. Input Validation (minimal: token presence)
  const refreshToken = req.body.refreshToken as string;

  if (!refreshToken || typeof refreshToken !== 'string') {
    return ResponseBuilder.error(
      res,
      ErrorCode.INVALID_INPUT,
      'Refresh token is required.',
      400
    );
  }

  try {
    // 2. Service Call: Invalidates old token and issues new pair
    const { accessToken, refreshToken: newRefreshToken, expiresIn } =
      await authService.refreshTokens(refreshToken, req);

    // 3. Success (200 OK)
    const responseData = {
      accessToken,
      refreshToken: newRefreshToken,
      tokenType: 'Bearer',
      expiresIn,
    };

    return ResponseBuilder.success(res, responseData, 200);
  } catch (error: unknown) {
    // 4. Error Handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'SessionExpired' || errorMessage === 'UserNotFound') {
      return ResponseBuilder.error(
        res,
        ErrorCode.SESSION_EXPIRED,
        'Refresh token is expired or invalid. Please log in again.',
        401
      );
    }
    // Fallback
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during token refresh.',
      500
    );
  }
};

/**
 * Handles user profile retrieval from Access Token. GET /auth/me
 */
export const meController = async (req: Request, res: Response): Promise<void> => {
  // Assumes Task 2's `authenticate` middleware successfully ran
  const userId = req.user?.sub;

  if (!userId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    // 1. Service Call
    const user = await authService.getAuthMe(userId);

    // 2. Response Mapping using UserDTOMapper (Task-102 standard)
    const userDTO = UserDTOMapper.toAuthDTO(user);

    // 3. Success (200 OK)
    return ResponseBuilder.success(res, userDTO, 200);
  } catch (error: unknown) {
    // 4. Error Handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.notFound(res, 'User');
    }
    if (errorMessage === 'AccountSuspended') {
      return ResponseBuilder.error(
        res,
        ErrorCode.ACCOUNT_INACTIVE,
        'Your account is suspended. Access denied.',
        403
      );
    }
    // Fallback
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error fetching user profile.',
      500
    );
  }
};

/**
 * Handles user logout. POST /auth/logout
 */
export const logoutController = async (req: Request, res: Response): Promise<void> => {
  // 1. Input Check
  const refreshToken = req.body.refreshToken as string;

  if (!refreshToken) {
    return ResponseBuilder.error(
      res,
      ErrorCode.INVALID_INPUT,
      'Refresh token is required in the body for revocation.',
      400
    );
  }

  try {
    // 2. Service Call: Find and delete the session
    await authService.logout(refreshToken);

    // 3. Success (204 No Content - standard for successful delete)
    res.status(204).send();
  } catch (error: unknown) {
    // 4. Error Handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'SessionNotFound') {
      return ResponseBuilder.error(
        res,
        ErrorCode.NOT_FOUND,
        'Session not found or already revoked.',
        400
      );
    }
    // Fallback
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during logout.',
      500
    );
  }
};

/**
 * Handles 2FA enablement step 1 (secret generation). POST /auth/2fa/enable
 */
export const enable2FAController = async (req: Request, res: Response): Promise<void> => {
  // 1. Authorization check (via req.user from 'authenticate' middleware)
  const userId = req.user?.sub;
  const email = req.user?.email;

  if (!userId || !email) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    // 2. Service Call: Generates secret and stores temporarily
    const { tempSecretId, otpauthUrl, expiresAt } = await authService.enable2FA(userId, email);

    // 3. Success (200 OK)
    const responseData = {
      tempSecretId,
      otpauthUrl,
      expiresAt: expiresAt.toISOString(),
      message: 'Scan the QR code with your authenticator app. Verify in next step.',
    };

    return ResponseBuilder.success(res, responseData, 200);
  } catch (error: unknown) {
    // 4. Error Handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'AlreadyEnabled') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        '2FA is already enabled on this account.',
        400
      );
    }
    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.notFound(res, 'User');
    }
    // Fallback
    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during 2FA setup.',
      500
    );
  }
};

