import crypto from 'crypto';
import * as handlebars from 'handlebars';
import { Types } from 'mongoose';
import { INotification, NotificationModel } from '../models/notification.model';
import { INotificationTemplate, NotificationTemplateModel } from '../models/notificationTemplate.model';
import { UserInboxModel } from '../models/userNotification.model';
import { IEmailAdapter, IEmailSendDTO } from '../notificationAdapters/email.interface';
import { SendGridAdapter } from '../notificationAdapters/sendgrid.adapter';

const emailAdapter: IEmailAdapter = new SendGridAdapter(); // Assume SendGrid is the active provider

// DTO for incoming template-based send request
interface ITemplateSendRequest {
  templateId: string;
  recipients: { userId: string; email?: string }[];
  variables: Record<string, string>;
  channels?: INotification['channels']; // Override template default channels
  scheduledAt?: Date;
  projectId?: string;
}

export class NotificationService {
  /**
   * Renders template content using provided variables.
   * @param templateContent - The content part (e.g., template.contentTemplate.email).
   * @param variables - Key-value pair for templating.
   * @returns Rendered content object.
   * @throws {Error} - 'VariableMissing' for missing required variables.
   */
  private renderContent(templateContent: Record<string, unknown>, variables: Record<string, string>): Record<string, unknown> {
    const rendered: Record<string, unknown> = {};

    // Helper to check for missing variables globally
    const templateSource = JSON.stringify(templateContent);
    const missingVars = (templateSource.match(/{{(.*?)}}/g) || [])
      .map(v => v.replace(/[{}]/g, '').trim())
      .filter(v => !Object.prototype.hasOwnProperty.call(variables, v));

    if (missingVars.length > 0) {
      throw new Error(`VariableMissing: ${missingVars.join(', ')}`);
    }

    // Iterate through content parts (subject, body, html, etc.) and render
    for (const key in templateContent) {
      if (typeof templateContent[key] === 'string') {
        const template = handlebars.compile(templateContent[key] as string);
        rendered[key] = template(variables);
      } else {
        rendered[key] = templateContent[key];
      }
    }

    return rendered;
  }

  /**
   * Receives a template, renders it, and queues the final notification record in the DB.
   * @param request - The template ID, recipients, and variables.
   * @returns The created notification object.
   * @throws {Error} - 'TemplateNotFound' | 'VariableMissing'.
   */
  public async sendTemplateNotification(request: ITemplateSendRequest): Promise<INotification> {
    const { templateId, recipients, variables, channels, scheduledAt, projectId } = request;

    // 1. Fetch Template
    const template = (await NotificationTemplateModel.findOne({ templateId, active: true }).lean()) as INotificationTemplate;
    if (!template) {
      throw new Error('TemplateNotFound');
    }

    // 2. Validate Required Variables
    template.requiredVariables.forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(variables, key)) {
        throw new Error(`VariableMissing: ${key}`);
      }
    });

    // 3. Render Content Snapshot
    const contentSnapshot: INotification['content'] = {};
    for (const channel of template.channels) {
      if (template.contentTemplate[channel]) {
        const rendered = this.renderContent(
          template.contentTemplate[channel] as Record<string, unknown>,
          variables
        );
        (contentSnapshot as any)[channel] = rendered;
      }
    }

    // 4. Create Final Notification Record
    const finalChannels = channels || template.channels;
    const newNotification = new NotificationModel({
      notificationId: `notif_${crypto.randomBytes(8).toString('hex')}`, // Unique ID
      type: template.templateId,
      templateId: template.templateId,
      projectId: projectId ? new Types.ObjectId(projectId) : undefined,
      recipients: recipients.map(r => ({ 
        userId: new Types.ObjectId(r.userId), 
        email: r.email 
      })),
      content: contentSnapshot,
      channels: finalChannels,
      status: 'queued', // Always 'queued' for dispatcher
      scheduledAt,
    });

    const savedNotification = await newNotification.save();

    // 5. Create UserInbox entries for each recipient (for in-app notifications)
    if (finalChannels.includes('in_app')) {
      const inboxEntries = recipients
        .filter(r => r.userId) // Only create inbox entries for users with userId
        .map(r => ({
          userId: new Types.ObjectId(r.userId),
          notificationId: savedNotification._id!,
          read: false,
          deleted: false,
        }));

      if (inboxEntries.length > 0) {
        await UserInboxModel.insertMany(inboxEntries);
      }
    }

    // 6. Trigger Dispatcher/Job (Simulated)
    // PRODUCTION: Emit 'notification.created' event (Task 47 subscribes to this)
    console.warn(`[Event] Notification ${savedNotification.notificationId} created and queued for dispatch.`);

    return savedNotification.toObject() as INotification;
  }

  // --- Admin Template Management ---

  /**
   * Creates a new notification template (Admin/System use).
   * @param data - Template data
   * @returns Created template
   * @throws {Error} - 'TemplateIDConflict'
   */
  public async createTemplate(data: {
    templateId: string;
    name: string;
    description?: string;
    channels: ('in_app' | 'email' | 'push' | 'webhook')[];
    contentTemplate: INotificationTemplate['contentTemplate'];
    requiredVariables: string[];
    defaultLocale?: string;
  }): Promise<INotificationTemplate> {
    const existing = await NotificationTemplateModel.findOne({ templateId: data.templateId });
    if (existing) {
      throw new Error('TemplateIDConflict');
    }

    // PRODUCTION: Full template object validation would occur here
    const newTemplate = new NotificationTemplateModel({
      ...data,
      version: 1,
      active: true,
      defaultLocale: data.defaultLocale || 'en',
    });

    const savedTemplate = await newTemplate.save();
    return savedTemplate.toObject() as INotificationTemplate;
  }

  /**
   * Updates an existing template, incrementing the version. (Soft deletion of old content)
   * @param templateId - Template ID
   * @param data - Update data
   * @returns Updated template
   * @throws {Error} - 'TemplateNotFound'
   */
  public async updateTemplate(
    templateId: string,
    data: Partial<{
      name: string;
      description: string;
      channels: ('in_app' | 'email' | 'push' | 'webhook')[];
      contentTemplate: INotificationTemplate['contentTemplate'];
      requiredVariables: string[];
      defaultLocale: string;
    }>
  ): Promise<INotificationTemplate> {
    const template = await NotificationTemplateModel.findOne({ templateId });
    if (!template) {
      throw new Error('TemplateNotFound');
    }

    // Increment version on update
    const newVersion = template.version + 1;

    const updatedTemplate = await NotificationTemplateModel.findOneAndUpdate(
      { templateId },
      {
        $set: { ...data, version: newVersion, updatedAt: new Date() },
      },
      { new: true }
    );

    if (!updatedTemplate) {
      throw new Error('TemplateNotFound');
    }

    return updatedTemplate.toObject() as INotificationTemplate;
  }

  /**
   * Deletes/Deactivates a template.
   * @param templateId - Template ID
   * @throws {Error} - 'TemplateNotFound'
   */
  public async deleteTemplate(templateId: string): Promise<void> {
    const result = await NotificationTemplateModel.updateOne(
      { templateId },
      { $set: { active: false, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) {
      throw new Error('TemplateNotFound');
    }
  }

  /**
   * Previews a rendered template with mock variables.
   * @param templateId - Template ID
   * @param variables - Variables for rendering
   * @returns Rendered content for each channel
   * @throws {Error} - 'TemplateNotFound' | 'VariableMissing: {key}'
   */
  public async previewTemplate(templateId: string, variables: Record<string, string>): Promise<Record<string, any>> {
    const template = (await NotificationTemplateModel.findOne({ templateId, active: true }).lean()) as
      | INotificationTemplate
      | null;
    if (!template) {
      throw new Error('TemplateNotFound');
    }

    const renderedContent: Record<string, any> = {};

    // 1. Check for Missing Variables
    template.requiredVariables.forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(variables, key)) {
        throw new Error(`VariableMissing: ${key}`);
      }
    });

    // 2. Render content for each channel (using the renderContent utility from Task 11 logic)
    for (const channel of template.channels) {
      const contentTemplate = template.contentTemplate[channel];
      if (contentTemplate) {
        // Reusing the render logic from Task 11 (Handlebars utility)
        const rendered = this.renderContent(contentTemplate as Record<string, unknown>, variables);
        renderedContent[channel] = rendered;
      }
    }

    return renderedContent;
  }

  // --- User Interaction Methods ---

  /**
   * Lists a user's notifications, joining with the main content model.
   * @param requesterId - User ID of requester
   * @param queryParams - Query parameters (status, page, per_page)
   * @returns Paginated list of user notifications
   */
  public async listUserNotifications(
    requesterId: string,
    queryParams: {
      status?: 'read' | 'unread' | 'all';
      page?: number | string;
      per_page?: number | string;
    }
  ): Promise<{
    meta: {
      page: number;
      per_page: number;
      total: number;
      total_pages: number;
    };
    data: Array<{
      id: string;
      notificationId: string;
      read: boolean;
      type: string;
      title?: string;
      body?: string;
      projectId?: string;
      createdAt: string;
    }>;
  }> {
    const { status, page = 1, per_page = 20 } = queryParams;
    const limit = typeof per_page === 'number' ? per_page : parseInt(per_page, 10);
    const pageNum = typeof page === 'number' ? page : parseInt(page, 10);
    const skip = (pageNum - 1) * limit;
    const userId = new Types.ObjectId(requesterId);

    const inboxFilters: any = { userId, deleted: false };
    if (status === 'read') {
      inboxFilters.read = true;
    } else if (status === 'unread') {
      inboxFilters.read = false;
    }
    // If status is 'all' or undefined, no read filter is applied

    // 1. Find the Inbox records (fast query on indexed fields)
    const [totalResults, inboxRecords] = await Promise.all([
      UserInboxModel.countDocuments(inboxFilters),
      UserInboxModel.find(inboxFilters)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({ path: 'notificationId', select: 'type content projectId createdAt' }) // 2. Populate core content
        .lean(),
    ]);

    // 3. Map to DTO
    const data = (inboxRecords as any[])
      .filter(record => record.notificationId) // Filter out any null populated records
      .map(record => ({
        id: record._id.toString(),
        notificationId: record.notificationId._id.toString(),
        read: record.read,
        type: record.notificationId.type,
        title: record.notificationId.content?.in_app?.title,
        body: record.notificationId.content?.in_app?.body,
        projectId: record.notificationId.projectId?.toString(),
        createdAt: record.createdAt?.toISOString() || record.notificationId.createdAt?.toISOString() || new Date().toISOString(),
      }));

    return {
      meta: {
        page: pageNum,
        per_page: limit,
        total: totalResults,
        total_pages: Math.ceil(totalResults / limit),
      },
      data,
    };
  }

  /**
   * Marks one or more notifications as read.
   * @param requesterId - User ID of requester
   * @param ids - Array of inbox entry IDs to mark as read
   * @param markAll - If true, mark all unread notifications as read
   * @throws {Error} - May throw database errors
   */
  public async markRead(requesterId: string, ids: string[], markAll: boolean): Promise<void> {
    const userId = new Types.ObjectId(requesterId);

    const filters: any = { userId, read: false, deleted: false };

    if (markAll) {
      // If markAll is true, no need for ID filter - mark all unread
    } else if (ids.length > 0) {
      // Mark specific IDs
      filters._id = { $in: ids.map(id => new Types.ObjectId(id)) };
    } else {
      // Nothing to do
      return;
    }

    const result = await UserInboxModel.updateMany(filters, {
      $set: { read: true, readAt: new Date() },
    });

    // PRODUCTION: Emit 'notification.read' event for analytics/real-time updates
    console.warn(`[Event] User ${requesterId} marked ${result.modifiedCount} notifications as read.`);
  }

  /**
   * Retrieves the total count of unread notifications.
   * @param requesterId - User ID of requester
   * @returns Unread count
   */
  public async getUnreadCount(requesterId: string): Promise<number> {
    const userId = new Types.ObjectId(requesterId);

    // PERFORMANCE: Direct, indexed count query
    const count = await UserInboxModel.countDocuments({
      userId,
      read: false,
      deleted: false,
    });

    return count;
  }

  // --- Email Provider Adapter Methods ---

  /**
   * Simulates dispatching a notification email. Called by the Worker/Job (Task 47).
   * @param recipientEmail - Recipient email address
   * @param content - Rendered notification content
   * @param notificationId - Internal notification ID for webhook correlation
   * @returns Email send response with provider message ID
   */
  public async sendEmailNotification(
    recipientEmail: string,
    content: { email?: { subject?: string; html?: string; text?: string } },
    notificationId: string
  ): Promise<{ providerMessageId: string; status: 'sent' | 'pending' }> {
    // 1. Build Provider DTO
    const sendDto: IEmailSendDTO = {
      to: recipientEmail,
      subject: content.email?.subject || 'Notification',
      html: content.email?.html || '',
      text: content.email?.text,
      providerRefId: notificationId, // Use internal ID for webhook correlation
    };

    // 2. Call Adapter
    const result = await emailAdapter.sendEmail(sendDto);

    // PRODUCTION: Create DispatchAttempt record for audit (Task 47)

    return result;
  }

  /**
   * Handles incoming webhook events from the Email Provider (e.g., bounce, delivered).
   * @param payload - Webhook event payload
   * @param signature - Webhook signature for verification
   * @throws {Error} - 'InvalidWebhookSignature' if signature verification fails
   */
  public async handleEmailWebhook(payload: any, signature: string): Promise<void> {
    // 1. SECURITY: Verify Signature
    const rawPayload = JSON.stringify(payload);
    if (!emailAdapter.verifyWebhookSignature(rawPayload, signature)) {
      throw new Error('InvalidWebhookSignature');
    }

    // 2. Process Events (Mock Logic)
    if (Array.isArray(payload)) {
      for (const event of payload) {
        const { event: type, email, providerMessageId: _providerMessageId } = event; // Example fields

        // PRODUCTION: Find DispatchAttempt record by providerMessageId/email
        // Update status to 'success' or 'permanent_failed' (bounce)

        if (type === 'bounce') {
          // CRITICAL: Trigger bounce suppression logic here (Task 60)
          console.warn(`[Bounce/Webhook] Permanent Failure for ${email}. Triggering suppression.`);
        }
      }
    }
  }
}
