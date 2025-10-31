import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { AgreementModel } from '../../src/models/agreement.model';
import { AssetModel } from '../../src/models/asset.model';
import { AssetUploadSessionModel } from '../../src/models/assetUploadSession.model';

describe('Agreement PDF Download Integration Tests', () => {
  let ownerToken: string;
  let ownerId: string;
  let signer1Token: string;
  let signer1Id: string;
  let signer1Email: string;
  let signer2Token: string;
  let signer2Id: string;
  let signer2Email: string;
  let memberToken: string;
  let memberId: string;
  let nonSignerToken: string;
  let projectId: string;
  let agreementId: string;
  let pdfAssetId: string;

  beforeAll(async () => {
    const testDbUri = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/openshow-test';
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    await mongoose.connect(testDbUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await AgreementModel.deleteMany({});
    await AssetModel.deleteMany({});
    await AssetUploadSessionModel.deleteMany({});

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerToken = ownerSignup.body.accessToken;
    ownerId = ownerSignup.body.user.id;

    // Create signer1 user
    const signer1Signup = await request(app).post('/auth/signup').send({
      email: 'signer1@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Signer One',
    });
    signer1Token = signer1Signup.body.accessToken;
    signer1Id = signer1Signup.body.user.id;
    signer1Email = signer1Signup.body.user.email;

    // Create signer2 user
    const signer2Signup = await request(app).post('/auth/signup').send({
      email: 'signer2@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Signer Two',
    });
    signer2Token = signer2Signup.body.accessToken;
    signer2Id = signer2Signup.body.user.id;
    signer2Email = signer2Signup.body.user.email;

    // Create member user (not a signer)
    const memberSignup = await request(app).post('/auth/signup').send({
      email: 'member@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Project Member',
    });
    memberToken = memberSignup.body.accessToken;
    memberId = memberSignup.body.user.id;

    // Create non-signer user (not a member either)
    const nonSignerSignup = await request(app).post('/auth/signup').send({
      email: 'nonsigner@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Non Signer',
    });
    nonSignerToken = nonSignerSignup.body.accessToken;

    // Create project
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Test Project',
        category: 'Film Production',
        visibility: 'private',
        roles: [{ title: 'Director', slots: 1 }],
        revenueModel: {
          splits: [{ userId: ownerId, percentage: 100 }],
        },
      });
    projectId = projectResponse.body.projectId;

    // Add member to project
    await ProjectModel.findByIdAndUpdate(projectId, {
      $push: { teamMemberIds: new mongoose.Types.ObjectId(memberId) },
    });

    // Add signers as project members (for asset access)
    await ProjectModel.findByIdAndUpdate(projectId, {
      $push: {
        teamMemberIds: {
          $each: [new mongoose.Types.ObjectId(signer1Id), new mongoose.Types.ObjectId(signer2Id)],
        },
      },
    });

    // Create agreement draft
    const agreementResponse = await request(app)
      .post(`/projects/${projectId}/agreements/generate`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        title: 'Test Agreement',
        signers: [
          { signerId: signer1Id, email: signer1Email, role: 'Signer' },
          { signerId: signer2Id, email: signer2Email, role: 'Signer' },
        ],
        payloadJson: {
          title: 'Test Agreement',
          licenseType: 'Non-Exclusive (royalty-based)',
          terms: 'Test terms',
          splits: [{ percentage: 100 }],
        },
      });
    agreementId = agreementResponse.body.agreementId;

    // Create PDF asset (simulating completed PDF generation)
    const signedUrlResponse = await request(app)
      .post('/assets/signed-upload-url')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'agreement-signed.pdf',
        mimeType: 'application/pdf',
        projectId,
      });
    const { assetUploadId } = signedUrlResponse.body;

    const registerResponse = await request(app)
      .post('/assets/register')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        assetUploadId,
        storageKey: `uploads/${projectId}/${ownerId}/agreement-signed.pdf`,
        size: 2048000,
        sha256: 'pdf-hash',
      });
    pdfAssetId = registerResponse.body.assetId;
  });

  describe('GET /agreements/:agreementId/pdf', () => {
    it('T27.1 - should successfully download PDF (happy path - ready document)', async () => {
      // Arrange - Sign agreement fully and attach PDF asset
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({
          method: 'typed',
          signatureName: 'Signer One',
        });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({
          method: 'typed',
          signatureName: 'Signer Two',
        });

      // Attach PDF asset to agreement
      await AgreementModel.updateOne(
        { agreementId },
        { $set: { pdfAssetId: new mongoose.Types.ObjectId(pdfAssetId) } }
      );

      // Act - Signer1 downloads PDF
      const response = await request(app)
        .get(`/agreements/${agreementId}/pdf`)
        .set('Authorization', `Bearer ${signer1Token}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('downloadUrl');
      expect(response.body).toHaveProperty('downloadUrlExpiresAt');
      expect(response.body).toHaveProperty('filename', `Agreement-${agreementId}.pdf`);
      expect(response.body.downloadUrl).toBeTruthy();
      expect(response.body.downloadUrlExpiresAt).toBeTruthy();
    });

    it('should allow project member to download PDF', async () => {
      // Arrange - Sign agreement fully and attach PDF asset
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      await AgreementModel.updateOne(
        { agreementId },
        { $set: { pdfAssetId: new mongoose.Types.ObjectId(pdfAssetId) } }
      );

      // Act - Member downloads PDF
      const response = await request(app)
        .get(`/agreements/${agreementId}/pdf`)
        .set('Authorization', `Bearer ${memberToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('downloadUrl');
      expect(response.body).toHaveProperty('downloadUrlExpiresAt');
    });

    it('T27.2 - should fail when agreement is not fully signed (409)', async () => {
      // Arrange - Only signer1 has signed
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({
          method: 'typed',
          signatureName: 'Signer One',
        });

      // Act - Try to download PDF
      const response = await request(app)
        .get(`/agreements/${agreementId}/pdf`)
        .set('Authorization', `Bearer ${signer1Token}`);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('not yet fully signed');
    });

    it('T27.3 - should fail when PDF asset is pending (409)', async () => {
      // Arrange - Fully sign agreement but don't attach PDF asset
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      // Act - Try to download PDF (agreement is signed but PDF not generated)
      const response = await request(app)
        .get(`/agreements/${agreementId}/pdf`)
        .set('Authorization', `Bearer ${signer1Token}`);

      // Assert
      expect(response.status).toBe(409);
      expect(response.body.error).toHaveProperty('code', 'conflict');
      expect(response.body.error.message).toContain('still being generated');
    });

    it('T27.4 - should fail when non-signer/non-member tries to download (403)', async () => {
      // Arrange - Fully sign agreement and attach PDF asset
      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer1Token}`)
        .send({ method: 'typed', signatureName: 'Signer One' });

      await request(app)
        .post(`/agreements/${agreementId}/sign`)
        .set('Authorization', `Bearer ${signer2Token}`)
        .send({ method: 'typed', signatureName: 'Signer Two' });

      await AgreementModel.updateOne(
        { agreementId },
        { $set: { pdfAssetId: new mongoose.Types.ObjectId(pdfAssetId) } }
      );

      // Act - Non-signer/non-member tries to download
      const response = await request(app)
        .get(`/agreements/${agreementId}/pdf`)
        .set('Authorization', `Bearer ${nonSignerToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('not authorized');
    });

    it('should return 404 for non-existent agreement', async () => {
      // Act
      const response = await request(app)
        .get('/agreements/nonexistent_123/pdf')
        .set('Authorization', `Bearer ${signer1Token}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).get(`/agreements/${agreementId}/pdf`);

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should validate agreementId format', async () => {
      // Act
      const response = await request(app)
        .get('/agreements/invalid-id-format/pdf')
        .set('Authorization', `Bearer ${signer1Token}`);

      // Assert - Should pass validation (agreementId is just a string)
      // The actual check happens in service
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });
});

