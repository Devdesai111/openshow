// src/jobs/handlers/thumbnailHandler.ts
import { AssetService } from '../../services/asset.service';
import { IJob } from '../../models/job.model';
import { Types } from 'mongoose';

const assetService = new AssetService();

// Mock Library for Image Processing
const mockImageProcessor = {
    generateThumbnail: (assetId: string, _size: number) => {
        // Simulates complex image processing and uploading the new asset
        console.log(`Processing thumbnail for ${assetId}...`);
        
        // Simulates a random failure 10% of the time for retry testing
        if (Math.random() < 0.1) {
            throw new Error('TransientImageProcessorError');
        }
        
        // Mock ID of the newly uploaded, derived asset (generate valid ObjectId)
        return new Types.ObjectId().toString();
    }
};

/**
 * Worker Logic Handler for the 'thumbnail.create' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handleThumbnailJob(job: IJob): Promise<{ newAssetId: string }> {
    const { assetId, versionNumber } = job.payload;
    
    if (!assetId || !versionNumber) {
        throw new Error('JobDataMissing: Missing assetId or versionNumber.');
    }
    
    // 1. Simulate Processing and Uploading Derived Asset
    const newAssetId = mockImageProcessor.generateThumbnail(assetId, 320);

    // 2. Report Back to Asset Service (Update the Source Asset)
    await assetService.markAssetProcessed(assetId, newAssetId);

    // 3. Return the result payload
    return { newAssetId };
}

