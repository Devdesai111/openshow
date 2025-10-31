import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { CreatorProfileModel } from '../../src/models/creatorProfile.model';

describe('User Profile CRUD Integration Tests', () => {
  let creatorAccessToken: string;
  let creatorUserId: string;
  let otherCreatorAccessToken: string;
  let adminAccessToken: string;
  let adminUserId: string;

  // Test database connection setup
  beforeAll(async () => {
    // Use test database
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
    // Clean up database before each test
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await CreatorProfileModel.deleteMany({});

    // Create creator user
    const creatorSignup = await request(app).post('/auth/signup').send({
      email: 'creator@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Creator User',
    });

    creatorAccessToken = creatorSignup.body.accessToken;
    creatorUserId = creatorSignup.body.user.id;

    // Create second creator
    const otherCreatorSignup = await request(app).post('/auth/signup').send({
      email: 'othercreator@example.com',
      password: 'Password123',
      role: 'creator',
    });

    otherCreatorAccessToken = otherCreatorSignup.body.accessToken;

    // Create admin user
    const adminSignup = await request(app).post('/auth/signup').send({
      email: 'admin@example.com',
      password: 'AdminPassword123',
      role: 'creator',
    });

    adminUserId = adminSignup.body.user.id;

    // Update admin role
    await UserModel.findByIdAndUpdate(adminUserId, { role: 'admin' });

    // Re-login to get token with admin role in JWT
    const adminLogin = await request(app).post('/auth/login').send({
      email: 'admin@example.com',
      password: 'AdminPassword123',
    });
    adminAccessToken = adminLogin.body.accessToken;
  });

  describe('GET /users/:userId', () => {
    it('should return public profile data when authenticated user views another profile', async () => {
      // Act
      const response = await request(app)
        .get(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${otherCreatorAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', creatorUserId);
      expect(response.body).toHaveProperty('preferredName');
      expect(response.body).toHaveProperty('role', 'creator');
      expect(response.body).toHaveProperty('verified', false);
      expect(response.body).toHaveProperty('skills');
      expect(response.body).toHaveProperty('createdAt');

      // Should NOT include private fields
      expect(response.body).not.toHaveProperty('email');
      expect(response.body).not.toHaveProperty('status');
    });

    it('should return full profile data when owner views own profile', async () => {
      // Act
      const response = await request(app)
        .get(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', creatorUserId);
      expect(response.body).toHaveProperty('preferredName');
      expect(response.body).toHaveProperty('role', 'creator');

      // SHOULD include private fields (owner access)
      expect(response.body).toHaveProperty('email', 'creator@example.com');
      expect(response.body).toHaveProperty('fullName', 'Creator User');
      expect(response.body).toHaveProperty('status', 'active');
    });

    it('should return full profile data when admin views any profile', async () => {
      // Act
      const response = await request(app)
        .get(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', creatorUserId);

      // SHOULD include private fields (admin access)
      expect(response.body).toHaveProperty('email', 'creator@example.com');
      expect(response.body).toHaveProperty('status', 'active');
    });

    it('should return 404 when user does not exist', async () => {
      // Act
      const response = await request(app)
        .get('/users/507f1f77bcf86cd799439011')
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should return 422 when userId format is invalid', async () => {
      // Act
      const response = await request(app)
        .get('/users/invalid-id')
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should work with authentication (shows more data for owner)', async () => {
      // Act - Authenticated request
      const authResponse = await request(app)
        .get(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Assert - Should have email (owner)
      expect(authResponse.status).toBe(200);
      expect(authResponse.body).toHaveProperty('email');
    });
  });

  describe('PUT /users/:userId', () => {
    it('should successfully update own profile', async () => {
      // Arrange
      const updateData = {
        preferredName: 'Updated Name',
        headline: 'Software Developer & Content Creator',
        bio: 'I love building amazing things with code and video.',
        skills: ['JavaScript', 'Video Editing', 'Animation'],
        languages: ['English', 'Spanish'],
        hourlyRate: 5000, // $50.00
      };

      // Act
      const response = await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send(updateData);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('preferredName', 'Updated Name');
      expect(response.body).toHaveProperty('headline', 'Software Developer & Content Creator');
      expect(response.body).toHaveProperty('bio');
      expect(response.body.bio).toContain('building amazing things');
      expect(response.body).toHaveProperty('skills');
      expect(response.body.skills).toContain('JavaScript');
      expect(response.body).toHaveProperty('languages');
      expect(response.body.languages).toContain('Spanish');

      // Verify changes in database
      const user = await UserModel.findById(creatorUserId);
      expect(user?.preferredName).toBe('Updated Name');

      const profile = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profile?.headline).toBe('Software Developer & Content Creator');
      expect(profile?.skills).toContain('Video Editing');
    });

    it('should fail when non-owner tries to update profile', async () => {
      // Act - Other creator tries to update first creator's profile
      const response = await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${otherCreatorAccessToken}`)
        .send({ preferredName: 'Hacked Name' });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', 'permission_denied');

      // Verify no changes in database
      const user = await UserModel.findById(creatorUserId);
      expect(user?.preferredName).not.toBe('Hacked Name');
    });

    it('should allow admin to update any user profile', async () => {
      // Act
      const response = await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ preferredName: 'Admin Updated Name' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('preferredName', 'Admin Updated Name');

      // Verify changes in database
      const user = await UserModel.findById(creatorUserId);
      expect(user?.preferredName).toBe('Admin Updated Name');
    });

    it('should validate bio max length (2000 chars)', async () => {
      // Arrange
      const longBio = 'a'.repeat(2001);

      // Act
      const response = await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ bio: longBio });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate headline max length (140 chars)', async () => {
      // Arrange
      const longHeadline = 'a'.repeat(141);

      // Act
      const response = await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ headline: longHeadline });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app).put(`/users/${creatorUserId}`).send({ preferredName: 'Test' });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });

    it('should return 404 when updating non-existent user', async () => {
      // Act
      const response = await request(app)
        .put('/users/507f1f77bcf86cd799439011')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ preferredName: 'Test' });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should create creator profile if it does not exist (upsert)', async () => {
      // Arrange - Verify no profile exists
      const profileBefore = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profileBefore).toBeNull();

      // Act - Update with creator-specific fields
      const response = await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          headline: 'New Creator Headline',
          bio: 'My creative bio',
          skills: ['Photography', 'Video'],
        });

      // Assert
      expect(response.status).toBe(200);

      // Verify profile was created
      const profileAfter = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profileAfter).toBeTruthy();
      expect(profileAfter?.headline).toBe('New Creator Headline');
      expect(profileAfter?.skills).toContain('Photography');
    });
  });

  describe('Access Control', () => {
    it('should show different data based on requester identity', async () => {
      // Arrange - Update creator profile
      await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          headline: 'Public Headline',
          bio: 'Public Bio',
        });

      // Act 1: Owner views own profile
      const ownerResponse = await request(app)
        .get(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`);

      // Act 2: Other user views profile
      const publicResponse = await request(app)
        .get(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${otherCreatorAccessToken}`);

      // Assert
      // Owner sees private data
      expect(ownerResponse.body).toHaveProperty('email');
      expect(ownerResponse.body).toHaveProperty('status');

      // Other user does NOT see private data
      expect(publicResponse.body).not.toHaveProperty('email');
      expect(publicResponse.body).not.toHaveProperty('status');

      // Both see public data
      expect(ownerResponse.body).toHaveProperty('headline', 'Public Headline');
      expect(publicResponse.body).toHaveProperty('headline', 'Public Headline');
    });

    it('should allow admin to see private data of any user', async () => {
      // Act
      const response = await request(app)
        .get(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`);

      // Assert - Admin sees private data
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('email', 'creator@example.com');
      expect(response.body).toHaveProperty('status', 'active');
    });
  });

  describe('Creator Profile Fields', () => {
    it('should handle creator-specific fields correctly', async () => {
      // Arrange & Act
      const response = await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          headline: 'Film Director & Editor',
          bio: 'Passionate about storytelling through visual media.',
          skills: ['Directing', 'Editing', 'Cinematography'],
          categories: ['Film', 'Documentary'],
          hourlyRate: 7500, // $75.00
          projectRate: 500000, // $5,000
          locations: ['Los Angeles', 'New York'],
          languages: ['English', 'French'],
          availability: 'open',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('headline', 'Film Director & Editor');
      expect(response.body).toHaveProperty('skills');
      expect(response.body.skills).toContain('Directing');
      expect(response.body).toHaveProperty('hourlyRate');
      expect(response.body.hourlyRate).toHaveProperty('amount', 7500);
      expect(response.body.hourlyRate).toHaveProperty('currency', 'USD');
      expect(response.body.hourlyRate).toHaveProperty('display', '$75.00');

      // Verify in database
      const profile = await CreatorProfileModel.findOne({ userId: creatorUserId });
      expect(profile?.headline).toBe('Film Director & Editor');
      expect(profile?.hourlyRate).toBe(7500);
      expect(profile?.availability).toBe('open');
    });

    it('should handle partial updates correctly', async () => {
      // Arrange - Create initial profile
      await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          headline: 'Initial Headline',
          bio: 'Initial Bio',
          skills: ['Skill1', 'Skill2'],
        });

      // Act - Update only headline
      const response = await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({ headline: 'Updated Headline Only' });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('headline', 'Updated Headline Only');
      expect(response.body).toHaveProperty('bio', 'Initial Bio'); // Should remain unchanged
      expect(response.body).toHaveProperty('skills');
      expect(response.body.skills).toContain('Skill1'); // Should remain unchanged
    });
  });

  describe('UserDTOMapper Integration', () => {
    it('should use CreatorProfileDTO for creator users', async () => {
      // Arrange - Create profile
      await request(app)
        .put(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${creatorAccessToken}`)
        .send({
          headline: 'Test Headline',
          skills: ['Test Skill'],
        });

      // Act
      const response = await request(app)
        .get(`/users/${creatorUserId}`)
        .set('Authorization', `Bearer ${otherCreatorAccessToken}`);

      // Assert - Should have creator-specific fields
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('headline');
      // bio is optional - may or may not be present
      expect(response.body).toHaveProperty('verified');
      expect(response.body).toHaveProperty('skills');
      expect(response.body).toHaveProperty('languages');
    });

    it('should use UserPrivateDTO for self-view of non-creator', async () => {
      // Act - Admin views own profile
      const response = await request(app)
        .get(`/users/${adminUserId}`)
        .set('Authorization', `Bearer ${adminAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', adminUserId);
      expect(response.body).toHaveProperty('email', 'admin@example.com');
      expect(response.body).toHaveProperty('status', 'active');
      expect(response.body).toHaveProperty('twoFAEnabled', false);
    });
  });
});

