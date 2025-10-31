import { Types } from 'mongoose';
import { UserModel, IUser } from '../models/user.model';
import { CreatorProfileModel, ICreatorProfile } from '../models/creatorProfile.model';
import {
  UserDTOMapper,
  UserPublicDTO,
  UserPrivateDTO,
  CreatorProfileDTO,
} from '../types/user-dtos';

// DTOs for Service Layer communication
interface IProfileUpdateData {
  preferredName?: string;
  fullName?: string;
  headline?: string;
  bio?: string;
  languages?: string[];
  skills?: string[];
  categories?: string[];
  hourlyRate?: number;
  projectRate?: number;
  locations?: string[];
  availability?: 'open' | 'busy' | 'invite-only';
}

export class UserProfileService {
  /**
   * Retrieves a user profile, handling visibility based on the requester.
   * @param targetUserId - The ID of the user whose profile is requested.
   * @param requesterRole - The role of the authenticated requester.
   * @param requesterId - The ID of the authenticated requester (for self-check).
   * @returns UserPublicDTO, UserPrivateDTO, or CreatorProfileDTO based on access level.
   */
  public async getUserProfile(
    targetUserId: string,
    requesterRole?: IUser['role'],
    requesterId?: string
  ): Promise<UserPublicDTO | UserPrivateDTO | CreatorProfileDTO> {
    const targetObjectId = new Types.ObjectId(targetUserId);

    // 1. Fetch User and Creator Profile Data
    const [user, creatorProfile] = await Promise.all([
      UserModel.findById(targetObjectId).lean() as Promise<IUser | null>,
      CreatorProfileModel.findOne({ userId: targetObjectId }).lean() as Promise<ICreatorProfile | null>,
    ]);

    if (!user) {
      throw new Error('UserNotFound');
    }

    // 2. Determine Access Level (Public, Owner, Admin)
    const isOwner = user._id?.toString() === requesterId;
    const isAdmin = requesterRole === 'admin';

    // 3. Use UserDTOMapper for consistent response shapes (Task-102 standard)
    if (user.role === 'creator') {
      // Creator profile
      const creatorDTO = UserDTOMapper.toCreatorDTO(user, creatorProfile);

      // Add private fields if owner or admin
      if (isOwner || isAdmin) {
        return {
          ...creatorDTO,
          email: user.email,
          fullName: user.fullName,
          status: user.status,
          twoFAEnabled: user.twoFA?.enabled || false,
          lastSeenAt: user.lastSeenAt?.toISOString(),
        };
      }

      return creatorDTO;
    }

    // For non-creator users (owner, admin)
    if (isOwner || isAdmin) {
      return UserDTOMapper.toPrivateDTO(user);
    }

    return UserDTOMapper.toPublicDTO(user);
  }

  /**
   * Updates a user's profile information across User and CreatorProfile models.
   */
  public async updateUserProfile(
    targetUserId: string,
    requesterId: string,
    requesterRole: IUser['role'],
    updateData: IProfileUpdateData
  ): Promise<UserPublicDTO | UserPrivateDTO | CreatorProfileDTO> {
    const targetObjectId = new Types.ObjectId(targetUserId);

    // 1. Security Check: Only self or Admin can update
    const isOwner = targetUserId === requesterId;
    const isAdmin = requesterRole === 'admin';
    if (!isOwner && !isAdmin) {
      throw new Error('PermissionDenied');
    }

    // 2. Separate Updates for User Model fields
    const userUpdate: Partial<IUser> = {};
    if (updateData.preferredName !== undefined) userUpdate.preferredName = updateData.preferredName;
    if (updateData.fullName !== undefined) userUpdate.fullName = updateData.fullName;

    if (Object.keys(userUpdate).length > 0) {
      await UserModel.updateOne({ _id: targetObjectId }, { $set: userUpdate });
    }

    // 3. Upsert/Update Creator Profile fields (only if creator role)
    const creatorUpdate: Partial<ICreatorProfile> = {};
    if (updateData.headline !== undefined) creatorUpdate.headline = updateData.headline;
    if (updateData.bio !== undefined) creatorUpdate.bio = updateData.bio;
    if (updateData.languages !== undefined) creatorUpdate.languages = updateData.languages;
    if (updateData.skills !== undefined) creatorUpdate.skills = updateData.skills;
    if (updateData.categories !== undefined) creatorUpdate.categories = updateData.categories;
    if (updateData.hourlyRate !== undefined) creatorUpdate.hourlyRate = updateData.hourlyRate;
    if (updateData.projectRate !== undefined) creatorUpdate.projectRate = updateData.projectRate;
    if (updateData.locations !== undefined) creatorUpdate.locations = updateData.locations;
    if (updateData.availability !== undefined) creatorUpdate.availability = updateData.availability;

    if (Object.keys(creatorUpdate).length > 0) {
      // Upsert: Create a profile if it doesn't exist (only needed for Creators)
      await CreatorProfileModel.updateOne(
        { userId: targetObjectId },
        { $set: creatorUpdate },
        { upsert: true }
      );
    }

    // 4. Fetch and return the updated profile using DTOMapper
    const updatedProfile = await this.getUserProfile(targetUserId, requesterRole, requesterId);

    // PRODUCTION: Emit 'user.profile.updated' event for Search Service indexing
    console.warn(`[Event] User ${targetUserId} profile updated.`);

    return updatedProfile;
  }
}

