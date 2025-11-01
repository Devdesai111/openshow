import { IUser } from '../models/user.model';

/** Global permission constants (UPPER_SNAKE_CASE). */
export const PERMISSIONS = {
  ADMIN_DASHBOARD: 'admin:dashboard_access',
  USER_MANAGE_ALL: 'user:manage_all',
  PROJECT_CREATE: 'project:create',
  VERIFICATION_REVIEW: 'verification:review',
  FINANCE_MANAGE: 'finance:manage',
  CREATOR_PROFILE_EDIT: 'profile:edit',
};

/** Defines permissions granted to each user role. */
export const ROLE_PERMISSIONS: Record<IUser['role'], string[]> = {
  admin: [
    PERMISSIONS.ADMIN_DASHBOARD,
    PERMISSIONS.USER_MANAGE_ALL,
    PERMISSIONS.PROJECT_CREATE,
    PERMISSIONS.VERIFICATION_REVIEW,
    PERMISSIONS.FINANCE_MANAGE,
    PERMISSIONS.CREATOR_PROFILE_EDIT,
  ],
  owner: [PERMISSIONS.PROJECT_CREATE],
  creator: [PERMISSIONS.CREATOR_PROFILE_EDIT, PERMISSIONS.PROJECT_CREATE],
};

/**
 * Checks if a role has all the required permissions.
 * @param userRole The user's role (from JWT or DB).
 * @param requiredPermissions An array of permission strings.
 * @returns true if all permissions are present.
 */
export const checkPermissions = (
  userRole: IUser['role'],
  requiredPermissions: string[]
): boolean => {
  const userPermissions = ROLE_PERMISSIONS[userRole] || [];
  // Every required permission must be included in the user's granted permissions
  return requiredPermissions.every(perm => userPermissions.includes(perm));
};

/** Checks if the user status is valid for authenticated action. */
export const checkStatus = (userStatus: IUser['status']): boolean => {
  return userStatus === 'active';
};

/** Define high-privilege permissions that require MFA enforcement on access. */
export const MFA_ENFORCED_PERMISSIONS = [
  PERMISSIONS.ADMIN_DASHBOARD,
  PERMISSIONS.FINANCE_MANAGE,
  PERMISSIONS.USER_MANAGE_ALL,
];

/** Define roles that MUST have 2FA enabled for core function access (e.g., all Admins). */
export const MFA_REQUIRED_ROLES: IUser['role'][] = ['admin'];
