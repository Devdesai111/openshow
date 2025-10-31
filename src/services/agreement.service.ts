import { AgreementModel, IAgreement, ISigner, IPayloadJson } from '../models/agreement.model';
import { ProjectModel, IProject } from '../models/project.model';
import { Types } from 'mongoose';

// DTO for initial draft request
interface IGenerateDraftRequest {
  templateId?: string;
  title: string;
  signers: Omit<ISigner, 'signed' | 'signedAt' | 'signatureMethod'>[];
  payloadJson: IPayloadJson;
  signOrderEnforced?: boolean;
}

export class AgreementService {
  /**
   * Checks if the requester is the project owner.
   * @throws {Error} 'PermissionDenied' | 'ProjectNotFound'
   */
  private async checkOwnerAccess(projectId: string, requesterId: string): Promise<IProject> {
    const project = (await ProjectModel.findById(new Types.ObjectId(projectId)).lean()) as IProject | null;
    if (!project) {
      throw new Error('ProjectNotFound');
    }
    if (project.ownerId.toString() !== requesterId) {
      throw new Error('PermissionDenied');
    }
    return project;
  }

  /**
   * Simulates template population logic.
   */
  private mockTemplatePopulation(payload: IPayloadJson): string {
    // PRODUCTION: Use Handlebars or similar for deterministic template rendering.
    return `<html><body><h1>${payload.title}</h1><p>License: ${payload.licenseType}</p><p>Splits: ${JSON.stringify(payload.splits)}</p></body></html>`;
  }

  /**
   * Generates a new agreement draft based on project data and template.
   * @throws {Error} 'ProjectNotFound' | 'PermissionDenied' | 'SignersInvalid'.
   */
  public async generateAgreementDraft(
    projectId: string,
    requesterId: string,
    data: IGenerateDraftRequest
  ): Promise<IAgreement & { previewHtml: string }> {
    const project = await this.checkOwnerAccess(projectId, requesterId);

    // 1. Validate Signers (must have email)
    if (!data.signers || data.signers.length === 0) {
      throw new Error('SignersInvalid');
    }

    // 2. Prepare Signer List (Initialize status to false)
    const initialSigners: ISigner[] = data.signers.map(signer => ({
      ...signer,
      signed: false,
      signerId: signer.signerId ? new Types.ObjectId(signer.signerId) : undefined,
    }));

    // 3. Create canonical payload (ensure deterministic structure for later hashing)
    const canonicalPayload: IPayloadJson = {
      ...data.payloadJson,
      // SECURITY: Ensure that all essential, signed data is captured in payloadJson
    };

    // 4. Create Draft Agreement
    const newAgreement = new AgreementModel({
      projectId: project._id,
      createdBy: new Types.ObjectId(requesterId),
      title: data.title,
      templateId: data.templateId,
      payloadJson: canonicalPayload,
      signers: initialSigners,
      signOrderEnforced: data.signOrderEnforced || false,
      version: 1,
      status: 'draft',
    });

    const savedAgreement = await newAgreement.save();

    // 5. Generate preview HTML (simulated)
    const previewHtml = this.mockTemplatePopulation(canonicalPayload);

    // PRODUCTION: Emit 'agreement.generated' event
    console.warn(`[Event] Agreement ${savedAgreement.agreementId} created as draft.`);

    return { ...(savedAgreement.toObject() as IAgreement), previewHtml };
  }
}

