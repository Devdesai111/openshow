// src/jobs/handlers/payoutHandler.ts
import { IJob } from '../../models/job.model';
import { RevenueService } from '../../services/revenue.service'; 

const revenueService = new RevenueService();

/**
 * Worker Logic Handler for the 'payout.execute' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handlePayoutJob(job: IJob): Promise<{ totalSubmitted: number }> {
    const { batchId } = job.payload;
    
    if (!batchId) {
        throw new Error('JobDataMissing: Missing batchId.');
    }
    
    // NOTE: Job Service handles atomicity/concurrency. We just execute the business logic.

    // 1. Execute the Batch
    const result = await revenueService.executePayoutBatch(batchId);
    
    // 2. Determine Success/Failure
    // If all items failed (KYC issues or PSP errors), throw to signal retry
    if (result.totalItems > 0 && result.totalSubmitted === 0) {
        // If no items were submitted (all pending KYC or failed), we throw an error to signal the Job Service to retry later
        throw new Error('PartialSubmissionFailure');
    }

    // If totalSubmitted > 0, it means at least some transfers were submitted to the PSP (partial success).
    // The job completes successfully even if some items had KYC issues or failed (they'll be retried in a future job run).
    // The final status update (paid/failed) is handled by the webhook (Task 35).
    return { totalSubmitted: result.totalSubmitted };
}

