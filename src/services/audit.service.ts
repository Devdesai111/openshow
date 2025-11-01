// src/services/audit.service.ts
import { AuditLogModel, IAuditLog } from '../models/auditLog.model';
import { computeLogHash } from '../utils/hashChain.utility';
import { JobService } from './job.service';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

interface ILogEntryDTO {
  resourceType: string;
  resourceId?: string;
  action: string;
  actorId?: string;
  actorRole?: string;
  ip?: string;
  details: any;
}

interface IAuditQueryFilters {
  from?: Date | string;
  to?: Date | string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  page?: number | string;
  per_page?: number | string;
}

const jobService = new JobService();

export class AuditService {
  /** Retrieves the last successfully committed log for chain linking. */
  private async getLastLog(): Promise<IAuditLog | null> {
    return AuditLogModel.findOne({})
      .sort({ timestamp: -1 })
      .select('hash')
      .lean() as Promise<IAuditLog | null>;
  }

  /** Logs an immutable, cryptographically chained audit entry. */
  public async logAuditEntry(data: ILogEntryDTO): Promise<IAuditLog> {
    const lastLog = await this.getLastLog();

    // 1. Determine Previous Hash (Genesis Block is '000...')
    const previousHash = lastLog
      ? lastLog.hash
      : '0000000000000000000000000000000000000000000000000000000000000000'; // 64 zeroes

    // 2. Prepare Log Data
    const timestamp = new Date();
    const logData: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'> = {
      auditId: `audit_${crypto.randomBytes(6).toString('hex')}`,
      resourceType: data.resourceType,
      resourceId: data.resourceId ? new Types.ObjectId(data.resourceId) : undefined,
      action: data.action,
      actorId: data.actorId ? new Types.ObjectId(data.actorId) : undefined,
      actorRole: data.actorRole,
      timestamp,
      ip: data.ip,
      details: data.details,
      previousHash,
    };

    // 3. Compute Hash
    const newHash = computeLogHash(logData, previousHash);

    // 4. Create and Save (Append-only)
    const newLog = new AuditLogModel({
      ...logData,
      hash: newHash,
    });

    const savedLog = await newLog.save();

    // PRODUCTION: Emit 'audit.created' event (Task 61 subscribes)
    console.log(`[Event] AuditLog ${savedLog.auditId} created with hash ${newHash.substring(0, 10)}...`);

    return savedLog.toObject() as IAuditLog;
  }

  /** Queries the immutable audit log ledger with filters. */
  public async queryAuditLogs(filters: IAuditQueryFilters): Promise<any> {
    const {
      from,
      to,
      action,
      resourceType,
      resourceId,
      page = 1,
      per_page = 20,
    } = filters;
    const limit = parseInt(per_page.toString()) || 20;
    const skip = (parseInt(page.toString()) - 1) * limit || 0;

    const query: any = {};

    // 1. Time Range Filtering (Indexed field)
    if (from || to) {
      query.timestamp = {};
      if (from) {
        const fromDate = typeof from === 'string' ? new Date(from) : from;
        query.timestamp.$gte = fromDate;
      }
      if (to) {
        const toDate = typeof to === 'string' ? new Date(to) : to;
        query.timestamp.$lte = toDate;
      }
    }

    // 2. Exact Filters (Indexed fields)
    if (action) query.action = action;
    if (resourceType) query.resourceType = resourceType;
    if (resourceId) query.resourceId = new Types.ObjectId(resourceId);

    // 3. Execution
    const [totalResults, logs] = await Promise.all([
      AuditLogModel.countDocuments(query),
      AuditLogModel.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .select('-__v') // Exclude internal version key
        .lean() as Promise<IAuditLog[]>,
    ]);

    // 4. Map to List DTO (Redacted/Simplified)
    const data = logs.map(log => ({
      auditId: log.auditId,
      resourceType: log.resourceType,
      resourceId: log.resourceId?.toString(),
      action: log.action,
      actorId: log.actorId?.toString(),
      actorRole: log.actorRole,
      timestamp: log.timestamp.toISOString(),
      ip: log.ip,
      // NOTE: Details are kept full here as this is an Admin endpoint
      details: log.details,
      hash: log.hash.substring(0, 10) + '...',
      previousHash: log.previousHash.substring(0, 10) + '...',
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

  /** Initiates an asynchronous job for exporting audit logs. */
  public async exportAuditLogs(
    exportFilters: IAuditQueryFilters,
    format: string,
    requesterId: string
  ): Promise<{ jobId: string }> {
    // 1. Payload and Job Type
    const jobPayload = {
      exportFilters,
      format,
      requesterId,
      requesterEmail: 'admin@example.com', // Mock email for notification
    };

    // 2. Enqueue Job (Task 52)
    const job = await jobService.enqueueJob({
      type: 'export.audit', // New job type registered in Task 62
      payload: jobPayload,
      priority: 20, // Lower priority
      createdBy: requesterId,
    });

    return { jobId: job.jobId };
  }

  /** Worker-called method to mark a batch of audit logs as immutable after external snapshot. */
  public async updateLogImmutability(logIds: Types.ObjectId[], snapshotAssetId: string, signedHash: string): Promise<void> {
    // 1. Mark Logs as Immutable
    const result = await AuditLogModel.updateMany(
      { _id: { $in: logIds }, immutable: false },
      { $set: { immutable: true } }
    );

    // 2. Audit Log (Record the manifest/snapshot creation itself)
    await this.logAuditEntry({
      resourceType: 'audit_snapshot',
      resourceId: '000000000000000000000002', // System resource ID
      action: 'snapshot.created',
      actorId: '000000000000000000000001', // System user
      actorRole: 'system',
      details: {
        snapshotAssetId,
        recordCount: result.modifiedCount,
        signedHash,
      },
    });

    console.log(`[Audit] ${result.modifiedCount} logs marked immutable. Snapshot: ${snapshotAssetId}.`);
  }
}

