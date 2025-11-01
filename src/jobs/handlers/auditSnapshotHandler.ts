// src/jobs/handlers/auditSnapshotHandler.ts
import { IJob } from '../../models/job.model';
import { AuditService } from '../../services/audit.service';
import { AuditLogModel } from '../../models/auditLog.model';
import crypto from 'crypto';

const auditService = new AuditService();

// Mock External KMS/Vault for Signing
class KMS {
  public signHash(hash: string): string {
    // PRODUCTION: Use a secure private key (PKI)
    return `SIGNED_MANIFEST:${hash}_${crypto.randomBytes(8).toString('hex')}`;
  }
}
const kms = new KMS();

/**
 * Worker Logic Handler for the 'audit.snapshot' job type.
 * @param job - The IJob document being processed.
 * @returns The job result payload on success.
 */
export async function handleAuditSnapshotJob(job: IJob): Promise<{ snapshotAssetId: string; recordCount: number }> {
  const { from, to } = job.payload;

  if (!from || !to) {
    throw new Error('JobDataMissing: Missing from or to.');
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);

  // 1. Query Logs (Select non-immutable logs in the period)
  const logs = await AuditLogModel.find({
    timestamp: { $gte: fromDate, $lte: toDate },
    immutable: false,
  })
    .sort({ timestamp: 1 })
    .lean();

  const logIds = logs.map(log => log._id!);
  const recordCount = logs.length;

  if (recordCount === 0) {
    return { snapshotAssetId: 'NONE', recordCount: 0 }; // Successful execution, no data
  }

  // 2. Generate Manifest Hash (Hash of all log hashes)
  const combinedHashes = logs.map(log => log.hash).join('');
  const manifestHash = crypto.createHash('sha256').update(combinedHashes).digest('hex');

  // 3. Sign the Manifest Hash (Compliance Proof)
  const signedManifest = kms.signHash(manifestHash);

  // 4. Simulate Asset Registration (Upload Manifest/NDJSON file)
  const snapshotAssetId = `snapshot_asset_${crypto.randomBytes(6).toString('hex')}`;

  // PRODUCTION: AssetService.internalRegisterAsset(ManifestFilePath, SystemUploaderId, signedManifest)
  console.log(`Snapshot manifest signed. Uploading asset ${snapshotAssetId}.`);

  // 5. Update Source Logs (CRITICAL FINAL STEP)
  await auditService.updateLogImmutability(logIds, snapshotAssetId, signedManifest);

  // 6. Return the result payload
  return { snapshotAssetId, recordCount };
}

