import { MessageModel, IMessage } from '../models/message.model';
import { ProjectModel, IProject } from '../models/project.model';
import { Types } from 'mongoose';
import { IAuthUser } from '../middleware/auth.middleware';

interface ISendMessageDTO {
  body: string;
  attachments?: string[];
  replyToMessageId?: string;
  mentionedUserIds?: string[];
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
   * @param projectId - Project ID
   * @param senderId - Sender user ID
   * @param senderRole - Sender role
   * @param data - Message data
   * @returns Created message
   * @throws {Error} - 'PermissionDenied', 'ProjectNotFound'
   */
  public async sendMessage(
    projectId: string,
    senderId: string,
    senderRole: IAuthUser['role'],
    data: ISendMessageDTO
  ): Promise<IMessage> {
    // Security check
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

    // PRODUCTION: Emit 'chat.message.created' event (Task 11, Activity Feed subscribe)
    console.warn(`[Event] Message ${savedMessage.messageId} sent in project ${projectId}.`);

    return savedMessage.toObject() as IMessage;
  }

  /**
   * Retrieves paginated list of messages (cursor-based for infinite scroll).
   * @param projectId - Project ID
   * @param requesterId - Requester user ID
   * @param requesterRole - Requester role
   * @param limit - Maximum number of messages to return
   * @param before - Optional cursor (messageId) for pagination
   * @returns Paginated list of messages
   * @throws {Error} - 'PermissionDenied'
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
    // Security check
    await this.checkMembership(projectId, requesterId, requesterRole);

    const filters: Record<string, any> = {
      projectId: new Types.ObjectId(projectId),
      deleted: false,
    };

    // Cursor-based pagination: Find messages *older* than the 'before' cursor
    if (before) {
      // Assume 'before' is a messageId, look up its creation date
      const beforeMessage = await MessageModel.findOne({ messageId: before }).select('createdAt').lean();
      if (beforeMessage) {
        filters.createdAt = { $lt: beforeMessage.createdAt };
      }
    }

    const messages = await MessageModel.find(filters)
      .sort({ createdAt: -1 }) // Newest first (descending)
      .limit(limit)
      .select('-__v')
      .lean();

    // Map to DTO (convert IDs to strings)
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
   * @param projectId - Project ID
   * @param messageId - Message ID (messageId, not _id)
   * @param requesterId - Requester user ID
   * @param requesterRole - Requester role
   * @param body - New message body
   * @returns Updated message
   * @throws {Error} - 'MessageNotFound', 'PermissionDenied'
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

    // Security: Check if sender or Admin
    if (message.senderId.toString() !== requesterId && requesterRole !== 'admin') {
      throw new Error('PermissionDenied');
    }

    message.body = body;
    message.editedAt = new Date();
    await message.save();

    // PRODUCTION: Emit 'chat.message.updated' event
    console.warn(`[Event] Message ${messageId} updated.`);

    return message.toObject() as IMessage;
  }

  /**
   * Soft-deletes a message.
   * @param projectId - Project ID
   * @param messageId - Message ID (messageId, not _id)
   * @param requesterId - Requester user ID
   * @param requesterRole - Requester role
   * @throws {Error} - 'MessageNotFound', 'PermissionDenied', 'DeleteFailed'
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

    // Security: Check if sender or Admin
    if (message.senderId.toString() !== requesterId && requesterRole !== 'admin') {
      throw new Error('PermissionDenied');
    }

    // Soft delete operation
    const result = await MessageModel.updateOne(
      { _id: message._id },
      { $set: { deleted: true, body: '[Message Deleted]' } } // Replace body for immediate view update
    );

    if (result.modifiedCount === 0) {
      throw new Error('DeleteFailed');
    }

    // PRODUCTION: Emit 'chat.message.deleted' event
    console.warn(`[Event] Message ${messageId} soft-deleted.`);
  }
}
