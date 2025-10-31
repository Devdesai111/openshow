import { MessageModel, IMessage } from '../models/message.model';
import { ProjectModel, IProject } from '../models/project.model';
import { Types } from 'mongoose';
import { IAuthUser } from '../middleware/auth.middleware';
import { ActivityModel, IActivity } from '../models/activity.model';

interface ISendMessageDTO {
  body: string;
  attachments?: string[];
  replyToMessageId?: string;
  mentionedUserIds?: string[];
}

interface IActivityLogDTO {
  type: string;
  summary: string;
  actorId?: string;
  payload?: any;
}

export class CollaborationService {
  /**
   * Checks if the requester is a member of the project.
   * @throws {Error} - 'PermissionDenied', 'ProjectNotFound'
   */
  private async checkMembership(
    projectId: string,
    requesterId: string,
    requesterRole: IAuthUser['role']
  ): Promise<IProject> {
    const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
    if (!project) {
      throw new Error('ProjectNotFound');
    }

    const isMember = project.teamMemberIds.some(id => id.toString() === requesterId);
    const isAdmin = requesterRole === 'admin';

    if (!isMember && !isAdmin) {
      throw new Error('PermissionDenied');
    }
    return project;
  }

  /**
   * Sends and persists a new message.
   */
  public async sendMessage(
    projectId: string,
    senderId: string,
    senderRole: IAuthUser['role'],
    data: ISendMessageDTO
  ): Promise<IMessage> {
    await this.checkMembership(projectId, senderId, senderRole);

    const newMessage = new MessageModel({
      projectId: new Types.ObjectId(projectId),
      senderId: new Types.ObjectId(senderId),
      body: data.body,
      attachments: data.attachments?.map(id => new Types.ObjectId(id)),
      replyToMessageId: data.replyToMessageId ? new Types.ObjectId(data.replyToMessageId) : undefined,
      mentionedUserIds: data.mentionedUserIds?.map(id => new Types.ObjectId(id)),
    });

    const savedMessage = await newMessage.save();
    console.warn(`[Event] Message ${savedMessage.messageId} sent in project ${projectId}.`);
    return savedMessage.toObject() as IMessage;
  }

  /**
   * Retrieves paginated list of messages (cursor-based).
   */
  public async getMessages(
    projectId: string,
    requesterId: string,
    requesterRole: IAuthUser['role'],
    limit: number,
    before?: string
  ): Promise<{
    data: any[];
    meta: { limit: number; returned: number; before?: string };
  }> {
    await this.checkMembership(projectId, requesterId, requesterRole);

    const filters: Record<string, any> = {
      projectId: new Types.ObjectId(projectId),
      deleted: false,
    };

    if (before) {
      const beforeMessage = await MessageModel.findOne({ messageId: before }).select('createdAt').lean();
      if (beforeMessage) {
        filters.createdAt = { $lt: beforeMessage.createdAt };
      }
    }

    const messages = await MessageModel.find(filters)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('-__v')
      .lean();

    const data = (messages as IMessage[]).map(msg => ({
      messageId: msg.messageId,
      senderId: msg.senderId.toString(),
      body: msg.body,
      attachments: msg.attachments?.map(id => id.toString()),
      replyToMessageId: msg.replyToMessageId?.toString(),
      mentionedUserIds: msg.mentionedUserIds?.map(id => id.toString()),
      reactions: msg.reactions,
      editedAt: msg.editedAt?.toISOString(),
      createdAt: msg.createdAt!.toISOString(),
    }));

    return { data, meta: { limit, returned: data.length, ...(before && { before }) } };
  }

  /**
   * Updates a message body/attachments.
   */
  public async updateMessage(
    projectId: string,
    messageId: string,
    requesterId: string,
    requesterRole: IAuthUser['role'],
    body: string
  ): Promise<IMessage> {
    const message = await MessageModel.findOne({
      messageId,
      projectId: new Types.ObjectId(projectId),
    });

    if (!message) {
      throw new Error('MessageNotFound');
    }

    if (message.senderId.toString() !== requesterId && requesterRole !== 'admin') {
      throw new Error('PermissionDenied');
    }

    message.body = body;
    message.editedAt = new Date();
    await message.save();

    console.warn(`[Event] Message ${messageId} updated.`);
    return message.toObject() as IMessage;
  }

  /**
   * Soft-deletes a message.
   */
  public async deleteMessage(
    projectId: string,
    messageId: string,
    requesterId: string,
    requesterRole: IAuthUser['role']
  ): Promise<void> {
    const message = await MessageModel.findOne({
      messageId,
      projectId: new Types.ObjectId(projectId),
    });

    if (!message) {
      throw new Error('MessageNotFound');
    }

    if (message.senderId.toString() !== requesterId && requesterRole !== 'admin') {
      throw new Error('PermissionDenied');
    }

    const result = await MessageModel.updateOne(
      { _id: message._id },
      { $set: { deleted: true, body: '[Message Deleted]' } }
    );

    if (result.modifiedCount === 0) {
      throw new Error('DeleteFailed');
    }

    console.warn(`[Event] Message ${messageId} soft-deleted.`);
  }

  /** Logs an immutable activity event for a project. (Internal/Service Use) */
  public async logActivity(
    projectId: string,
    actorId: string | null,
    data: IActivityLogDTO
  ): Promise<IActivity> {
    const newActivity = new ActivityModel({
      projectId: new Types.ObjectId(projectId),
      actorId: actorId ? new Types.ObjectId(actorId) : undefined,
      type: data.type,
      summary: data.summary,
      payload: data.payload,
    });

    const savedActivity = await newActivity.save();
    console.warn(`[Event] Activity ${savedActivity.activityId} logged: ${savedActivity.type}.`);
    return savedActivity.toObject() as IActivity;
  }

  /** Retrieves the chronological activity feed for a project. */
  public async getActivityFeed(
    projectId: string,
    requesterId: string,
    requesterRole: IAuthUser['role'],
    limit: number,
    after?: string
  ): Promise<{ data: any[]; meta: { limit: number; returned: number; after?: string } }> {
    await this.checkMembership(projectId, requesterId, requesterRole);

    const filters: Record<string, any> = { projectId: new Types.ObjectId(projectId) };

    if (after) {
      const afterActivity = await ActivityModel.findOne({ activityId: after }).select('createdAt');
      if (afterActivity) {
        filters.createdAt = { $lt: afterActivity.createdAt };
      }
    }

    const activities = await ActivityModel.find(filters)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('-__v')
      .lean();

    const data = (activities as IActivity[]).map(act => ({
      activityId: act.activityId,
      type: act.type,
      summary: act.summary,
      actorId: act.actorId?.toString(),
      payload: act.payload,
      createdAt: act.createdAt!.toISOString(),
    }));

    return { data, meta: { limit, returned: data.length, ...(after && { after }) } };
  }
}
