// src/services/admin.service.ts
import { UserModel, IUser } from '../models/user.model';
import { DisputeRecordModel, IDisputeRecord, IResolution } from '../models/disputeRecord.model';
import { EscrowModel } from '../models/escrow.model';
import { AuditService } from './audit.service';
import { PaymentService } from './payment.service';
import { Types } from 'mongoose';

const auditService = new AuditService();
const paymentService = new PaymentService();

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

  interface IResolveDisputeDTO {
    resolution: 'release' | 'refund' | 'split' | 'deny';
    releaseAmount?: number;
    refundAmount?: number;
    notes: string;
  }

  /** Admin function to retrieve the dispute queue. */
  public async getDisputeQueue(filters: any): Promise<any> {
    const { status, page = 1, per_page = 20 } = filters;
    const limit = parseInt(per_page.toString()) || 20;
    const skip = (parseInt(page.toString()) - 1) * limit || 0;

    const query: any = {};
    if (status) query.status = status;

    // Execution
    const [totalResults, disputes] = await Promise.all([
      DisputeRecordModel.countDocuments(query),
      DisputeRecordModel.find(query)
        .sort({ createdAt: 1 }) // Oldest disputes first
        .skip(skip)
        .limit(limit)
        .lean() as Promise<IDisputeRecord[]>,
    ]);

    return {
      meta: {
        page: parseInt(page.toString()) || 1,
        per_page: limit,
        total: totalResults,
        total_pages: Math.ceil(totalResults / limit),
      },
      data: disputes.map(d => ({
        disputeId: d.disputeId,
        projectId: d.projectId.toString(),
        escrowId: d.escrowId.toString(),
        milestoneId: d.milestoneId.toString(),
        raisedBy: d.raisedBy.toString(),
        status: d.status,
        reason: d.reason,
        resolution: d.resolution ? {
          outcome: d.resolution.outcome,
          resolvedAmount: d.resolution.resolvedAmount,
          refundAmount: d.resolution.refundAmount,
          resolvedAt: d.resolution.resolvedAt.toISOString(),
        } : undefined,
        createdAt: d.createdAt!.toISOString(),
        updatedAt: d.updatedAt!.toISOString(),
      })),
    };
  }

  /** Manually resolves a financial dispute. */
  public async resolveDispute(
    disputeId: string,
    adminId: string,
    resolutionData: IResolveDisputeDTO
  ): Promise<IDisputeRecord> {
    const dispute = await DisputeRecordModel.findOne({
      disputeId,
      status: { $in: ['open', 'under_review'] },
    });
    if (!dispute) {
      throw new Error('DisputeNotFoundOrResolved');
    }

    const { resolution, releaseAmount = 0, refundAmount = 0, notes } = resolutionData;

    // Fetch escrow to get escrowId string
    const escrow = await EscrowModel.findById(dispute.escrowId).lean();
    if (!escrow) {
      throw new Error('EscrowNotFound');
    }

    // 1. FINANCIAL ORCHESTRATION (CRITICAL)
    let totalReleased = 0;

    if (resolution === 'release') {
      // Release full escrow amount
      await paymentService.releaseEscrow(
        escrow.escrowId, // Use string escrowId
        adminId,
        'admin',
        undefined // Full amount
      );
      totalReleased = escrow.amount;
    } else if (resolution === 'refund') {
      // Refund full escrow amount
      await paymentService.refundEscrow(
        escrow.escrowId, // Use string escrowId
        adminId,
        'admin',
        escrow.amount, // Full amount
        notes
      );
      totalReleased = 0; // No release for full refund
    } else if (resolution === 'split') {
      // Split: release partial and refund partial
      if (releaseAmount && releaseAmount > 0) {
        await paymentService.releaseEscrow(
          escrow.escrowId,
          adminId,
          'admin',
          releaseAmount
        );
        totalReleased += releaseAmount;
      }
      if (refundAmount && refundAmount > 0) {
        await paymentService.refundEscrow(
          escrow.escrowId,
          adminId,
          'admin',
          refundAmount,
          notes
        );
        totalReleased -= refundAmount;
      }
    } else if (resolution === 'deny') {
      // Deny resolution - no financial action, just close dispute
      // No payment service calls for deny
      totalReleased = 0;
    }

    // 2. Update Dispute Record
    const resolutionEntry: IResolution = {
      outcome: resolution,
      resolvedAmount: totalReleased > 0 ? totalReleased : 0,
      refundAmount: refundAmount || 0,
      notes,
      resolvedBy: new Types.ObjectId(adminId),
      resolvedAt: new Date(),
    };

    dispute.status = 'resolved';
    dispute.resolution = resolutionEntry;
    dispute.assignedTo = new Types.ObjectId(adminId);
    const updatedDispute = await dispute.save();

    // 3. Audit Log
    await auditService.logAuditEntry({
      resourceType: 'dispute',
      resourceId: dispute._id!.toString(),
      action: `dispute.resolved.${resolution}`,
      actorId: adminId,
      actorRole: 'admin',
      details: {
        escrowId: escrow.escrowId,
        disputeId: dispute.disputeId,
        resolution: resolutionEntry,
      },
    });

    return updatedDispute.toObject() as IDisputeRecord;
  }
}

