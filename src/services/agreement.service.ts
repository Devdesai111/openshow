import { AgreementModel, IAgreement, ISigner, IPayloadJson } from '../models/agreement.model';
import { ProjectModel, IProject } from '../models/project.model';
import { AssetService } from './asset.service';
import { IAuthUser } from '../middleware/auth.middleware';
import { Types } from 'mongoose';
import * as crypto from 'crypto';

const assetService = new AssetService();

// --- Utility: Canonicalization ---

/**
 * Deterministically stringifies an object by sorting keys for stable hashing.
 */
function canonicalizeJson(obj: any): string {
  if (typeof obj !== 'object' || obj === null) {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  // Sort keys and recurse
  const keys = Object.keys(obj).sort();
  const parts = keys.map(key => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`);
  return '{' + parts.join(',') + '}';
}

/**
 * Computes the immutable SHA256 hash of the core agreement data.
 * @param agreement - Agreement document to hash
 * @returns SHA256 hash prefixed with 'sha256:'
 */
export function computeCanonicalHash(agreement: IAgreement): string {
  // 1. Combine core components for hashing
  const hashableObject = {
    payload: agreement.payloadJson,
    signers: agreement.signers.map(s => ({
      // Only include immutable signature-related metadata
      email: s.email,
      signedAt: s.signedAt ? s.signedAt.toISOString() : null,
      signatureMethod: s.signatureMethod,
    })),
    // Add agreement metadata that anchors the version
    agreementId: agreement.agreementId,
    version: agreement.version,
  };

  // 2. Canonicalize and Hash
  const canonicalString = canonicalizeJson(hashableObject);
  return `sha256:${crypto.createHash('sha256').update(canonicalString).digest('hex')}`;
}

// Mock Job/Event Emitter
class MockJobQueue {
  public enqueuePdfJob(agreementId: string): void {
    console.warn(`[Job Enqueued] Final PDF generation for Agreement ${agreementId}.`);
  }

  public enqueueAnchorJob(agreementId: string, hash: string): string {
    console.warn(`[Job Enqueued] Blockchain anchoring for Agreement ${agreementId}. Hash: ${hash}`);
    return `job_${crypto.randomBytes(4).toString('hex')}`;
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

  /**
   * Checks if the requester is a Signer, Project Member, or Admin.
   * @param agreement - Agreement document
   * @param requesterId - User ID or email
   * @param requesterRole - User role
   * @throws {Error} 'PermissionDenied'
   */
  private async checkDocumentAccess(
    agreement: IAgreement,
    requesterId: string,
    requesterRole: IAuthUser['role']
  ): Promise<void> {
    const isSigner = agreement.signers.some(
      s => (s.signerId && s.signerId.toString() === requesterId) || s.email === requesterId
    );
    const isAdmin = requesterRole === 'admin';

    // Check Project Membership
    const project = (await ProjectModel.findById(agreement.projectId)
      .select('teamMemberIds')
      .lean()) as IProject | null;
    const isMember = project?.teamMemberIds.some(id => id.toString() === requesterId) || false;

    if (!isSigner && !isMember && !isAdmin) {
      throw new Error('PermissionDenied');
    }
  }

  /**
   * Retrieves the secure signed PDF download URL.
   * @param agreementId - Agreement ID (short string)
   * @param requesterId - User ID or email
   * @param requesterRole - User role
   * @returns Download URL response
   * @throws {Error} - 'AgreementNotFound', 'PermissionDenied', 'DocumentNotFinalized', 'PdfAssetPending'
   */
  public async getSignedPdfUrl(
    agreementId: string,
    requesterId: string,
    requesterRole: IAuthUser['role']
  ): Promise<{
    downloadUrl: string | null;
    downloadUrlExpiresAt: string | null;
    filename: string;
  }> {
    // 1. Fetch Agreement
    const agreement = await AgreementModel.findOne({ agreementId }).lean() as IAgreement | null;
    if (!agreement) {
      throw new Error('AgreementNotFound');
    }

    // 2. Authorization Check
    await this.checkDocumentAccess(agreement, requesterId, requesterRole);

    // 3. Status Check (Must be fully signed and PDF asset generated)
    if (agreement.status !== 'signed') {
      throw new Error('DocumentNotFinalized'); // Explicit 409 conflict
    }
    if (!agreement.pdfAssetId) {
      // Document is signed, but PDF generation job (Task 55) has not completed yet
      throw new Error('PdfAssetPending'); // Explicit 409 conflict/202 accepted
    }

    // 4. Retrieve Signed URL from Asset Service (Decoupling)
    // AssetService.getAssetAndSignedDownloadUrl already performs access checks
    const assetDetails = await assetService.getAssetAndSignedDownloadUrl(
      agreement.pdfAssetId.toString(),
      requesterId,
      requesterRole,
      true // Ensure presign is true
    );

    // 5. Return Download DTO
    return {
      downloadUrl: assetDetails.downloadUrl || null,
      downloadUrlExpiresAt: assetDetails.downloadUrlExpiresAt || null,
      filename: `Agreement-${agreement.agreementId}.pdf`,
    };
  }

  /**
   * Computes, stores the immutable hash, and triggers optional chain anchoring.
   * @param agreementId - Agreement ID (short string)
   * @param requesterId - User ID (admin/system)
   * @param anchorChain - Whether to trigger blockchain anchoring
   * @returns Hash storage result
   * @throws {Error} - 'AgreementNotFound', 'NotFullySigned', 'AlreadyHashed'
   */
  public async storeImmutableHash(
    agreementId: string,
    _requesterId: string, // Reserved for future audit trail
    anchorChain: boolean
  ): Promise<{
    status: string;
    immutableHash: string;
    jobId?: string;
    message: string;
  }> {
    const agreement = await AgreementModel.findOne({ agreementId });
    if (!agreement) {
      throw new Error('AgreementNotFound');
    }

    if (agreement.status !== 'signed') {
      throw new Error('NotFullySigned');
    }
    if (agreement.immutableHash) {
      throw new Error('AlreadyHashed'); // Idempotency check
    }

    // 1. Compute Hash
    const immutableHash = computeCanonicalHash(agreement.toObject() as IAgreement);

    // 2. Persist Hash
    agreement.immutableHash = immutableHash;
    await agreement.save();

    let jobId: string | undefined;
    let message = 'Hash computed and stored.';

    // 3. Trigger Anchoring Job (Task 57)
    if (anchorChain) {
      jobId = jobQueue.enqueueAnchorJob(agreementId, immutableHash);
      message = 'Hash stored and blockchain anchoring job queued.';
    }

    // PRODUCTION: Emit 'agreement.hashed' event
    eventEmitter.emit('agreement.hashed', { agreementId, immutableHash, jobId });

    return { status: 'hashed', immutableHash, jobId, message };
  }

  /** Worker-called method to update the final PDF asset ID on a fully signed agreement. */
  public async updatePdfAssetId(agreementId: string, pdfAssetId: string): Promise<void> {
    const agreementObjectId = new Types.ObjectId(agreementId);
    
    const result = await AgreementModel.updateOne(
      { _id: agreementObjectId, status: 'signed' }, // Concurrency/State check
      { $set: { pdfAssetId: new Types.ObjectId(pdfAssetId) } }
    );
    
    if (result.modifiedCount === 0) {
      throw new Error('AgreementNotSignedOrNotFound');
    }

    // PRODUCTION: Emit 'agreement.pdf.ready' event (Task 27 downloads unlock)
    console.log(`[Event] Agreement ${agreementId} PDF asset ID updated to ${pdfAssetId}.`);
  }

  /** Worker-called method to update the agreement with a successful anchoring transaction ID. */
  public async updateAnchorTxId(agreementId: string, txId: string, chain: string): Promise<void> {
    const agreementObjectId = new Types.ObjectId(agreementId);
    
    const update = {
      $push: { 
        blockchainAnchors: { txId, chain, createdAt: new Date() } // Append to array
      },
      // Optionally update status to permanently anchor the hash
    };

    const result = await AgreementModel.updateOne(
      { _id: agreementObjectId },
      update
    );
    
    if (result.modifiedCount === 0) {
      throw new Error('AgreementNotFound');
    }

    // PRODUCTION: Emit 'agreement.anchored' event
    console.log(`[Event] Agreement ${agreementId} anchored on ${chain} with TXID: ${txId}.`);
  }
}

