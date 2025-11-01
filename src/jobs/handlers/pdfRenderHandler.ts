// src/jobs/handlers/pdfRenderHandler.ts
import { IJob } from '../../models/job.model';
import { AssetModel, IAssetVersion } from '../../models/asset.model';
import { AgreementService } from '../../services/agreement.service';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

const agreementService = new AgreementService();

// Mock Library for PDF Generation (Headless Browser/PDF Renderer)
const mockPdfRenderer = {
    renderHtmlToPdf: (_htmlContent: string) => {
        // Simulates rendering a complex legal document
        console.log(`Rendering PDF for agreement...`);
        return Buffer.from(`%PDF-Mock-Content-${crypto.randomBytes(4).toString('hex')}`);
    }
};

/**
 * Worker Logic Handler for the 'pdf.generate' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handlePdfRenderJob(job: IJob): Promise<{ pdfAssetId: string }> {
    const { agreementId, payloadJson } = job.payload;
    
    if (!agreementId || !payloadJson) {
        throw new Error('JobDataMissing: Missing agreementId or payloadJson.');
    }
    
    if (!job.createdBy) {
        throw new Error('JobDataMissing: Missing createdBy (uploaderId).');
    }
    
    const uploaderId = job.createdBy.toString(); // Job creator is the 'uploader' for the derived asset

    // 1. Simulate Document Rendering (Convert Canonical JSON to PDF Buffer)
    // Mock HTML template population (reusing agreement payload structure)
    const htmlContent = `<html><body><h1>${(payloadJson as any).title || 'Agreement'}</h1><p>Terms: ${(payloadJson as any).terms || ''}</p></body></html>`;
    const pdfBuffer = mockPdfRenderer.renderHtmlToPdf(htmlContent);
    
    // 2. Simulate Upload/Registration (Internal Server Upload)
    // NOTE: This simulates the server performing the upload and registration in one step
    
    const mimeType = 'application/pdf';
    const filename = `Agreement-${agreementId}-${job.attempt}.pdf`;
    const storageKey = `agreements/${agreementId}/${filename}`;
    const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    
    // Create asset directly (internal registration, bypasses upload session)
    const pdfVersion: IAssetVersion = {
        versionNumber: 1,
        storageKey,
        size: pdfBuffer.length,
        sha256,
        uploaderId: new Types.ObjectId(uploaderId),
        createdAt: new Date(),
    };
    
    const pdfAsset = new AssetModel({
        uploaderId: new Types.ObjectId(uploaderId),
        filename,
        mimeType,
        versions: [pdfVersion],
        processed: true, // PDF is final, no further processing needed
    });
    
    const savedPdfAsset = await pdfAsset.save();
    const pdfAssetId = savedPdfAsset._id!.toString();
    
    // PRODUCTION: AssetService.internalRegisterAsset(storageKey, pdfBuffer, uploaderId)
    console.log(`PDF successfully uploaded to mock storage key ${storageKey}.`);
    
    // 3. Update the Parent Agreement Record (CRITICAL STEP)
    await agreementService.updatePdfAssetId(agreementId, pdfAssetId);

    // 4. Return the result payload
    return { pdfAssetId };
}

