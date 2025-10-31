import { AgreementModel, IAgreement, ISigner, IPayloadJson } from '../models/agreement.model';
import { ProjectModel, IProject } from '../models/project.model';
import { Types } from 'mongoose';

// Mock Job/Event Emitter
class MockJobQueue {
  public enqueuePdfJob(agreementId: string): void {
    console.warn(`[Job Enqueued] Final PDF generation for Agreement ${agreementId}.`);
  }
}
const jobQueue = new MockJobQueue();

// Mock Event Emitter
class MockEventEmitter {
  public emit(event: string, payload: any): void {
    console.warn(`[EVENT EMITTED] ${event}:`, JSON.stringify(payload));
  }
}
const eventEmitter = new MockEventEmitter();

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

  /**
   * Finds the signer entry for the authenticated user based on ID or email.
   * @param agreement - Agreement document
   * @param requesterId - User ID or email to match
   * @returns Signer entry
   * @throws {Error} - 'SignerNotFound'
   */
  private findSignerEntry(agreement: IAgreement, requesterId: string): ISigner {
    const signerEntry = agreement.signers.find(
      signer =>
        (signer.signerId && signer.signerId.toString() === requesterId) ||
        signer.email === requesterId // Use email if signerId is null or match by email
    );

    if (!signerEntry) {
      throw new Error('SignerNotFound');
    }
    return signerEntry;
  }

  /**
   * Handles the completion of an agreement signature. Supports 'typed' and 'complete_esign' (webhook).
   * @param agreementId - The ID of the agreement
   * @param requesterId - The ID or Email of the signer
   * @param method - 'typed' or 'complete_esign'
   * @param signatureName - The user's typed name (for 'typed' method)
   * @returns Updated agreement
   * @throws {Error} - 'AgreementNotFound', 'AlreadySigned', 'SignatureInvalid', 'AgreementNotInSignableState'
   */
  public async completeSigning(
    agreementId: string,
    requesterId: string,
    method: 'typed' | 'complete_esign',
    _signatureName?: string // Reserved for future use (audit trail)
  ): Promise<IAgreement> {
    // 1. Fetch Agreement by agreementId (short string ID) and Find Signer
    const agreement = await AgreementModel.findOne({ agreementId });
    if (!agreement) {
      throw new Error('AgreementNotFound');
    }

    const agreementObj = agreement.toObject() as IAgreement;
    const signerEntry = this.findSignerEntry(agreementObj, requesterId);

    // 2. Validate Signer Status
    if (signerEntry.signed) {
      throw new Error('AlreadySigned');
    }

    // 3. Validate Agreement Status
    if (agreement.status !== 'draft' && agreement.status !== 'pending_signatures' && agreement.status !== 'partially_signed') {
      throw new Error('AgreementNotInSignableState');
    }

    // 4. Perform Atomic Update on Signer Sub-document
    const signedAt = new Date();
    const updateFields: Record<string, any> = {
      'signers.$.signed': true,
      'signers.$.signedAt': signedAt,
      'signers.$.signatureMethod': method === 'typed' ? 'typed' : 'esign',
    };

    // Use positional operator ($) to update the specific sub-document
    const updatedAgreement = await AgreementModel.findOneAndUpdate(
      { agreementId, 'signers.email': signerEntry.email },
      { $set: updateFields },
      { new: true }
    );

    if (!updatedAgreement) {
      throw new Error('SignatureInvalid'); // Failsafe if update fails
    }

    const updatedAgreementObj = updatedAgreement.toObject() as IAgreement;

    // 5. Check Finalization Status
    const isFullySigned = updatedAgreementObj.signers.every(s => s.signed);

    if (isFullySigned) {
      // 6. Finalize Agreement (Atomic Update)
      await AgreementModel.updateOne(
        { _id: updatedAgreement._id },
        {
          $set: {
            status: 'signed',
            immutableHash: `SHA256_MOCK_${agreementId}`, // Generate final hash (Task 28)
          },
        }
      );

      // 7. Trigger PDF Generation Job (Task 55)
      jobQueue.enqueuePdfJob(updatedAgreementObj.agreementId);

      // PRODUCTION: Emit 'agreement.fully_signed' event (Payment/Project services subscribe)
      eventEmitter.emit('agreement.fully_signed', {
        agreementId: updatedAgreementObj.agreementId,
        projectId: updatedAgreementObj.projectId.toString(),
      });

      updatedAgreementObj.status = 'signed'; // Update in-memory copy for response
    } else {
      // 8. Update status to partially signed if necessary
      await AgreementModel.updateOne(
        { _id: updatedAgreement._id },
        { $set: { status: 'partially_signed' } }
      );
      updatedAgreementObj.status = 'partially_signed';
    }

    // PRODUCTION: Emit 'agreement.signed' event (Notifications subscribe)
    eventEmitter.emit('agreement.signed', {
      agreementId,
      signerEmail: signerEntry.email,
      status: updatedAgreementObj.status,
    });

    return updatedAgreementObj;
  }
}

