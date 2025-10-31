// src/services/revenue.service.ts
import { ProjectModel, IProject } from '../models/project.model';
import { calculateRevenueSplit } from '../utils/revenueCalculator';
import { PayoutBatchModel, IPayoutBatch, IPayoutItem } from '../models/payout.model';
import { IAuthUser } from '../middleware/auth.middleware';
import { getExponentialBackoffDelay, isRetryAllowed } from '../utils/retryPolicy';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

// Mock Job Queue for payout execution (Task 58 dependency)
class MockJobQueue {
  public enqueuePayoutJob(batchId: string, delayMs: number = 0): string {
    console.warn(`[Job Enqueued] Payout execution for Batch ${batchId} scheduled in ${delayMs / 1000}s.`);
    return `job_payout_${crypto.randomBytes(4).toString('hex')}`;
  }
  public enqueueEscalationJob(payoutItemId: string, reason: string): void {
    console.warn(`[Job Enqueued] ADMIN ESCALATION for Payout ${payoutItemId}. Reason: ${reason}`);
  }
}
const jobQueue = new MockJobQueue();

// Mock Event Emitter
class MockEventEmitter {
  public emit(event: string, payload: any): void {
    console.warn(`[EVENT EMITTED] ${event}:`, JSON.stringify(payload));
  }
}
const eventEmitter = new MockEventEmitter();

interface ISchedulePayoutsRequestDTO {
  escrowId: string;
  projectId: string;
  milestoneId?: string;
  amount: number; // Total escrow amount
  currency: string;
}

// Reusable interface for Payout List DTO
interface IPayoutListItemDTO {
  payoutItemId: string;
  projectId: string;
  netAmount: number;
  status: string;
  createdAt?: string;
  fees: number;
}

export class RevenueService {
  /**
   * Calculates the revenue split breakdown for a given amount, using Project data or provided splits.
   * @param data - Contains amount, currency, and optional projectId/revenueModel override.
   * @returns Revenue breakdown with platform fees and distribution
   * @throws {Error} - 'ProjectNotFound', 'RevenueModelNotFound'
   */
  public async calculateRevenueSplit(data: {
    projectId?: string;
    amount: number;
    currency: string;
    revenueModel?: { splits: any[] };
  }): Promise<any> {
    const { projectId, amount, currency, revenueModel } = data;

    let splits: any[] = revenueModel?.splits || [];

    // 1. Fetch splits from Project if not provided
    if (projectId && splits.length === 0) {
      const project = (await ProjectModel.findById(new Types.ObjectId(projectId))
        .select('revenueSplits')
        .lean()) as IProject | null;
      if (!project) {
        throw new Error('ProjectNotFound');
      }
      splits = project.revenueSplits || [];
    }

    if (!splits || splits.length === 0) {
      throw new Error('RevenueModelNotFound');
    }

    // 2. Execute Deterministic Calculation
    const result = calculateRevenueSplit({ amount, splits });

    return { ...result, currency };
  }

  /**
   * Schedules payouts for a released escrow amount.
   * @param requesterId - User ID scheduling (must be admin/system)
   * @param data - Escrow release data
   * @returns Created payout batch
   * @throws {Error} - 'PayoutAlreadyScheduled', 'ProjectNotFound', 'RevenueModelNotFound'
   */
  public async schedulePayouts(
    requesterId: string,
    data: ISchedulePayoutsRequestDTO
  ): Promise<IPayoutBatch> {
    const { escrowId, projectId, milestoneId, amount, currency } = data;
    const escrowObjectId = new Types.ObjectId(escrowId);
    const projectObjectId = new Types.ObjectId(projectId);

    // 1. IDEMPOTENCY CHECK (CRITICAL)
    const existingBatch = await PayoutBatchModel.findOne({ escrowId: escrowObjectId });
    if (existingBatch) {
      throw new Error('PayoutAlreadyScheduled');
    }

    // 2. Calculate Final Breakdown (Leverage Task 31 logic)
    const breakdown = await this.calculateRevenueSplit({ projectId, amount, currency });

    // 3. Map Breakdown to Payout Items
    const payoutItems: IPayoutItem[] = breakdown.breakdown.map((share: any) => {
      // NOTE: We assume recipientId is a valid userId for payout (further KYC checks later)
      // Skip items with placeholder (not assigned to a user yet)
      if (!share.recipientId || share.placeholder) {
        return null;
      }

      return {
        userId: new Types.ObjectId(share.recipientId),
        amount: share.grossShare,
        fees: share.platformFeeShare,
        taxWithheld: 0, // No tax withholding in Phase 1
        netAmount: share.netAmount,
        status: 'scheduled' as const,
        attempts: 0,
      };
    }).filter((item: IPayoutItem | null): item is IPayoutItem => item !== null); // Filter out null items (placeholders)

    // Validate that we have at least one payout item
    if (payoutItems.length === 0) {
      throw new Error('NoRecipientsForPayout'); // All splits are placeholders
    }

    // 4. Create Payout Batch Record
    const newBatch = new PayoutBatchModel({
      escrowId: escrowObjectId,
      projectId: projectObjectId,
      milestoneId: milestoneId ? new Types.ObjectId(milestoneId) : undefined,
      scheduledBy: new Types.ObjectId(requesterId),
      currency,
      items: payoutItems,
      totalNet: breakdown.totalDistributed,
      status: 'scheduled',
    });
    const savedBatch = await newBatch.save();

    // 5. Enqueue Execution Job (Task 58)
    const jobId = jobQueue.enqueuePayoutJob(savedBatch.batchId);

    // PRODUCTION: Emit 'payout.batch.scheduled' event
    eventEmitter.emit('payout.batch.scheduled', { batchId: savedBatch.batchId, jobId });

    return savedBatch.toObject() as IPayoutBatch;
  }

  /**
   * Lists a user's payouts with pagination and status filters.
   * @param requesterId - User ID of requester
   * @param requesterRole - Role of requester
   * @param queryParams - Query parameters (status, page, per_page)
   * @returns Paginated list of payout items
   */
  public async listUserPayouts(
    requesterId: string,
    requesterRole: IAuthUser['role'],
    queryParams: {
      status?: string;
      page?: number | string;
      per_page?: number | string;
    }
  ): Promise<{
    meta: {
      page: number;
      per_page: number;
      total: number;
      total_pages: number;
    };
    data: IPayoutListItemDTO[];
  }> {
    const { status, page = 1, per_page = 20 } = queryParams;
    const limit = typeof per_page === 'number' ? per_page : parseInt(per_page, 10);
    const pageNum = typeof page === 'number' ? page : parseInt(page, 10);
    const skip = (pageNum - 1) * limit;
    const recipientObjectId = new Types.ObjectId(requesterId);

    // Authorization: Non-admin users only see their own payouts
    // Admin users can see all payouts (no userId filter)
    const userIdFilter: any = requesterRole === 'admin' ? {} : { 'items.userId': recipientObjectId };

    const pipeline: any[] = [];

    // 1. Match Payout Batches relevant to the recipient
    const matchStage: any = {
      ...userIdFilter,
    };

    // If status filter is provided and user is not admin, filter items by status
    if (status) {
      matchStage['items.status'] = status;
    }

    pipeline.push({ $match: matchStage });

    // 2. Unwind the items array (de-normalize the embedded documents)
    pipeline.push({ $unwind: '$items' });

    // 3. Re-match to filter out items not belonging to the recipient (necessary after unwind)
    const itemMatchStage: any = {};
    if (requesterRole !== 'admin') {
      itemMatchStage['items.userId'] = recipientObjectId;
    }
    if (status) {
      itemMatchStage['items.status'] = status;
    }
    pipeline.push({ $match: itemMatchStage });

    // 4. Group (Count Total and Prepare for Final Projection)
    const countPipeline = [...pipeline]; // Copy pipeline up to $match
    countPipeline.push({ $count: 'total' });

    // 5. Sort, Skip, and Limit
    pipeline.push({ $sort: { 'items.createdAt': -1 } }); // Sort by item creation date
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limit });

    // 6. Final Projection to DTO
    pipeline.push({
      $project: {
        _id: 0,
        payoutItemId: { $toString: '$items._id' },
        projectId: { $toString: '$projectId' },
        netAmount: '$items.netAmount',
        fees: '$items.fees',
        status: '$items.status',
        createdAt: { $ifNull: ['$items.createdAt', '$createdAt'] }, // Use batch createdAt if item createdAt is missing
      },
    });

    const [totalResults, payouts] = await Promise.all([
      PayoutBatchModel.aggregate(countPipeline),
      PayoutBatchModel.aggregate(pipeline),
    ]);

    const total = totalResults.length > 0 ? (totalResults[0].total as number) : 0;

    return {
      meta: {
        page: pageNum,
        per_page: limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
      data: payouts as IPayoutListItemDTO[],
    };
  }

  /**
   * Retrieves detailed information for a single payout item.
   * @param payoutItemId - Payout item ID
   * @param requesterId - User ID of requester
   * @param requesterRole - Role of requester
   * @returns Payout item details
   * @throws {Error} - 'PayoutNotFound', 'PermissionDenied'
   */
  public async getPayoutDetails(
    payoutItemId: string,
    requesterId: string,
    requesterRole: IAuthUser['role']
  ): Promise<{
    payoutItemId: string;
    projectId: string;
    escrowId: string;
    userId: string;
    amount: number;
    fees: number;
    taxWithheld: number;
    netAmount: number;
    status: string;
    providerPayoutId?: string;
    failureReason?: string;
    attempts: number;
    processedAt?: string;
  }> {
    const itemObjectId = new Types.ObjectId(payoutItemId);

    // 1. Find the item within its batch
    const batch = await PayoutBatchModel.findOne({ 'items._id': itemObjectId }).lean();
    if (!batch) {
      throw new Error('PayoutNotFound');
    }

    const item = batch.items.find(i => i._id?.equals(itemObjectId));
    if (!item) {
      throw new Error('PayoutNotFound');
    }

    // 2. Authorization Check (Self or Admin)
    const isRecipient = item.userId.toString() === requesterId;
    const isAdmin = requesterRole === 'admin';

    if (!isRecipient && !isAdmin) {
      throw new Error('PermissionDenied'); // Security by obscurity (404/403)
    }

    // 3. Map to DTO
    return {
      payoutItemId: item._id!.toString(),
      projectId: batch.projectId?.toString() || '',
      escrowId: batch.escrowId.toString(),
      userId: item.userId.toString(),
      amount: item.amount,
      fees: item.fees,
      taxWithheld: item.taxWithheld,
      netAmount: item.netAmount,
      status: item.status,
      providerPayoutId: item.providerPayoutId,
      failureReason: item.failureReason,
      attempts: item.attempts,
      processedAt: item.processedAt?.toISOString(),
    };
  }

  /**
   * Admin function to list ALL payout batches.
   * @param queryParams - Query parameters (status, projectId, page, per_page)
   * @returns Paginated list of all payout batches
   */
  public async listAllPayoutBatches(queryParams: {
    status?: string;
    projectId?: string;
    page?: number | string;
    per_page?: number | string;
  }): Promise<{
    meta: {
      page: number;
      per_page: number;
      total: number;
      total_pages: number;
    };
    data: Array<{
      batchId: string;
      escrowId: string;
      projectId?: string;
      milestoneId?: string;
      scheduledBy: string;
      currency: string;
      totalNet: number;
      status: string;
      items: Array<{
        payoutItemId?: string;
        userId: string;
        amount: number;
        fees: number;
        taxWithheld: number;
        netAmount: number;
        status: string;
        providerPayoutId?: string;
        failureReason?: string;
        attempts: number;
        processedAt?: string;
      }>;
      createdAt: string;
      updatedAt?: string;
    }>;
  }> {
    const { status, projectId, page = 1, per_page = 20 } = queryParams;
    const limit = typeof per_page === 'number' ? per_page : parseInt(per_page, 10);
    const pageNum = typeof page === 'number' ? page : parseInt(page, 10);
    const skip = (pageNum - 1) * limit;

    const filters: Record<string, any> = {};
    if (status) {
      filters.status = status;
    }
    if (projectId) {
      filters.projectId = new Types.ObjectId(projectId);
    }

    // Execution
    const [totalResults, batches] = await Promise.all([
      PayoutBatchModel.countDocuments(filters),
      PayoutBatchModel.find(filters)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // Map to Admin DTO (includes full items array)
    const data = batches.map(batch => ({
      batchId: batch.batchId,
      escrowId: batch.escrowId.toString(),
      projectId: batch.projectId?.toString(),
      milestoneId: batch.milestoneId?.toString(),
      scheduledBy: batch.scheduledBy.toString(),
      currency: batch.currency,
      totalNet: batch.totalNet,
      status: batch.status,
      // All items included in the batch for full oversight
      items: batch.items.map(item => ({
        payoutItemId: item._id?.toString(),
        userId: item.userId.toString(),
        amount: item.amount,
        fees: item.fees,
        taxWithheld: item.taxWithheld,
        netAmount: item.netAmount,
        status: item.status,
        providerPayoutId: item.providerPayoutId,
        failureReason: item.failureReason,
        attempts: item.attempts,
        processedAt: item.processedAt?.toISOString(),
      })),
      createdAt: batch.createdAt?.toISOString() || new Date().toISOString(),
      updatedAt: batch.updatedAt?.toISOString(),
    }));

    return {
      meta: {
        page: pageNum,
        per_page: limit,
        total: totalResults,
        total_pages: Math.ceil(totalResults / limit),
      },
      data,
    };
  }

  /**
   * Handles a permanent payout failure (e.g., invalid bank account, KYC failure) reported by PSP webhook.
   * @param payoutItemId - Payout item ID
   * @param reason - Reason for failure
   */
  public async handlePayoutFailure(payoutItemId: string, reason: string): Promise<void> {
    const itemObjectId = new Types.ObjectId(payoutItemId);

    // 1. Find the parent batch and item
    const batch = await PayoutBatchModel.findOne({ 'items._id': itemObjectId });
    if (!batch) {
      return; // Safety check
    }

    const itemIndex = batch.items.findIndex(i => i._id?.equals(itemObjectId));
    const item = batch.items[itemIndex];

    if (!item || item.status === 'paid' || item.status === 'cancelled') {
      return; // State check
    }

    // 2. Determine Next Action (Retry or Escalate)
    const nextAttempt = item.attempts + 1;

    if (isRetryAllowed(nextAttempt)) {
      // A. RETRY LOGIC (Self-correction for transient failure)
      const delay = getExponentialBackoffDelay(nextAttempt);

      // Update item status/attempts directly
      const itemToUpdate = batch.items[itemIndex];
      if (!itemToUpdate) return; // Safety check
      itemToUpdate.status = 'scheduled';
      itemToUpdate.attempts = nextAttempt;
      itemToUpdate.failureReason = reason;

      // Enqueue job with calculated delay
      jobQueue.enqueuePayoutJob(batch.batchId, delay);
      console.warn(`[Payout Retry] Item ${payoutItemId} failed (Attempt ${nextAttempt}). Re-queued with ${delay}ms delay.`);
    } else {
      // B. ESCALATION LOGIC (Permanent Failure)
      const itemToUpdate = batch.items[itemIndex];
      if (!itemToUpdate) return; // Safety check
      itemToUpdate.status = 'failed';
      itemToUpdate.attempts = nextAttempt; // Increment attempts to MAX_ATTEMPTS
      itemToUpdate.failureReason = `Permanent failure after ${nextAttempt} attempts: ${reason}`;

      // Trigger Admin Escalation Job (Task 60)
      jobQueue.enqueueEscalationJob(payoutItemId, `MAX_ATTEMPTS reached. Reason: ${reason}`);
      console.warn(`[Payout Escalated] Item ${payoutItemId} escalated to admin DLQ.`);
    }

    // 3. Save the batch document and update overall batch status (if completed/partial)
    await batch.save();
    // PRODUCTION: Logic to update batch.status to 'partial' or 'completed' would go here
  }

  /**
   * Admin/System-driven manual re-execution of a failed payout item.
   * @param payoutItemId - Payout item ID
   * @param requesterId - User ID of requester
   * @returns Updated payout item
   * @throws {Error} - 'PayoutNotFound', 'PayoutAlreadyActive'
   */
  public async retryPayoutItem(payoutItemId: string, requesterId: string): Promise<IPayoutItem> {
    const itemObjectId = new Types.ObjectId(payoutItemId);

    const batch = await PayoutBatchModel.findOne({ 'items._id': itemObjectId });
    if (!batch) {
      throw new Error('PayoutNotFound');
    }

    const itemIndex = batch.items.findIndex(i => i._id?.equals(itemObjectId));
    const item = batch.items[itemIndex];

    if (!item) {
      throw new Error('PayoutNotFound');
    }
    if (item.status === 'paid' || item.status === 'processing') {
      throw new Error('PayoutAlreadyActive');
    }

    // 1. Reset/Increment State
    const nextAttempt = item.attempts + 1;
    const itemToUpdate = batch.items[itemIndex];
    if (!itemToUpdate) {
      throw new Error('PayoutNotFound');
    }
    itemToUpdate.status = 'processing'; // Ready for immediate processing
    itemToUpdate.attempts = nextAttempt;
    // Clear reason/failure for new attempt
    itemToUpdate.failureReason = undefined;

    await batch.save();

    // 2. Enqueue for IMMEDIATE execution (0 delay)
    jobQueue.enqueuePayoutJob(batch.batchId, 0);

    // PRODUCTION: AuditLog 'payout.retry.initiated'
    console.warn(`[Audit] Payout ${payoutItemId} manually retried by ${requesterId} (Attempt ${nextAttempt}).`);

    return itemToUpdate;
  }
}

