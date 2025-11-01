// src/services/admin.service.ts
import { UserModel, IUser } from '../models/user.model';
import { AuditService } from './audit.service';
import { Types } from 'mongoose';

const auditService = new AuditService();

interface IAdminQueryFilters {
  status?: string;
  role?: string;
  q?: string;
  page?: number | string;
  per_page?: number | string;
}

export class AdminService {
  /** Admin function to list and search all users (Full DTO). */
  public async listAllUsers(filters: IAdminQueryFilters): Promise<any> {
    const { status, role, q, page = 1, per_page = 20 } = filters;
    const limit = parseInt(per_page.toString()) || 20;
    const skip = (parseInt(page.toString()) - 1) * limit || 0;

    const query: any = {};
    if (status) query.status = status;
    if (role) query.role = role;

    // Simple search simulation on email/name (real search engine would use Task 41)
    if (q) {
      query.$or = [
        { email: { $regex: q, $options: 'i' } },
        { fullName: { $regex: q, $options: 'i' } },
        { preferredName: { $regex: q, $options: 'i' } },
      ];
    }

    // 1. Execution (Include all fields for admin view, excluding password hash)
    const [totalResults, users] = await Promise.all([
      UserModel.countDocuments(query),
      UserModel.find(query)
        .select('-passwordHash') // Exclude password hash for security
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean() as Promise<IUser[]>,
    ]);

    // 2. Map to Admin Full DTO
    const data = users.map(user => ({
      id: user._id!.toString(),
      email: user.email,
      preferredName: user.preferredName,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
      verified: user.verified,
      createdAt: user.createdAt!.toISOString(),
      updatedAt: user.updatedAt!.toISOString(),
    }));

    return {
      meta: {
        page: parseInt(page.toString()) || 1,
        per_page: limit,
        total: totalResults,
        total_pages: Math.ceil(totalResults / limit),
      },
      data,
    };
  }

  /** Admin function to update a user's role. */
  public async updateUserRole(targetUserId: string, newRole: IUser['role'], adminId: string): Promise<IUser> {
    const targetObjectId = new Types.ObjectId(targetUserId);

    const user = await UserModel.findById(targetObjectId).lean() as IUser | null;
    if (!user) {
      throw new Error('UserNotFound');
    }

    const oldRole = user.role;

    // Prevent admin from demoting themselves (a common high-level security rule)
    if (targetUserId === adminId && newRole !== oldRole) {
      if (oldRole === 'admin' && newRole !== 'admin') {
        throw new Error('SelfDemotionForbidden');
      }
    }

    // 1. Update Role
    const updatedUser = await UserModel.findOneAndUpdate(
      { _id: targetObjectId },
      { $set: { role: newRole } },
      { new: true }
    ).lean() as IUser | null;

    if (!updatedUser) {
      throw new Error('UpdateFailed');
    }

    // 2. Audit Log (CRITICAL)
    await auditService.logAuditEntry({
      resourceType: 'user',
      resourceId: targetUserId,
      action: 'user.role.updated',
      actorId: adminId,
      actorRole: 'admin',
      details: { oldRole, newRole },
    });

    // 3. Return updated DTO (sanitized)
    return updatedUser;
  }
}

