import { VerificationApplicationModel, IVerificationApplication, IEvidence } from '../models/verificationApplication.model';
import { CreatorProfileModel } from '../models/creatorProfile.model';
import { Types } from 'mongoose';

// Mock Event Emitter
class MockEventEmitter {
  public emit(event: string, payload: any): void {
    console.warn(`[EVENT EMITTED] ${event}:`, JSON.stringify(payload));
  }
}
const eventEmitter = new MockEventEmitter();

interface ISubmitApplicationDTO {
  statement?: string;
  evidence: Array<{
    type: string;
    assetId?: string;
    url?: string;
    notes?: string;
  }>;
}

export class VerificationService {
  /**
   * Submits a new verification application by a creator.
   * @param userId - Creator user ID submitting the application
   * @param data - Application data including evidence
   * @returns Created application
   * @throws {Error} - 'ApplicationPending', 'NoEvidence'
   */
  public async submitApplication(userId: string, data: ISubmitApplicationDTO): Promise<IVerificationApplication> {
    const userObjectId = new Types.ObjectId(userId);

    // 1. Check for existing pending application (Business Rule: one pending at a time)
    const existingApp = await VerificationApplicationModel.findOne({ userId: userObjectId, status: 'pending' });
    if (existingApp) {
      throw new Error('ApplicationPending');
    }

    // 2. Map Evidence DTO and validate minimal structure
    const evidence: IEvidence[] = data.evidence.map(e => ({
      type: e.type as IEvidence['type'],
      assetId: e.assetId ? new Types.ObjectId(e.assetId) : undefined,
      url: e.url,
      notes: e.notes,
      isSensitive: e.type === 'id_document', // Auto-flag PII
    }));
    if (evidence.length === 0) {
      throw new Error('NoEvidence');
    }

    // 3. Validate each evidence item has either assetId or url
    for (const ev of evidence) {
      if (!ev.assetId && !ev.url) {
        throw new Error('EvidenceInvalid');
      }
    }

    // 4. Create Application
    const newApplication = new VerificationApplicationModel({
      userId: userObjectId,
      statement: data.statement,
      evidence,
      status: 'pending',
    });
    const savedApp = await newApplication.save();

    // PRODUCTION: Emit 'verification.application.submitted' event (Task 11 subscribes)
    eventEmitter.emit('verification.application.submitted', { applicationId: savedApp.applicationId, userId });

    return savedApp.toObject() as IVerificationApplication;
  }

  /**
   * Retrieves the admin review queue.
   * @param status - Status filter (default: 'pending')
   * @param page - Page number
   * @param per_page - Items per page
   * @returns Paginated list of applications
   */
  public async getAdminQueue(
    status: string = 'pending',
    page: number = 1,
    per_page: number = 20
  ): Promise<{
    data: Array<{
      applicationId: string;
      userId: string;
      status: string;
      submittedAt: string;
      evidenceCount: number;
    }>;
    meta: {
      page: number;
      per_page: number;
      total: number;
      total_pages: number;
    };
  }> {
    const filters: Record<string, any> = { status };
    const limit = Math.min(per_page, 50);
    const pageNum = page;
    const skip = (pageNum - 1) * limit;

    // PRODUCTION: Use aggregation to pull in user name from UserModel
    const [totalResults, applications] = await Promise.all([
      VerificationApplicationModel.countDocuments(filters),
      VerificationApplicationModel.find(filters)
        .sort({ createdAt: 1 }) // Oldest first
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const totalPages = Math.ceil(totalResults / limit) || 1;

    return {
      meta: {
        page: pageNum,
        per_page: limit,
        total: totalResults,
        total_pages: totalPages,
      },
      data: (applications as IVerificationApplication[]).map(app => ({
        applicationId: app.applicationId,
        userId: app.userId.toString(),
        status: app.status,
        submittedAt: app.createdAt!.toISOString(),
        evidenceCount: app.evidence.length,
      })),
    };
  }

  /**
   * Approves a verification application with atomic update.
   * @param applicationId - Application ID to approve
   * @param adminId - Admin user ID approving
   * @param adminNotes - Admin review notes
   * @returns Updated application
   * @throws {Error} - 'ApplicationNotFoundOrProcessed', 'TransactionFailed'
   */
  public async approveApplication(
    applicationId: string,
    adminId: string,
    adminNotes: string
  ): Promise<IVerificationApplication> {
    const reviewedAt = new Date();
    const reviewedBy = new Types.ObjectId(adminId);

    try {
      // Try to use transactions (requires replica set in production)
      const session = await VerificationApplicationModel.startSession();
      session.startTransaction();

      try {
        // 1. Find and update application within transaction
        const application = await VerificationApplicationModel.findOneAndUpdate(
          {
            applicationId,
            status: { $in: ['pending', 'needs_more_info'] },
          },
          {
            $set: {
              status: 'approved',
              reviewedBy,
              reviewedAt,
              adminNotes,
            },
          },
          { session, new: true }
        );

        if (!application) {
          await session.abortTransaction();
          session.endSession();
          throw new Error('ApplicationNotFoundOrProcessed');
        }

        // 2. Update Creator Profile (Atomic with transaction)
        await CreatorProfileModel.updateOne(
          { userId: application.userId },
          {
            $set: {
              verified: true,
              verificationBadgeMeta: {
                verifiedAt: reviewedAt,
                verifierId: reviewedBy,
              },
            },
          },
          { session, upsert: true } // Ensure profile exists
        );

        await session.commitTransaction();
        session.endSession();

        // 3. Emit Event
        eventEmitter.emit('verification.approved', {
          applicationId,
          userId: application.userId.toString(),
          verifiedAt: reviewedAt.toISOString(),
        });

        return application.toObject() as IVerificationApplication;
      } catch (error) {
        await session.abortTransaction();
        session.endSession();
        if (error instanceof Error && error.message === 'ApplicationNotFoundOrProcessed') {
          throw error;
        }
        throw error;
      }
    } catch (error) {
      // Fallback: If transactions aren't supported (e.g., standalone MongoDB), use sequential updates
      if (error instanceof Error && error.message.includes('Transaction numbers are only allowed on a replica set')) {
        // Sequential updates (not atomic, but works in test environments)
        const application = await VerificationApplicationModel.findOneAndUpdate(
          {
            applicationId,
            status: { $in: ['pending', 'needs_more_info'] },
          },
          {
            $set: {
              status: 'approved',
              reviewedBy,
              reviewedAt,
              adminNotes,
            },
          },
          { new: true }
        );

        if (!application) {
          throw new Error('ApplicationNotFoundOrProcessed');
        }

        // Update Creator Profile
        await CreatorProfileModel.updateOne(
          { userId: application.userId },
          {
            $set: {
              verified: true,
              verificationBadgeMeta: {
                verifiedAt: reviewedAt,
                verifierId: reviewedBy,
              },
            },
          },
          { upsert: true }
        );

        // Emit Event
        eventEmitter.emit('verification.approved', {
          applicationId,
          userId: application.userId.toString(),
          verifiedAt: reviewedAt.toISOString(),
        });

        return application.toObject() as IVerificationApplication;
      }

      // Re-throw other errors
      if (error instanceof Error && error.message === 'ApplicationNotFoundOrProcessed') {
        throw error;
      }
      throw new Error('TransactionFailed');
    }
  }

  /**
   * Rejects a verification application.
   * @param applicationId - Application ID to reject
   * @param adminId - Admin user ID rejecting
   * @param adminNotes - Admin review notes
   * @param action - Rejection action ('rejected' or 'needs_more_info')
   * @returns Updated application
   * @throws {Error} - 'ApplicationNotFoundOrProcessed'
   */
  public async rejectApplication(
    applicationId: string,
    adminId: string,
    adminNotes: string,
    action: 'rejected' | 'needs_more_info'
  ): Promise<IVerificationApplication> {
    const application = await VerificationApplicationModel.findOne({
      applicationId,
      status: { $in: ['pending', 'needs_more_info'] },
    });
    if (!application) {
      throw new Error('ApplicationNotFoundOrProcessed');
    }

    // 1. Update Application Status
    application.status = action;
    application.reviewedBy = new Types.ObjectId(adminId);
    application.reviewedAt = new Date();
    application.adminNotes = adminNotes;
    const savedApp = await application.save();

    // 2. Emit Event
    eventEmitter.emit('verification.rejected', {
      applicationId,
      userId: application.userId.toString(),
      status: action,
    });

    return savedApp.toObject() as IVerificationApplication;
  }
}

