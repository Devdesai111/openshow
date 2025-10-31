import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { CreatorProfileModel } from '../../src/models/creatorProfile.model';

describe('Creator Directory Search & Listing (GET /market/creators)', () => {
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
    await CreatorProfileModel.deleteMany({});

    // Seed three creators with varying attributes
    const seedCreator = async (
      email: string,
      preferredName: string,
      skills: string[],
      verified = false,
      availability: 'open' | 'busy' | 'invite-only' = 'open',
      headline?: string
    ) => {
      const signup = await request(app).post('/auth/signup').send({
        email,
        password: 'Password123',
        role: 'creator',
        fullName: preferredName,
      });
      const userId = signup.body.user.id as string;

      await CreatorProfileModel.findOneAndUpdate(
        { userId },
        {
          userId,
          verified,
          skills,
          availability,
          headline: headline || `${preferredName} headline`,
        },
        { upsert: true, new: true }
      );
    };

    await seedCreator('vfx1@example.com', 'VFX One', ['video-editing', 'vfx'], true, 'open');
    await seedCreator('editor2@example.com', 'Editor Two', ['video-editing'], false, 'busy');
    await seedCreator('prompt3@example.com', 'Prompt Three', ['prompt-engineering'], true, 'invite-only');
  });

  it('T10.1 - should support basic pagination', async () => {
    const res = await request(app).get('/market/creators?page=1&per_page=2');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body).toHaveProperty('pagination');
    expect(res.body.pagination).toMatchObject({ page: 1, per_page: 2 });
  });

  it('T10.2 - should filter by verified=true', async () => {
    const res = await request(app).get('/market/creators?verified=true&per_page=50');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const item of res.body.data) {
      expect(item.verified).toBe(true);
      expect(item).not.toHaveProperty('email');
    }
  });

  it('T10.3 - should filter by skill match', async () => {
    const res = await request(app).get('/market/creators?skill=video-editing&per_page=50');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const item of res.body.data) {
      expect(item.skills).toContain('video-editing');
    }
  });

  it('T10.4 - should return 422 for invalid per_page > 100', async () => {
    const res = await request(app).get('/market/creators?per_page=200');
    expect(res.status).toBe(422);
    expect(res.body.error).toHaveProperty('code', 'validation_error');
  });

  it('T10.5 - should return public DTO (no email or private fields)', async () => {
    const res = await request(app).get('/market/creators');
    expect(res.status).toBe(200);
    for (const item of res.body.data) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('preferredName');
      expect(item).not.toHaveProperty('email');
    }
  });
});


