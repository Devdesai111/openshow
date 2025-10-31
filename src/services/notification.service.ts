import crypto from 'crypto';
import * as handlebars from 'handlebars';
import { Types } from 'mongoose';
import { INotification, NotificationModel } from '../models/notification.model';
import { INotificationTemplate, NotificationTemplateModel } from '../models/notificationTemplate.model';

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

    // 5. Trigger Dispatcher/Job (Simulated)
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
}
