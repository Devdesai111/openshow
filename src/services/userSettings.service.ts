// src/services/userSettings.service.ts
import { UserSettingsModel, IUserSettings, INotificationPrefs, IPayoutMethod } from '../models/userSettings.model';
import { Types } from 'mongoose';

// Default values for new user upsert
const DEFAULT_USER_SETTINGS: Omit<IUserSettings, '_id' | 'userId' | 'createdAt' | 'updatedAt'> = {
  notificationPrefs: { in_app: true, email: true, push: true },
};

// DTO for incoming updates (partial)
interface IUpdateSettingsDTO {
  notificationPrefs?: Partial<INotificationPrefs>;
  payoutMethod?: IPayoutMethod;
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
}

