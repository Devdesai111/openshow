// src/jobs/handlers/auditExportHandler.ts
import { IJob } from '../../models/job.model';
import { AuditLogModel } from '../../models/auditLog.model';
import { AssetModel, IAssetVersion } from '../../models/asset.model';
import { NotificationModel } from '../../models/notification.model';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

/**
 * Worker Logic Handler for the 'export.audit' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handleAuditExportJob(job: IJob): Promise<{ exportAssetId: string; recordCount: number }> {
  const { exportFilters, format, requesterId } = job.payload;

  if (!exportFilters || !format || !requesterId) {
    throw new Error('JobDataMissing: Missing exportFilters, format, or requesterId.');
  }

  // 1. QUERY DATA (Simulated Streaming Read)
  // NOTE: In production, this would use a cursor/stream to avoid OOM errors.
  const query: any = {};

  // Apply filters similar to AuditService.queryAuditLogs
  if (exportFilters.from || exportFilters.to) {
    query.timestamp = {};
    if (exportFilters.from) {
      const fromDate = typeof exportFilters.from === 'string' ? new Date(exportFilters.from) : exportFilters.from;
      query.timestamp.$gte = fromDate;
    }
    if (exportFilters.to) {
      const toDate = typeof exportFilters.to === 'string' ? new Date(exportFilters.to) : exportFilters.to;
      query.timestamp.$lte = toDate;
    }
  }

  if (exportFilters.action) query.action = exportFilters.action;
  if (exportFilters.resourceType) query.resourceType = exportFilters.resourceType;
  if (exportFilters.resourceId) query.resourceId = new Types.ObjectId(exportFilters.resourceId);

  const records = await AuditLogModel.find(query).lean().sort({ timestamp: 1 });
  const recordCount = records.length;

  if (recordCount === 0) {
    throw new Error('NoRecordsFound');
  }

  // 2. FORMAT DATA (Mock: Create a simple file content)
  let fileContent: string;
  if (format === 'csv') {
    // CSV format
    const headers = 'timestamp,action,resourceType,resourceId,actorId,actorRole,hash,previousHash,details\n';
    const rows = records.map(r => {
      const detailsStr = JSON.stringify(r.details || {}).replace(/"/g, '""'); // Escape quotes
      return `${r.timestamp.toISOString()},"${r.action}","${r.resourceType}","${r.resourceId?.toString() || ''}","${r.actorId?.toString() || ''}","${r.actorRole || ''}","${r.hash}","${r.previousHash}","${detailsStr}"`;
    });
    fileContent = headers + rows.join('\n');
  } else if (format === 'ndjson') {
    // NDJSON format (newline-delimited JSON)
    fileContent = records.map(r => JSON.stringify({
      timestamp: r.timestamp.toISOString(),
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId?.toString(),
      actorId: r.actorId?.toString(),
      actorRole: r.actorRole,
      hash: r.hash,
      previousHash: r.previousHash,
      details: r.details,
    })).join('\n');
  } else {
    // PDF format (simplified - just text representation)
    fileContent = records.map(r => `${r.timestamp.toISOString()} | ${r.action} | ${r.resourceType} | Hash: ${r.hash.substring(0, 10)}...`).join('\n');
  }

  const mimeType = format === 'csv' ? 'text/csv' : format === 'ndjson' ? 'application/x-ndjson' : 'application/pdf';
  const filename = `audit_export_${job.jobId}.${format}`;
  const fileSize = Buffer.byteLength(fileContent, 'utf8');
  const fileBuffer = Buffer.from(fileContent, 'utf8');

  // 3. SIMULATE CLOUD UPLOAD AND REGISTRATION
  // In a real app, this internal call would upload the Buffer and get a final storage key.
  const storageKey = `exports/audit/${job.jobId}/${filename}`;
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Create asset directly (simulating server-side upload registration)
  const uploaderId = new Types.ObjectId(requesterId);
  const version: IAssetVersion = {
    versionNumber: 1,
    storageKey,
    size: fileSize,
    sha256,
    uploaderId,
    createdAt: new Date(),
  };

  const exportAsset = new AssetModel({
    uploaderId,
    filename,
    mimeType,
    versions: [version],
    processed: true, // Export files are ready immediately
  });

  const savedAsset = await exportAsset.save();
  const exportAssetId = savedAsset._id!.toString();

  // PRODUCTION: AssetService.internalRegisterAsset(storageKey, requesterId, fileSize, sha256)
  console.log(`[Event] Exported ${recordCount} records. Registered Asset ID: ${exportAssetId}`);

  // 4. NOTIFY REQUESTER (Mock Call to Notification Service)
  // For now, we'll just log the notification since we don't have the template
  // In production, this would call:
  // await notificationService.sendTemplateNotification({
  //   templateId: 'export.ready',
  //   recipients: [{ userId: requesterId, email: requesterEmail || 'admin@example.com' }],
  //   variables: { fileName: filename, fileSize: fileSize.toString(), downloadLink: `(External Link for ${exportAssetId})` },
  // });

  // Simplified notification (without template)
  try {
    // Create a simple in-app notification for the admin
    const notificationId = `notif_export_${crypto.randomBytes(8).toString('hex')}`;
    await NotificationModel.create({
      notificationId,
      type: 'export.ready',
      templateId: 'export.ready', // Placeholder
      recipients: [{ userId: new Types.ObjectId(requesterId) }],
      content: {
        in_app: {
          title: 'Audit Export Ready',
          body: `Your audit log export (${filename}) is ready for download.`,
        },
      },
      channels: ['in_app'],
      status: 'queued',
    });

    console.log(`[Event] Notification sent to requester ${requesterId} for export ${exportAssetId}`);
  } catch (error: any) {
    // Non-critical: Log but don't fail the job
    console.warn(`[Warning] Failed to send notification for export ${exportAssetId}: ${error.message}`);
  }

  // 5. Return the result payload
  return { exportAssetId, recordCount };
}

