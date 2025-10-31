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
}
