// src/services/revenue.service.ts
import { ProjectModel, IProject } from '../models/project.model';
import { calculateRevenueSplit } from '../utils/revenueCalculator';
import { PayoutBatchModel, IPayoutBatch, IPayoutItem } from '../models/payout.model';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

// Mock Job Queue for payout execution (Task 58 dependency)
class MockJobQueue {
  public enqueuePayoutJob(batchId: string): string {
    console.warn(`[Job Enqueued] Payout execution for Batch ${batchId}.`);
    return `job_payout_${crypto.randomBytes(4).toString('hex')}`;
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
}

