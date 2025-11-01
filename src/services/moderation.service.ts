// src/services/moderation.service.ts
import { ModerationRecordModel, IModerationRecord, IModerationAction } from '../models/moderationRecord.model';
import { AuditService } from './audit.service';
import { Types } from 'mongoose';

const auditService = new AuditService();

interface IReportDTO {
  resourceType: IModerationRecord['resourceType'];
  resourceId: string;
  reason: string;
  evidenceAssetIds?: string[];
  severity?: IModerationRecord['severity'];
}

export class ModerationService {
  /** Allows users (or public) to report content. */
  public async reportContent(reporterId: string | null, data: IReportDTO): Promise<IModerationRecord> {
    const newRecord = new ModerationRecordModel({
      resourceType: data.resourceType,
      resourceId: new Types.ObjectId(data.resourceId),
      reporterId: reporterId ? new Types.ObjectId(reporterId) : undefined,
      severity: data.severity || 'medium',
      status: 'open',
      evidenceAssetIds: data.evidenceAssetIds?.map(id => new Types.ObjectId(id)),
      // Initial action note: The reason for the report
      actions: [
        {
          action: 'report_filed',
          by: reporterId ? new Types.ObjectId(reporterId) : new Types.ObjectId('0000000000000000000000000000000000000000000000000000000000000000'), // Placeholder ID for system/anon
          notes: data.reason,
          createdAt: new Date(),
        },
      ],
    });

    const savedRecord = await newRecord.save();

    // 1. Audit Log (CRITICAL)
    await auditService.logAuditEntry({
      resourceType: 'moderation',
      resourceId: savedRecord._id!.toString(),
      action: 'content.reported',
      actorId: reporterId || undefined,
      actorRole: reporterId ? 'user' : 'anonymous',
      details: {
        reason: data.reason,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        modId: savedRecord.modId,
      },
    });

    // PRODUCTION: Emit 'moderation.reported' event (Task 11 subscribes for Admin Alert)

    return savedRecord.toObject() as IModerationRecord;
  }

  /** Admin function to retrieve the moderation queue. */
  public async getModerationQueue(filters: any): Promise<any> {
    const { status, severity, page = 1, per_page = 20 } = filters;
    const limit = parseInt(per_page.toString()) || 20;
    const skip = (parseInt(page.toString()) - 1) * limit || 0;

    const query: any = {};
    if (status) query.status = status;
    if (severity) query.severity = severity;

    // Execution
    const [totalResults, records] = await Promise.all([
      ModerationRecordModel.countDocuments(query),
      ModerationRecordModel.find(query)
        .sort({ createdAt: 1 }) // Oldest reports first
        .skip(skip)
        .limit(limit)
        .lean() as Promise<IModerationRecord[]>,
    ]);

    return {
      meta: {
        page: parseInt(page.toString()) || 1,
        per_page: limit,
        total: totalResults,
        total_pages: Math.ceil(totalResults / limit),
      },
      data: records.map(r => ({
        modId: r.modId,
        resourceType: r.resourceType,
        resourceId: r.resourceId.toString(),
        reporterId: r.reporterId?.toString(),
        status: r.status,
        severity: r.severity,
        assignedTo: r.assignedTo?.toString(),
        actionsCount: r.actions.length,
        createdAt: r.createdAt!.toISOString(),
        updatedAt: r.updatedAt!.toISOString(),
      })),
    };
  }

  /** Admin function to take action on a reported record. */
  public async takeAction(
    modId: string,
    adminId: string,
    action: IModerationAction['action'],
    notes: string
  ): Promise<IModerationRecord> {
    const record = await ModerationRecordModel.findOne({ modId });
    if (!record) {
      throw new Error('RecordNotFound');
    }

    if (record.status === 'closed' || record.status === 'actioned') {
      throw new Error('RecordAlreadyProcessed');
    }

    const newAction: IModerationAction = {
      action,
      by: new Types.ObjectId(adminId),
      notes,
      createdAt: new Date(),
    };

    // 1. Update Record
    record.actions.push(newAction);
    record.status = 'actioned'; // Simplest status transition
    record.assignedTo = new Types.ObjectId(adminId);
    const updatedRecord = await record.save();

    // 2. Downstream System Action (Mocked)
    if (action === 'suspend_user') {
      // PRODUCTION: Call AuthService.suspendUser (Task 6)
      console.log(`[System Call Mock] Suspending user ${record.resourceId.toString()}...`);
    }
    if (action === 'takedown') {
      // PRODUCTION: Call AssetService.deleteAsset or ProjectService.archiveProject
      console.log(`[System Call Mock] Takedown initiated for ${record.resourceType} ${record.resourceId.toString()}...`);
    }

    // 3. Audit Log (CRITICAL)
    await auditService.logAuditEntry({
      resourceType: 'moderation',
      resourceId: updatedRecord._id!.toString(),
      action: `moderation.action.${action}`,
      actorId: adminId,
      actorRole: 'admin',
      details: {
        resourceType: record.resourceType,
        resourceId: record.resourceId.toString(),
        modId: record.modId,
        notes,
      },
    });

    // PRODUCTION: Emit 'moderation.actioned' event

    return updatedRecord.toObject() as IModerationRecord;
  }
}

