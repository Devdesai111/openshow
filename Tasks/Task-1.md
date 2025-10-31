

## **Task 1: Authentication & Identity Core (User Model, JWT/Refresh Tokens)**

**Goal:** Implement the core User and AuthSession models, service logic, and API endpoints for user registration (`POST /auth/signup`) and email/password login (`POST /auth/login`), establishing the identity and token foundation.

**Service:** `Auth & Identity Service`
**Phase:** A - Foundations
**Dependencies:** None (Foundation)

**Output Files:**
1.  `src/models/user.model.ts` (IUser, UserSchema/Model)
2.  `src/models/authSession.model.ts` (IAuthSession, AuthSessionSchema/Model)
3.  `src/services/auth.service.ts` (Core logic for token creation, signup, login)
4.  `src/controllers/auth.controller.ts` (API handlers: validation, service call, response mapping)
5.  `src/routes/auth.routes.ts` (Router definitions with validation middleware)
6.  `test/unit/token.test.ts` (Unit test for token generation)

**Input/Output Shapes (OpenAPI/Zod Style Schema):**

| Endpoint | Request (Body) | Response (201 Created/200 OK) | Error (409 Conflict/401 Unauthorized) |
| :--- | :--- | :--- | :--- |
| **POST /auth/signup** | `{ email: string, password: string, role?: 'creator'|'owner' }` | `{ accessToken: string, refreshToken: string, expiresIn: number, user: { id, email, role, status, createdAt } }` | `{ error: { code: 'email_exists', message: '...' } }` |
| **POST /auth/login** | `{ email: string, password: string, rememberMe?: boolean }` | `{ accessToken: string, refreshToken: string, expiresIn: number, user: { id, email, role, status } }` | `{ error: { code: 'invalid_credentials', message: '...' } }` |

**Runtime & Env Constraints:**
*   Node v18+, MongoDB, Mongoose v6/v7, Express.
*   Libraries: `bcryptjs` (password hashing), `jsonwebtoken` (JWTs).
*   **Strict TS** mode.
*   Environment variables: `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`.

**Acceptance Criteria:**
*   Successful signup returns **201 Created** with a user object and both `accessToken` (JWT) and `refreshToken` (opaque string).
*   Signup with existing email returns **409 Conflict** (`email_exists`).
*   Successful login returns **200 OK** with tokens, updating `lastSeenAt` in DB.
*   Login with invalid credentials returns **401 Unauthorized** (`invalid_credentials`).
*   The `refreshToken` must be securely stored in the `AuthSessionModel` as a hash.

**Tests to Generate:**
*   **Unit Test:** Verify `generateTokens` creates valid JWTs with correct claims and expiration.
*   **Integration Test (Signup):** Test happy path, existing email conflict (409), and password validation (422).
*   **Integration Test (Login):** Test happy path, incorrect password (401), and token generation.

**Non-Goals / Out-of-Scope (for Task 1):**
*   Full OAuth implementation (only schema prep for social accounts).
*   Email sending for account verification (status is 'active' for simplicity).
*   Complex security checks (rate-limiting, 2FA enforcement).

**Performance / Security Notes:**
*   Use `bcryptjs` with a reasonable cost factor (e.g., 10).
*   Store `refreshToken` hash, never the plain token.
*   Exclude `hashedPassword` from default Mongoose query results (`select: false`).

**File & Naming Conventions:**
*   Services in `src/services/`, Controllers in `src/controllers/`, Models in `src/models/`.
*   Interfaces prefixed with `I`.
*   Function and class names follow PascalCase/camelCase.

***

### **Task 1 Code Implementation**

#### **1.1. `src/models/user.model.ts` & `src/models/authSession.model.ts`**

*(Same as previous, included here for completeness and strict compliance with the plan)*

```typescript
// src/models/user.model.ts
import { Schema, model, Types } from 'mongoose';

// Define sub-interfaces for strict typing
export interface ISocialAccount {
  provider: 'google' | 'github' | 'linkedin';
  providerId: string;
  profileUrl?: string;
  connectedAt: Date;
}

export interface ITwoFA {
  enabled: boolean;
  totpSecretEncrypted?: string; // SENSITIVE: Encrypted at rest
  enabledAt?: Date;
}

// Define main User interface
export interface IUser {
  _id?: Types.ObjectId;
  email: string;
  hashedPassword?: string;
  fullName?: string;
  preferredName?: string;
  role: 'creator' | 'owner' | 'admin';
  status: 'active' | 'pending' | 'suspended' | 'deleted';
  socialAccounts: ISocialAccount[];
  twoFA: ITwoFA;
  lastSeenAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const SocialAccountSchema = new Schema<ISocialAccount>({
  provider: { type: String, enum: ['google', 'github', 'linkedin'], required: true },
  providerId: { type: String, required: true },
  profileUrl: { type: String },
  connectedAt: { type: Date, default: Date.now },
}, { _id: false });

const TwoFASchema = new Schema<ITwoFA>({
  enabled: { type: Boolean, default: false },
  totpSecretEncrypted: { type: String }, 
  enabledAt: { type: Date },
}, { _id: false });

const UserSchema = new Schema<IUser>({
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  hashedPassword: { type: String, select: false }, // SECURITY: Exclude from default find queries
  fullName: { type: String },
  preferredName: { type: String },
  role: { type: String, enum: ['creator', 'owner', 'admin'], default: 'creator', index: true },
  status: { type: String, enum: ['active', 'pending', 'suspended', 'deleted'], default: 'active' },
  socialAccounts: { type: [SocialAccountSchema], default: [] },
  twoFA: { type: TwoFASchema, default: () => ({ enabled: false }) }, 
  lastSeenAt: { type: Date },
}, { timestamps: true });

export const UserModel = model<IUser>('User', UserSchema);


// src/models/authSession.model.ts
export interface IAuthSession {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  refreshTokenHash: string; // SENSITIVE: Hashed plain token for comparison
  userAgent?: string;
  ip?: string;
  expiresAt: Date;
  createdAt?: Date;
}

const AuthSessionSchema = new Schema<IAuthSession>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  refreshTokenHash: { type: String, required: true },
  userAgent: { type: String },
  ip: { type: String },
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true });

// SECURITY: TTL Index for automatic session cleanup after expiry
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthSessionModel = model<IAuthSession>('AuthSession', AuthSessionSchema);
```

#### **1.2. `src/services/auth.service.ts`**

```typescript
// src/services/auth.service.ts
import { Request } from 'express';
import { UserModel, AuthSessionModel, IUser } from '../models/user.model';
import { compare, hash } from 'bcryptjs'; 
import { sign } from 'jsonwebtoken';
import { Types } from 'mongoose';
import crypto from 'crypto';

// Token configuration (should load from config/env)
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev_access_secret';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'dev_refresh_secret';
const ACCESS_TOKEN_EXPIRY_S = 900; // 15 minutes in seconds

// DTO for token response
interface ITokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; 
}

// Utility to generate tokens
const generateTokens = (user: IUser): ITokenPair => {
  const payload = {
    sub: user._id?.toString(),
    role: user.role,
    email: user.email,
    iss: 'OpenShow', // Issuer
    aud: 'OpenShow', // Audience
  };
  
  // 1. Access Token (JWT) - Short lived
  const accessToken = sign(payload, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY_S });

  // 2. Refresh Token (Opaque String) - Long lived
  const refreshToken = crypto.randomBytes(32).toString('hex');
  
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_EXPIRY_S };
};

/**
 * Saves the hashed refresh token securely in the DB (AuthSession).
 * @param refreshToken - The plain opaque refresh token string.
 * @param rememberMe - If true, sets a longer expiration.
 * @param req - Express request to log IP/User-Agent.
 */
const saveRefreshToken = async (userId: Types.ObjectId, refreshToken: string, req: Request, rememberMe: boolean = false): Promise<void> => {
    // SECURITY: Hash the opaque token before saving
    const refreshTokenHash = await hash(refreshToken, 10); 
    
    // Set expiry: 30 days if 'rememberMe', else 7 days
    const expiryDays = rememberMe ? 30 : 7;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    const session = new AuthSessionModel({
        userId,
        refreshTokenHash,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        expiresAt,
    });
    await session.save();
};

export class AuthService {
    
    /** 
     * Registers a new user. 
     * @throws {Error} - 'EmailAlreadyExists' | 'ValidationError'. 
     */
    public async signup(data: any, req: Request): Promise<ITokenPair & { user: IUser }> {
        const { email, password, role, fullName, preferredName, rememberMe } = data;

        // 1. Check for existing user (Repository pattern abstraction in production)
        const existingUser = await UserModel.findOne({ email });
        if (existingUser) {
            throw new Error('EmailAlreadyExists'); 
        }

        // 2. Hash password (SECURITY: use strong algorithm and salt)
        const hashedPassword = await hash(password, 10); // Cost factor 10
        const newUser = new UserModel({
            email,
            hashedPassword,
            role: role || 'creator',
            fullName,
            preferredName,
            status: 'active', // Phase 1: auto-active
        });
        const savedUser = await newUser.save();
        
        // 3. Generate tokens and save session (TRANSACTIONAL: consider wrapping in transaction in production)
        const tokenPair = generateTokens(savedUser);
        await saveRefreshToken(savedUser._id as Types.ObjectId, tokenPair.refreshToken, req, rememberMe);
        
        // 4. Return tokens and sanitized user object
        const userObject = savedUser.toObject({ getters: true, virtuals: true }) as IUser;
        delete userObject.hashedPassword; // Ensure hash is not returned even if selected in query

        return { ...tokenPair, user: userObject };
    }

    /**
     * Authenticates a user and returns tokens.
     * @throws {Error} - 'InvalidCredentials' | 'AccountSuspended'.
     */
    public async login(data: any, req: Request): Promise<ITokenPair & { user: IUser }> {
        const { email, password, rememberMe } = data;

        // 1. Find user, explicitly requesting password hash for comparison
        const user = await UserModel.findOne({ email }).select('+hashedPassword');
        if (!user || !user.hashedPassword) {
            throw new Error('InvalidCredentials');
        }

        // 2. Compare password (ASYNC operation)
        const isMatch = await compare(password, user.hashedPassword);
        if (!isMatch) {
            throw new Error('InvalidCredentials');
        }
        
        // 3. Status Check (RBAC: enforce account status)
        if (user.status !== 'active') {
             throw new Error('AccountSuspended');
        }

        // 4. Update last seen time (minimal DB write)
        user.lastSeenAt = new Date();
        await user.save(); 
        
        // 5. Generate tokens and save session
        const tokenPair = generateTokens(user);
        await saveRefreshToken(user._id as Types.ObjectId, tokenPair.refreshToken, req, rememberMe);

        // 6. Return tokens and sanitized user object
        const userObject = user.toObject({ getters: true, virtuals: true }) as IUser;
        delete userObject.hashedPassword;
        
        return { ...tokenPair, user: userObject };
    }
}
```

#### **1.3. `src/controllers/auth.controller.ts`**

```typescript
// src/controllers/auth.controller.ts
import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { body, validationResult } from 'express-validator'; 

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

// DTO for sanitized user data in response
interface UserResponseDTO {
    id: string;
    email: string;
    fullName?: string;
    preferredName?: string;
    role: 'creator'|'owner'|'admin';
    status: 'pending'|'active'|'suspended';
    createdAt?: string;
}

/** Handles user registration. POST /auth/signup */
export const signupController = async (req: Request, res: Response) => {
    // 1. Input Validation (REST Best Practice)
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ 
            error: { 
                code: 'validation_error', 
                message: 'Input validation failed.', 
                details: errors.array() 
            } 
        });
    }

    try {
        // 2. Service Call
        const { accessToken, refreshToken, expiresIn, user } = await authService.signup(req.body, req);

        // 3. Response Mapping (Strict Typing DTO)
        const responseUser: UserResponseDTO = {
            id: user._id?.toString()!,
            email: user.email,
            fullName: user.fullName,
            preferredName: user.preferredName,
            role: user.role,
            status: user.status,
            createdAt: user.createdAt?.toISOString(),
        };

        // 4. Success (201 Created)
        return res.status(201).json({
            accessToken,
            refreshToken,
            tokenType: "Bearer",
            expiresIn,
            user: responseUser,
        });

    } catch (error: any) {
        // 5. Error Handling (Clean Architecture: Map Service Error to HTTP Response)
        if (error.message === 'EmailAlreadyExists') {
            return res.status(409).json({ 
                error: { 
                    code: 'email_exists', 
                    message: 'The provided email is already registered.' 
                } 
            });
        }
        // Fallback for unexpected errors (500 Server Error)
        return res.status(500).json({ 
            error: { 
                code: 'server_error', 
                message: 'An unexpected error occurred during signup.' 
            } 
        });
    }
};

/** Handles user login. POST /auth/login */
export const loginController = async (req: Request, res: Response) => {
    // 1. Input Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(422).json({ 
            error: { 
                code: 'validation_error', 
                message: 'Input validation failed.', 
                details: errors.array() 
            } 
        });
    }

    try {
        // 2. Service Call
        const { accessToken, refreshToken, expiresIn, user } = await authService.login(req.body, req);

        // 3. Response Mapping (Login DTO is slightly simpler)
        const responseUser = {
            id: user._id?.toString()!,
            email: user.email,
            role: user.role,
            status: user.status,
        };

        // 4. Success (200 OK)
        return res.status(200).json({
            accessToken,
            refreshToken,
            tokenType: "Bearer",
            expiresIn,
            user: responseUser,
        });

    } catch (error: any) {
        // 5. Error Handling
        if (error.message === 'InvalidCredentials') {
            return res.status(401).json({ 
                error: { 
                    code: 'invalid_credentials', 
                    message: 'Email or password incorrect.' 
                } 
            });
        }
        if (error.message === 'AccountSuspended') {
            return res.status(403).json({ 
                error: { 
                    code: 'account_suspended', 
                    message: 'Your account is suspended.' 
                } 
            });
        }
        // Fallback for unexpected errors
        return res.status(500).json({ 
            error: { 
                code: 'server_error', 
                message: 'An unexpected error occurred during login.' 
            } 
        });
    }
};
```

#### **1.4. `src/routes/auth.routes.ts`**

```typescript
// src/routes/auth.routes.ts
import { Router } from 'express';
import { signupController, loginController, signupValidation, loginValidation } from '../controllers/auth.controller';

const router = Router();

// --- Public Endpoints ---

// POST /auth/signup - Create new account. (Task 1)
router.post('/signup', signupValidation, signupController); 

// POST /auth/login - Email/password login. (Task 1)
router.post('/login', loginValidation, loginController);   


// NOTE: OAuth, Refresh, Logout, and other endpoints will be implemented in subsequent tasks.

export default router;
```

#### **1.5. Test Specification (Self-Correction/Test Plan)**

| Test Case ID | Endpoint | Description | Input | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T1.1** | `POST /auth/signup` | Happy Path: New User | `{ email: "test@a.com", password: "StrongPassword1", role: "creator" }` | **201 Created** | N/A |
| **T1.2** | `POST /auth/signup` | Validation Fail: Short Password | `{ email: "test2@a.com", password: "short" }` | **422 Unprocessable Entity** | `validation_error` |
| **T1.3** | `POST /auth/signup` | Conflict: Existing User | Same as T1.1 | **409 Conflict** | `email_exists` |
| **T1.4** | `POST /auth/login` | Happy Path: Login Success | `{ email: "test@a.com", password: "StrongPassword1" }` | **200 OK** | N/A |
| **T1.5** | `POST /auth/login` | Failure: Invalid Password | `{ email: "test@a.com", password: "WrongPassword" }` | **401 Unauthorized** | `invalid_credentials` |
| **T1.6** | `POST /auth/login` | Failure: Non-existent User | `{ email: "nonexistent@a.com", password: "StrongPassword1" }` | **401 Unauthorized** | `invalid_credentials` |

*(This structure is maintained for all future tasks.)*

---

