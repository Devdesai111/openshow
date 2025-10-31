import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/server';
import { UserModel } from '../../src/models/user.model';
import { AuthSessionModel } from '../../src/models/authSession.model';
import { ProjectModel } from '../../src/models/project.model';
import { MessageModel } from '../../src/models/message.model';

describe('Project Chat Messages Integration Tests', () => {
  let ownerAccessToken: string;
  let ownerUserId: string;
  let memberAccessToken: string;
  let memberUserId: string;
  let nonMemberAccessToken: string;
  let projectId: string;

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
    // Clean up database
    await UserModel.deleteMany({});
    await AuthSessionModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await MessageModel.deleteMany({});

    // Create owner user
    const ownerSignup = await request(app).post('/auth/signup').send({
      email: 'owner@example.com',
      password: 'Password123',
      role: 'owner',
      fullName: 'Project Owner',
    });
    ownerAccessToken = ownerSignup.body.accessToken;
    ownerUserId = ownerSignup.body.user.id;

    // Create member user
    const memberSignup = await request(app).post('/auth/signup').send({
      email: 'member@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Project Member',
    });
    memberAccessToken = memberSignup.body.accessToken;
    memberUserId = memberSignup.body.user.id;

    // Create non-member user
    const nonMemberSignup = await request(app).post('/auth/signup').send({
      email: 'nonmember@example.com',
      password: 'Password123',
      role: 'creator',
      fullName: 'Non Member',
    });
    nonMemberAccessToken = nonMemberSignup.body.accessToken;

    // Create project with owner and member as team members
    const projectResponse = await request(app)
      .post('/projects')
      .set('Authorization', `Bearer ${ownerAccessToken}`)
      .send({
        title: 'Test Project',
        category: 'Film Production',
        visibility: 'private',
        collaborationType: 'invite',
        roles: [{ title: 'Director', slots: 2 }],
        revenueModel: { splits: [{ placeholder: 'Director', percentage: 100 }] },
      });
    projectId = projectResponse.body.projectId;

    // Add member to project
    await ProjectModel.findByIdAndUpdate(projectId, {
      $push: { teamMemberIds: new mongoose.Types.ObjectId(memberUserId) },
    });
  });

  describe('POST /projects/:projectId/messages', () => {
    it('T17.1 - should successfully send message (happy path - authenticated member)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          body: 'Hello team! This is a test message.',
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('messageId');
      expect(response.body).toHaveProperty('senderId', ownerUserId);
      expect(response.body).toHaveProperty('body', 'Hello team! This is a test message.');
      expect(response.body).toHaveProperty('createdAt');

      // Verify database record
      const message = await MessageModel.findOne({ messageId: response.body.messageId });
      expect(message).toBeDefined();
      expect(message?.body).toBe('Hello team! This is a test message.');
      expect(message?.senderId.toString()).toBe(ownerUserId);
      expect(message?.deleted).toBe(false);
    });

    it('T17.2 - should fail when non-member tries to send message (403 Forbidden)', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${nonMemberAccessToken}`)
        .send({
          body: 'Unauthorized message',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('project member');
    });

    it('should fail when project does not exist', async () => {
      // Act
      const response = await request(app)
        .post('/projects/507f1f77bcf86cd799439011/messages')
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          body: 'Message to non-existent project',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });

    it('should validate message body length (max 5000 chars)', async () => {
      // Arrange - Create message with > 5000 chars
      const longBody = 'a'.repeat(5001);

      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          body: longBody,
        });

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should validate message body is required', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({});

      // Assert
      expect(response.status).toBe(422);
      expect(response.body.error).toHaveProperty('code', 'validation_error');
    });

    it('should support attachments array', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${memberAccessToken}`)
        .send({
          body: 'Message with attachments',
          attachments: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
        });

      // Assert
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('messageId');

      // Verify attachments in database
      const message = await MessageModel.findOne({ messageId: response.body.messageId });
      expect(message?.attachments).toHaveLength(2);
    });

    it('should require authentication', async () => {
      // Act
      const response = await request(app)
        .post(`/projects/${projectId}/messages`)
        .send({
          body: 'Unauthenticated message',
        });

      // Assert
      expect(response.status).toBe(401);
      expect(response.body.error).toHaveProperty('code', 'no_token');
    });
  });

  describe('GET /projects/:projectId/messages', () => {
    beforeEach(async () => {
      // Create some test messages
      const messages = [
        { projectId: new mongoose.Types.ObjectId(projectId), senderId: new mongoose.Types.ObjectId(ownerUserId), body: 'First message', createdAt: new Date(Date.now() - 3000) },
        { projectId: new mongoose.Types.ObjectId(projectId), senderId: new mongoose.Types.ObjectId(memberUserId), body: 'Second message', createdAt: new Date(Date.now() - 2000) },
        { projectId: new mongoose.Types.ObjectId(projectId), senderId: new mongoose.Types.ObjectId(ownerUserId), body: 'Third message', createdAt: new Date(Date.now() - 1000) },
      ];
      await MessageModel.insertMany(messages);
    });

    it('T17.3 - should retrieve messages in descending order (newest first)', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${memberAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);

      // Verify newest first (descending order)
      const messages = response.body.data;
      for (let i = 0; i < messages.length - 1; i++) {
        const current = new Date(messages[i].createdAt);
        const next = new Date(messages[i + 1].createdAt);
        expect(current.getTime()).toBeGreaterThanOrEqual(next.getTime());
      }
    });

    it('should support cursor pagination with before parameter', async () => {
      // Act - Get first page
      const firstResponse = await request(app)
        .get(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${memberAccessToken}`)
        .query({ limit: 2 });

      // Assert
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body.data).toHaveLength(2);

      const firstMessageId = firstResponse.body.data[0].messageId;

      // Act - Get next page using before cursor
      const secondResponse = await request(app)
        .get(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${memberAccessToken}`)
        .query({ limit: 2, before: firstMessageId });

      // Assert
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body.data.length).toBeLessThanOrEqual(2);

      // Verify no overlap
      const secondMessageIds = secondResponse.body.data.map((m: any) => m.messageId);
      expect(secondMessageIds).not.toContain(firstMessageId);
    });

    it('should respect limit parameter', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${memberAccessToken}`)
        .query({ limit: 1 });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta).toHaveProperty('limit', 1);
      expect(response.body.meta).toHaveProperty('returned', 1);
    });

    it('should fail when non-member tries to retrieve messages (403 Forbidden)', async () => {
      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${nonMemberAccessToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
    });

    it('should exclude soft-deleted messages', async () => {
      // Arrange - Create a message and soft-delete it
      const message = await MessageModel.create({
        projectId: new mongoose.Types.ObjectId(projectId),
        senderId: new mongoose.Types.ObjectId(ownerUserId),
        body: 'Deleted message',
        deleted: true,
      });

      // Act
      const response = await request(app)
        .get(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${memberAccessToken}`);

      // Assert
      expect(response.status).toBe(200);
      const messageIds = response.body.data.map((m: any) => m.messageId);
      expect(messageIds).not.toContain(message.messageId);
    });
  });

  describe('PUT /projects/:projectId/messages/:messageId', () => {
    let messageId: string;

    beforeEach(async () => {
      // Create a test message
      const message = await MessageModel.create({
        projectId: new mongoose.Types.ObjectId(projectId),
        senderId: new mongoose.Types.ObjectId(ownerUserId),
        body: 'Original message',
      });
      messageId = message.messageId;
    });

    it('T17.4 - should successfully edit message (sender)', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${projectId}/messages/${messageId}`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          body: 'Updated message body',
        });

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('messageId', messageId);
      expect(response.body).toHaveProperty('body', 'Updated message body');
      expect(response.body).toHaveProperty('editedAt');

      // Verify database record
      const message = await MessageModel.findOne({ messageId });
      expect(message?.body).toBe('Updated message body');
      expect(message?.editedAt).toBeDefined();
    });

    it('T17.5 - should fail when non-sender tries to edit (403 Forbidden)', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${projectId}/messages/${messageId}`)
        .set('Authorization', `Bearer ${memberAccessToken}`)
        .send({
          body: 'Unauthorized edit attempt',
        });

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('edit your own');

      // Verify message was not changed
      const message = await MessageModel.findOne({ messageId });
      expect(message?.body).toBe('Original message');
    });


    it('should fail when message does not exist', async () => {
      // Act
      const response = await request(app)
        .put(`/projects/${projectId}/messages/nonexistent_msg`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({
          body: 'Edit attempt',
        });

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });
  });

  describe('DELETE /projects/:projectId/messages/:messageId', () => {
    let messageId: string;

    beforeEach(async () => {
      // Create a test message
      const message = await MessageModel.create({
        projectId: new mongoose.Types.ObjectId(projectId),
        senderId: new mongoose.Types.ObjectId(ownerUserId),
        body: 'Message to delete',
      });
      messageId = message.messageId;
    });

    it('T17.6 - should successfully soft-delete message (sender)', async () => {
      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}/messages/${messageId}`)
        .set('Authorization', `Bearer ${ownerAccessToken}`);

      // Assert
      expect(response.status).toBe(204);

      // Verify soft delete in database
      const message = await MessageModel.findOne({ messageId });
      expect(message?.deleted).toBe(true);
      expect(message?.body).toBe('[Message Deleted]');
    });

    it('should fail when non-sender tries to delete (403 Forbidden)', async () => {
      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}/messages/${messageId}`)
        .set('Authorization', `Bearer ${memberAccessToken}`);

      // Assert
      expect(response.status).toBe(403);
      expect(response.body.error).toHaveProperty('code', 'permission_denied');
      expect(response.body.error.message).toContain('delete your own');

      // Verify message was not deleted
      const message = await MessageModel.findOne({ messageId });
      expect(message?.deleted).toBe(false);
    });


    it('should fail when message does not exist', async () => {
      // Act
      const response = await request(app)
        .delete(`/projects/${projectId}/messages/nonexistent_msg`)
        .set('Authorization', `Bearer ${ownerAccessToken}`);

      // Assert
      expect(response.status).toBe(404);
      expect(response.body.error).toHaveProperty('code', 'not_found');
    });
  });

  describe('Security & Access Control', () => {
    it('should require authentication for all endpoints', async () => {
      // Test POST endpoint
      const postResponse = await request(app)
        .post(`/projects/${projectId}/messages`)
        .send({ body: 'test' });
      expect(postResponse.status).toBe(401);

      // Test GET endpoint
      const getResponse = await request(app)
        .get(`/projects/${projectId}/messages`);
      expect(getResponse.status).toBe(401);
    });

    it('should enforce member-only access for all message operations', async () => {
      // Create a message as owner
      const createResponse = await request(app)
        .post(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${ownerAccessToken}`)
        .send({ body: 'Test message' });
      const messageId = createResponse.body.messageId;

      // Non-member should not be able to read, update, or delete
      const getResponse = await request(app)
        .get(`/projects/${projectId}/messages`)
        .set('Authorization', `Bearer ${nonMemberAccessToken}`);
      expect(getResponse.status).toBe(403);

      const putResponse = await request(app)
        .put(`/projects/${projectId}/messages/${messageId}`)
        .set('Authorization', `Bearer ${nonMemberAccessToken}`)
        .send({ body: 'Updated' });
      expect(putResponse.status).toBe(403);

      const deleteResponse = await request(app)
        .delete(`/projects/${projectId}/messages/${messageId}`)
        .set('Authorization', `Bearer ${nonMemberAccessToken}`);
      expect(deleteResponse.status).toBe(403);
    });
  });
});
