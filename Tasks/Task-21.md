Following the structured plan, we proceed with **Task 21: Agreements/Licensing Core (Generate Draft)**.

This task is the foundational step for the legal and licensing service, implementing the domain model and the endpoint for generating a working *draft* of a contributor agreement, populated with live data from the Project Management Service.

***

## **Task 21: Agreements/Licensing Core (Generate Draft)**

**Goal:** Implement the primary `Agreement` model and the endpoint to generate a draft contributor agreement (`POST /projects/:id/agreements/generate`) by using project and revenue split data to populate a simple template structure.

**Service:** `Agreements & Licensing Service`
**Phase:** D - Agreements, Licensing & Audit foundations
**Dependencies:** Task 12 (Project Model/Service), Task 2 (RBAC Middleware).

**Output Files:**
1.  `src/models/agreement.model.ts` (New file: IAgreement and sub-schemas)
2.  `src/services/agreement.service.ts` (New file: `generateAgreementDraft`)
3.  `src/controllers/agreement.controller.ts` (New file: agreement controller)
4.  `src/routes/agreement.routes.ts` (New file: router for `/agreements`)
5.  `test/integration/agreement_draft.test.ts` (Test specification)

**Input/Output Shapes:**

| Endpoint | Request (Body/Params) | Response (201 Created) | Access/Scope |
| :--- | :--- | :--- | :--- |
| **POST /projects/:id/agreements/generate** | `Params: { projectId }`, Body: `{ templateId, title, signers: [], payloadJson: {} }` | `{ agreementId, projectId, status: 'draft', version: 1 }` | Auth (Owner only) |

**AgreementDTO (Excerpt):**
```json
{
  "agreementId": "ag_1234",
  "projectId": "proj_abc",
  "title": "Contributor Agreement - Alpha",
  "status": "draft",
  "signers": [ { "email": "owner@a.com", "signed": false } ],
  "payloadJson": { "licenseType": "Exclusive", "splits": [...] },
  "version": 1
}
```

**Runtime & Env Constraints:**
*   **Immutability Prep:** The `payloadJson` must store the full canonical state (revenue splits, terms) at the time of creation, which will be hashed later for immutability.
*   **Authorization:** Strictly restricted to the project owner or Admin.
*   **Template Logic (Mocked):** The service simulates reading a template and merging project data/user emails for the `signers` list.

**Acceptance Criteria:**
*   Successful generation returns **201 Created** and persists the agreement with `status: 'draft'` and `version: 1`.
*   The `signers` array is correctly populated with placeholder `signed: false` status for all parties.
*   Access must be restricted to the project owner (403 Forbidden).
*   The system must validate that all fields required for the agreement (`title`, `signers`, basic `payloadJson`) are present (422 Unprocessable).

**Tests to Generate:**
*   **Integration Test (Generate):** Test happy path, including populating signers and storing `payloadJson`.
*   **Integration Test (Security):** Test non-owner attempt to generate draft (403).

**Non-Goals / Out-of-Scope (for Task 21):**
*   Full PDF generation (Task 55).
*   E-signature integration (Task 26).
*   Full Mongoose document validation for the `payloadJson` content (validation is minimal on required structure).

***

### **Task 21 Code Implementation**

#### **21.1. `src/models/agreement.model.ts` (New Model)**

```typescript
// src/models/agreement.model.ts
import { Schema, model, Types } from 'mongoose';

// --- Nested Interfaces ---

export interface ISigner {
  signerId?: Types.ObjectId; // Platform User ID
  name?: string; // Non-platform signer name
  email: string; // Required for all signers
  role?: string; 
  signed: boolean;
  signedAt?: Date;
  signatureMethod?: 'esign' | 'typed' | 'wet';
  // Note: providerRef/signatureHash omitted from primary schema for minimal PII/complexity
}

// Defines the content to be legally signed (canonical source of truth)
export interface IPayloadJson {
    title: string;
    licenseType: 'Exclusive Ownership' | 'Non-Exclusive (royalty-based)' | 'Creative Commons';
    terms: string;
    splits: { userId?: string, placeholder?: string, percentage: number }[];
    // ... other core legal terms
}

// --- Main Agreement Interface ---

export interface IAgreement {
  _id?: Types.ObjectId;
  agreementId: string;
  projectId: Types.ObjectId;
  createdBy: Types.ObjectId; // Project owner who generated it
  templateId?: string;
  title: string;
  payloadJson: IPayloadJson; // Canonical JSON payload for hashing
  status: 'draft' | 'pending_signatures' | 'partially_signed' | 'signed' | 'cancelled' | 'expired';
  signers: ISigner[];
  signOrderEnforced: boolean;
  pdfAssetId?: Types.ObjectId; // Asset ID of the final signed PDF (Task 55)
  version: number;
  immutableHash?: string; // SHA256 of canonical payload + signatures
  createdAt?: Date;
  updatedAt?: Date;
}

// --- Nested Schemas ---

const SignerSchema = new Schema<ISigner>({
  signerId: { type: Schema.Types.ObjectId, ref: 'User' },
  email: { type: String, required: true },
  signed: { type: Boolean, default: false },
  signedAt: { type: Date },
  signatureMethod: { type: String, enum: ['esign', 'typed', 'wet'] },
}, { _id: false });

const AgreementSchema = new Schema<IAgreement>({
  agreementId: { type: String, required: true, unique: true, default: () => `ag_${crypto.randomBytes(8).toString('hex')}` },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 255 },
  payloadJson: { type: Schema.Types.Mixed, required: true }, // Store as Mixed/JSONB
  status: { type: String, enum: ['draft', 'pending_signatures', 'partially_signed', 'signed', 'cancelled', 'expired'], default: 'draft', index: true },
  signers: { type: [SignerSchema], default: [], required: true },
  signOrderEnforced: { type: Boolean, default: false },
  pdfAssetId: { type: Schema.Types.ObjectId, ref: 'Asset' },
  version: { type: Number, default: 1 },
  immutableHash: { type: String },
}, { timestamps: true });

export const AgreementModel = model<IAgreement>('Agreement', AgreementSchema);
```

#### **21.2. `src/services/agreement.service.ts` (New File)**

```typescript
// src/services/agreement.service.ts
import { AgreementModel, IAgreement, ISigner, IPayloadJson } from '../models/agreement.model';
import { ProjectModel, IProject } from '../models/project.model';
import { Types } from 'mongoose';
import { IUser } from '../models/user.model';
import { AuthService } from './auth.service'; // For user existence checks

// DTO for initial draft request
interface IGenerateDraftRequest {
    templateId: string; 
    title: string;
    signers: Omit<ISigner, 'signed' | 'signedAt' | 'signatureMethod'>[];
    payloadJson: IPayloadJson;
    signOrderEnforced?: boolean;
}

export class AgreementService {
    
    /** Checks if the requester is the project owner. @throws {Error} 'PermissionDenied' | 'ProjectNotFound' */
    private async checkOwnerAccess(projectId: string, requesterId: string): Promise<IProject> {
        const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
        if (!project) { throw new Error('ProjectNotFound'); }
        if (project.ownerId.toString() !== requesterId) { throw new Error('PermissionDenied'); }
        return project;
    }
    
    /** Simulates template population logic. */
    private mockTemplatePopulation(payload: IPayloadJson): string {
        // PRODUCTION: Use Handlebars or similar for deterministic template rendering.
        return `<html><body><h1>${payload.title}</h1><p>License: ${payload.licenseType}</p><p>Splits: ${JSON.stringify(payload.splits)}</p></body></html>`;
    }

    /**
     * Generates a new agreement draft based on project data and template.
     * @throws {Error} 'ProjectNotFound' | 'PermissionDenied' | 'SignersInvalid'.
     */
    public async generateAgreementDraft(projectId: string, requesterId: string, data: IGenerateDraftRequest): Promise<IAgreement & { previewHtml: string }> {
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
        console.log(`[Event] Agreement ${savedAgreement.agreementId} created as draft.`);

        return { ...savedAgreement.toObject() as IAgreement, previewHtml };
    }
}
```

#### **21.3. `src/controllers/agreement.controller.ts` (New File)**

```typescript
// src/controllers/agreement.controller.ts
import { Request, Response } from 'express';
import { param, body, validationResult } from 'express-validator';
import { AgreementService } from '../services/agreement.service';
import { Types } from 'mongoose';

const agreementService = new AgreementService();

// --- Validation Middleware ---

export const generateAgreementValidation = [
    param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
    body('title').isString().isLength({ min: 5 }).withMessage('Agreement title is required.'),
    body('signers').isArray({ min: 1 }).withMessage('At least one signer is required.'),
    body('signers.*.email').isEmail().withMessage('Signer email is required and must be valid.'),
    body('payloadJson.licenseType').isString().withMessage('License type must be defined in payload.'),
    // NOTE: Further validation on revenue splits and other payload fields can be added here
];


/** Generates an agreement draft. POST /projects/:projectId/agreements/generate */
export const generateAgreementController = async (req: Request, res: Response) => {
    // 1. Input Validation
    if (!validationResult(req).isEmpty()) { return res.status(422).json({ error: { code: 'validation_error', message: 'Input validation failed.', details: validationResult(req).array() }}); }
    
    try {
        const { projectId } = req.params;
        const requesterId = req.user!.sub;

        // 2. Service Call
        const result = await agreementService.generateAgreementDraft(projectId, requesterId, req.body);

        // 3. Success (201 Created)
        return res.status(201).json({
            agreementId: result.agreementId,
            projectId: result.projectId.toString(),
            title: result.title,
            status: result.status,
            version: result.version,
            previewHtml: result.previewHtml,
            createdAt: result.createdAt!.toISOString(),
        });

    } catch (error: any) {
        // 4. Error Handling
        if (error.message === 'PermissionDenied') { return res.status(403).json({ error: { code: 'not_owner', message: 'Only the project owner can generate legal documents.' } }); }
        if (error.message === 'ProjectNotFound') { return res.status(404).json({ error: { code: 'project_not_found', message: 'Project not found.' } }); }
        if (error.message === 'SignersInvalid') { return res.status(422).json({ error: { code: 'signers_missing', message: 'The list of signers is invalid or empty.' } }); }
        return res.status(500).json({ error: { code: 'server_error', message: 'Internal server error generating agreement draft.' } });
    }
};
```

#### **21.4. `src/routes/agreement.routes.ts` (New File)**

```typescript
// src/routes/agreement.routes.ts
import { Router } from 'express';
import { generateAgreementController, generateAgreementValidation } from '../controllers/agreement.controller';
import { authenticate } from '../middlewares/auth.middleware'; 
import { authorize } from '../middlewares/rbac.middleware';
import { PERMISSIONS } from '../config/permissions';
import { param } from 'express-validator';

const router = Router();
const projectIdValidation = [param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail()];

// --- Agreements Endpoints ---

// POST /projects/:projectId/agreements/generate - Generate agreement draft (Task 21)
router.post(
    '/projects/:projectId/agreements/generate',
    authenticate,
    // RBAC: Requires Project Edit permission (implicit mutation of project's legal state)
    authorize([PERMISSIONS.PROJECT_CREATE]), 
    generateAgreementValidation,
    generateAgreementController
);


// NOTE: Future endpoints (signing, download, status updates) will be added here.

export default router;
```

#### **21.5. Test Specification**

| Test ID | Endpoint | Description | Input (Signers) | Expected Status | Expected Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **T21.1** | `POST /projects/:id/agreements/generate` | Happy Path | `[{ email: "test@a.com", role: "Director" }]` | **201 Created** | N/A (`status: draft`) |
| **T21.2** | `POST /projects/:id/agreements/generate` | Fail: Not Owner | Authenticated Non-Owner | **403 Forbidden** | `not_owner` |
| **T21.3** | `POST /projects/:id/agreements/generate` | Fail: Missing Signer | Missing `signers` array | **422 Unprocessable** | `signers_missing` |
| **T21.4** | `POST /projects/:id/agreements/generate` | Output Check | N/A | **201 Created** | Response includes `previewHtml` and `signers` with `signed: false`. |

---
