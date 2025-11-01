// src/services/userSettings.service.ts
import { UserSettingsModel, IUserSettings, INotificationPrefs, IPayoutMethod } from '../models/userSettings.model';
import { UserModel, IPushToken } from '../models/user.model';
import { AuditService } from './audit.service';
import { Types } from 'mongoose';

const auditService = new AuditService();

// Default values for new user upsert
const DEFAULT_USER_SETTINGS: Omit<IUserSettings, '_id' | 'userId' | 'createdAt' | 'updatedAt'> = {
  notificationPrefs: { in_app: true, email: true, push: true },
};

// DTO for incoming updates (partial)
interface IUpdateSettingsDTO {
  notificationPrefs?: Partial<INotificationPrefs>;
  payoutMethod?: IPayoutMethod;
}

// DTO for incoming push token registration
interface IPushTokenRegisterDTO {
  token: string;
  deviceId: string;
  provider: IPushToken['provider'];
}

// DTO for payout status updates (Admin only)
interface IPayoutStatusUpdateDTO {
  isVerified: boolean;
  providerAccountId: string;
  reason: string;
}

export class UserSettingsService {
  /**
   * Checks if the requester is the owner of the settings.
   * @param targetUserId - Target user ID
   * @param requesterId - Requester user ID
   * @throws {Error} 'PermissionDenied'
   */
  private checkOwnerAccess(targetUserId: string, requesterId: string): void {
    if (targetUserId !== requesterId) {
      throw new Error('PermissionDenied');
    }
  }

  /**
   * Retrieves settings, creating defaults if none exist (Upsert Read).
   * @param requesterId - User ID of the requester
   * @returns User settings (with defaults if new)
   */
  public async getUserSettings(requesterId: string): Promise<IUserSettings> {
    const userId = new Types.ObjectId(requesterId);

    // Find and Upsert (Ensures settings document always exists)
    const settings = await UserSettingsModel.findOneAndUpdate(
      { userId: userId },
      { $setOnInsert: { notificationPrefs: DEFAULT_USER_SETTINGS.notificationPrefs } },
      { new: true, upsert: true }
    ).lean() as IUserSettings;

    return settings;
  }

  /**
   * Updates user settings.
   * @param targetUserId - Target user ID
   * @param requesterId - Requester user ID (must match targetUserId)
   * @param data - Update data (partial)
   * @returns Updated user settings
   * @throws {Error} 'PermissionDenied', 'UpdateFailed'
   */
  public async updateUserSettings(
    targetUserId: string,
    requesterId: string,
    data: IUpdateSettingsDTO
  ): Promise<IUserSettings> {
    this.checkOwnerAccess(targetUserId, requesterId); // Authorization check

    const userId = new Types.ObjectId(targetUserId);
    const update: any = {};

    // 1. Handle Notification Preferences Update (Merge)
    if (data.notificationPrefs) {
      for (const key in data.notificationPrefs) {
        // Ensure key is a valid preference field
        if (['in_app', 'email', 'push'].includes(key)) {
          update[`notificationPrefs.${key}`] = (data.notificationPrefs as any)[key];
        }
      }
    }

    // 2. Handle Payout Method Update (Full object replacement/update)
    if (data.payoutMethod) {
      // Note: In a real app, this triggers a verification flow/job before setting 'isVerified=true'
      update.payoutMethod = data.payoutMethod;
    }

    // 3. Execute Update
    const updatedSettings = await UserSettingsModel.findOneAndUpdate(
      { userId: userId },
      { $set: update },
      { new: true, upsert: true }
    ).lean() as IUserSettings;

    if (!updatedSettings) {
      throw new Error('UpdateFailed');
    }

    // PRODUCTION: Emit 'user.settings.updated' event
    console.warn(`[Event] User ${targetUserId} settings updated.`);

    return updatedSettings;
  }

  /**
   * Registers a new push token for the authenticated user.
   * @param requesterId - User ID of requester
   * @param data - Push token registration data
   * @throws {Error} - May throw database errors
   */
  public async registerPushToken(requesterId: string, data: IPushTokenRegisterDTO): Promise<void> {
    const userId = new Types.ObjectId(requesterId);

    // 1. Find existing token or device for update/upsert
    const user = await UserModel.findById(userId);
    if (!user) {
      throw new Error('UserNotFound');
    }

    const existingTokenIndex = user.pushTokens.findIndex(pt => pt.token === data.token);
    const existingDeviceIndex = user.pushTokens.findIndex(pt => pt.deviceId === data.deviceId);

    // 2. Prepare new token structure
    const newToken: IPushToken = {
      token: data.token,
      deviceId: data.deviceId,
      provider: data.provider,
      lastUsed: new Date(),
    };

    if (existingTokenIndex >= 0) {
      // Case 1: Token exists (e.g., re-registration/update) -> Update lastUsed
      await UserModel.updateOne(
        { _id: userId, 'pushTokens.token': data.token },
        { $set: { 'pushTokens.$.lastUsed': new Date() } }
      );
    } else if (existingDeviceIndex >= 0) {
      // Case 2: Device exists with OLD token -> Remove old token and add new one
      await UserModel.updateOne(
        { _id: userId },
        { $pull: { pushTokens: { deviceId: data.deviceId } } }
      );
      await UserModel.updateOne({ _id: userId }, { $push: { pushTokens: newToken } });
    } else {
      // Case 3: Completely new token/device -> Push new token
      await UserModel.updateOne({ _id: userId }, { $push: { pushTokens: newToken } });
    }

    // PRODUCTION: Emit 'user.pushToken.registered' event
    console.warn(`[Event] User ${requesterId} registered push token for device ${data.deviceId}.`);
  }

  /**
   * Deletes a specified push token (e.g., on app uninstall or logout).
   * @param requesterId - User ID of requester
   * @param token - Push token to delete
   * @throws {Error} - 'TokenNotFound' if token doesn't exist
   */
  public async deletePushToken(requesterId: string, token: string): Promise<void> {
    const userId = new Types.ObjectId(requesterId);

    // Check if token exists first
    const user = await UserModel.findById(userId);
    if (!user) {
      throw new Error('UserNotFound');
    }

    const tokenExists = user.pushTokens.some(pt => pt.token === token);
    if (!tokenExists) {
      throw new Error('TokenNotFound');
    }

    // Atomic pull operation
    await UserModel.updateOne(
      { _id: userId },
      { $pull: { pushTokens: { token: token } } }
    );

    // PRODUCTION: Emit 'user.pushToken.deleted' event
    console.warn(`[Event] User ${requesterId} deleted push token.`);
  }

  /**
   * Admin function to manually update a user's payout status (KYC/Verification override).
   * @param targetUserId - Target user ID
   * @param adminId - Admin user ID
   * @param data - Payout status update data
   * @returns Updated user settings
   * @throws {Error} 'UpdateFailed'
   */
  public async updatePayoutStatus(
    targetUserId: string,
    adminId: string,
    data: IPayoutStatusUpdateDTO
  ): Promise<IUserSettings> {
    const targetObjectId = new Types.ObjectId(targetUserId);

    // 0. Validate user exists first
    const userExists = await UserModel.exists({ _id: targetObjectId });
    if (!userExists) {
      throw new Error('UserNotFound');
    }

    // 1. Execute Update (Uses upsert=true to ensure settings exist)
    const updatedSettings = await UserSettingsModel.findOneAndUpdate(
      { userId: targetObjectId },
      {
        $set: {
          payoutMethod: {
            type: 'stripe_connect', // Default type when creating from admin
            isVerified: data.isVerified,
            providerAccountId: data.providerAccountId,
            details: {}, // Empty details (sensitive)
          },
        },
      },
      { new: true, upsert: true }
    ).lean() as IUserSettings;

    if (!updatedSettings) {
      throw new Error('UpdateFailed');
    }

    // 2. Audit Log (CRITICAL)
    await auditService.logAuditEntry({
      resourceType: 'user_payout',
      resourceId: targetUserId,
      action: data.isVerified ? 'payout.kyc_verified' : 'payout.kyc_unverified',
      actorId: adminId,
      actorRole: 'admin',
      details: {
        isVerified: data.isVerified,
        providerAccountId: data.providerAccountId,
        reason: data.reason,
      },
    });

    // 3. Return DTO (Redacted Details)
    const settingsDTO = { ...updatedSettings };
    // Don't return sensitive payoutMethod details
    if ((settingsDTO as any).payoutMethod) {
      delete (settingsDTO as any).payoutMethod.details;
    }

    return settingsDTO;
  }
}

