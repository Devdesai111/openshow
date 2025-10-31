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

// DTO for incoming portfolio data
interface IPortfolioData {
  title?: string;
  description?: string;
  assetId?: string; // string representation of ObjectId
  externalLink?: string;
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

  /**
   * Adds a new portfolio item to a creator's profile.
   * @throws {Error} - 'UserNotFound', 'PortfolioDataMissing'.
   */
  public async addPortfolioItem(
    creatorId: string,
    itemData: IPortfolioData
  ): Promise<{ id: string; title?: string; description?: string; assetId?: string; externalLink?: string }> {
    const creatorObjectId = new Types.ObjectId(creatorId);

    // 1. Validation: Must have at least assetId or externalLink
    if (!itemData.assetId && !itemData.externalLink) {
      throw new Error('PortfolioDataMissing');
    }

    // 2. Build new item object (Mongoose will assign _id on push)
    const newItemId = new Types.ObjectId();
    const newItem = {
      _id: newItemId,
      title: itemData.title,
      description: itemData.description,
      assetId: itemData.assetId ? new Types.ObjectId(itemData.assetId) : undefined,
      externalLink: itemData.externalLink,
    };

    // 3. Push new item to the embedded array
    const updatedProfile = await CreatorProfileModel.findOneAndUpdate(
      { userId: creatorObjectId },
      { $push: { portfolioItems: newItem } },
      { new: true, upsert: true }
    );

    if (!updatedProfile) {
      throw new Error('UserNotFound');
    }

    // 4. Return the newly created item
    const addedItem = updatedProfile.portfolioItems.find(item =>
      item._id?.equals(newItemId)
    );

    if (!addedItem) {
      throw new Error('InternalSaveFailed');
    }

    // PRODUCTION: Emit 'creator.portfolio.added' event
    console.warn(`[Event] Creator ${creatorId} added portfolio item ${addedItem._id?.toString()}`);

    // Return sanitized DTO with string IDs
    return {
      id: addedItem._id?.toString() || '',
      title: addedItem.title,
      description: addedItem.description,
      assetId: addedItem.assetId?.toString(),
      externalLink: addedItem.externalLink,
    };
  }

  /**
   * Updates an existing portfolio item.
   * @throws {Error} - 'ProfileNotFound', 'ItemNotFound', 'PermissionDenied'.
   */
  public async updatePortfolioItem(
    creatorId: string,
    itemId: string,
    updateData: IPortfolioData
  ): Promise<{ id: string; title?: string; description?: string; assetId?: string; externalLink?: string }> {
    const creatorObjectId = new Types.ObjectId(creatorId);
    const itemObjectId = new Types.ObjectId(itemId);

    // 1. Build dynamic update path for the embedded subdocument
    const setUpdate: Record<string, unknown> = {};
    if (updateData.title !== undefined) setUpdate['portfolioItems.$.title'] = updateData.title;
    if (updateData.description !== undefined)
      setUpdate['portfolioItems.$.description'] = updateData.description;

    // Handle assetId/externalLink mutual exclusivity or updates
    if (updateData.assetId !== undefined) {
      setUpdate['portfolioItems.$.assetId'] = updateData.assetId
        ? new Types.ObjectId(updateData.assetId)
        : null;
      setUpdate['portfolioItems.$.externalLink'] = null;
    }
    if (updateData.externalLink !== undefined) {
      setUpdate['portfolioItems.$.externalLink'] = updateData.externalLink;
      setUpdate['portfolioItems.$.assetId'] = null;
    }

    // 2. Execute atomic update
    const updatedProfile = await CreatorProfileModel.findOneAndUpdate(
      {
        userId: creatorObjectId,
        'portfolioItems._id': itemObjectId,
      },
      { $set: setUpdate },
      { new: true }
    );

    if (!updatedProfile) {
      throw new Error('ItemNotFound');
    }

    // 3. Return the specific updated item
    const updatedItem = updatedProfile.portfolioItems.find(item => item._id?.equals(itemObjectId));

    if (!updatedItem) {
      throw new Error('ItemNotFound');
    }

    // PRODUCTION: Emit 'creator.portfolio.updated' event
    console.warn(`[Event] Creator ${creatorId} updated portfolio item ${itemId}`);

    return {
      id: updatedItem._id?.toString() || '',
      title: updatedItem.title,
      description: updatedItem.description,
      assetId: updatedItem.assetId?.toString(),
      externalLink: updatedItem.externalLink,
    };
  }

  /**
   * Deletes a portfolio item.
   * @throws {Error} - 'ItemNotFound'.
   */
  public async deletePortfolioItem(creatorId: string, itemId: string): Promise<void> {
    const creatorObjectId = new Types.ObjectId(creatorId);
    const itemObjectId = new Types.ObjectId(itemId);

    // 1. First check if the item exists
    const profile = await CreatorProfileModel.findOne({ userId: creatorObjectId });

    if (!profile) {
      const userExists = await UserModel.exists({ _id: creatorObjectId });
      if (!userExists) {
        throw new Error('UserNotFound');
      }
      throw new Error('ItemNotFound');
    }

    // Check if the specific item exists in the portfolio
    const itemExists = profile.portfolioItems.some(item => item._id?.equals(itemObjectId));
    if (!itemExists) {
      throw new Error('ItemNotFound');
    }

    // 2. Execute atomic pull operation (remove from embedded array)
    await CreatorProfileModel.updateOne(
      { userId: creatorObjectId },
      { $pull: { portfolioItems: { _id: itemObjectId } } }
    );

    // PRODUCTION: Emit 'creator.portfolio.deleted' event
    console.warn(`[Event] Creator ${creatorId} deleted portfolio item ${itemId}`);
  }
}

