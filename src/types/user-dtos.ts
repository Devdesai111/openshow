import { IUser } from '../models/user.model';

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
  status: 'active' | 'pending' | 'suspended' | 'deleted';
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

/**
 * Mapper class for converting User models to various DTO formats.
 */
export class UserDTOMapper {
  /**
   * Maps User model to public DTO (safe for any authenticated user).
   */
  static toPublicDTO(user: IUser): UserPublicDTO {
    const id = user._id?.toString() || '';
    const createdAt = user.createdAt?.toISOString() || new Date().toISOString();

    return {
      id,
      preferredName: user.preferredName || user.email.split('@')[0] || 'Anonymous',
      role: user.role,
      avatar: undefined, // Will be added in future tasks
      createdAt,
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
   * Note: CreatorProfile model will be implemented in Task 8.
   */
  static toCreatorDTO(
    user: IUser,
    profile: { headline?: string; bio?: string; verified?: boolean; skills?: string[]; languages?: string[]; rating?: { average: number; count: number }; hourlyRate?: { amount: number; currency?: string } } | null
  ): CreatorProfileDTO {
    return {
      ...this.toPublicDTO(user),
      headline: profile?.headline,
      bio: profile?.bio,
      verified: profile?.verified || false,
      skills: profile?.skills || [],
      languages: profile?.languages || [],
      rating: profile?.rating
        ? {
            average: profile.rating.average,
            count: profile.rating.count,
          }
        : undefined,
      hourlyRate: profile?.hourlyRate
        ? {
            amount: profile.hourlyRate.amount,
            currency: profile.hourlyRate.currency || 'USD',
            display: formatMoney(profile.hourlyRate.amount, profile.hourlyRate.currency || 'USD'),
          }
        : undefined,
    };
  }
}

