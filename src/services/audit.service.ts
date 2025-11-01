// src/services/audit.service.ts
import { AuditLogModel, IAuditLog } from '../models/auditLog.model';
import { computeLogHash } from '../utils/hashChain.utility';
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
}

