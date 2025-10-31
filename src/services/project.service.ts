import { Types } from 'mongoose';
import { ProjectModel, IProject, IRevenueSplit } from '../models/project.model';
import { ProjectInviteModel, ProjectApplicationModel, IProjectInvite, IProjectApplication } from '../models/projectApplication.model';
import { UserModel } from '../models/user.model';

interface ICreateProjectRequestDTO {
  title: string;
  description?: string;
  category: string;
  visibility?: IProject['visibility'];
  collaborationType?: IProject['collaborationType'];
  roles: { title: string; slots: number; description?: string; requiredSkills?: string[] }[];
  revenueModel: { splits: Omit<IRevenueSplit, '_id'>[] };
  milestones?: { title: string; description?: string; dueDate?: string; amount?: number; currency?: string }[];
}

// Mock notification integration for Task 13
class MockNotificationService {
  public async sendInvite(projectId: string, userId: string, roleTitle: string): Promise<void> {
    console.warn(`[Notification Mock] Sent Project ${projectId} invite to User ${userId} for role ${roleTitle}`);
  }
  
  public async notifyOwnerOfApplication(projectId: string, applicantId: string): Promise<void> {
    console.warn(`[Notification Mock] Notified Owner of Project ${projectId} about application from User ${applicantId}`);
  }
}

const mockNotificationService = new MockNotificationService();

// Mock Event Emitter for Publishing Indexing Events (Task 16)
class MockEventEmitter {
  public emit(event: string, payload: any): void {
    console.warn(`[EVENT EMITTED] ${event}:`, JSON.stringify(payload));
    // PRODUCTION: This payload would be sent to a Message Broker (Kafka/RabbitMQ)
  }
}
const eventEmitter = new MockEventEmitter();

export class ProjectService {
  /**
   * Creates a new project from the 6-step wizard payload.
   * @param ownerId - The ID of the authenticated user creating the project.
   * @param data - The full project payload.
   * @returns The created project DTO.
   * @throws {Error} - 'RevenueSplitInvalid' (caught from Mongoose hook).
   */
  public async createProject(ownerId: string, data: ICreateProjectRequestDTO): Promise<IProject> {
    const ownerObjectId = new Types.ObjectId(ownerId);

    // 1. Map incoming DTO to Mongoose structure
    const newProject = new ProjectModel({
      ownerId: ownerObjectId,
      title: data.title,
      description: data.description,
      category: data.category,
      visibility: data.visibility || 'private',
      collaborationType: data.collaborationType || 'invite',
      status: 'draft',

      // Map roles, adding owner to the first role slot if defined (or creating a default owner role)
      roles: data.roles.map(role => ({
        ...role,
        _id: new Types.ObjectId(), // Manual ID for sub-doc reference
        assignedUserIds: [], // Empty initially
      })),

      // Map revenue splits
      revenueSplits: data.revenueModel.splits.map(split => ({
        ...split,
        _id: new Types.ObjectId(),
      })),

      // Map milestones if provided
      milestones: (data.milestones || []).map(milestone => ({
        ...milestone,
        _id: new Types.ObjectId(),
        dueDate: milestone.dueDate ? new Date(milestone.dueDate) : undefined,
      })),

      // Initialize team with owner
      teamMemberIds: [ownerObjectId],
    });

    // 2. Save (Mongoose 'pre' hook validates revenue splits)
    const savedProject = await newProject.save();

    // 3. Handle Initial Assignment (Assign owner to a default/first role if logic requires)
    if (savedProject.roles.length > 0) {
      const firstRole = savedProject.roles[0];
      if (firstRole && firstRole.assignedUserIds.length === 0 && firstRole.slots > 0) {
        await ProjectModel.updateOne(
          { _id: savedProject._id, 'roles._id': firstRole._id },
          { $push: { 'roles.$.assignedUserIds': ownerObjectId } }
        );
      }
    }

    // 4. Trigger Events for Indexing (Task 16)
    eventEmitter.emit('project.created', {
      projectId: savedProject._id!.toString(),
      ownerId: ownerId,
      visibility: savedProject.visibility,
      title: savedProject.title,
    });

    return savedProject.toObject() as IProject;
  }

  /**
   * Validates that revenue splits sum to 100% if percentages are provided.
   * @param splits - Array of revenue splits
   * @throws {Error} - If splits don't sum to 100%
   */
  public validateRevenueSplits(splits: IRevenueSplit[]): void {
    const percentageSplits = splits.filter(split => split.percentage !== undefined && split.percentage !== null);

    if (percentageSplits.length > 0) {
      const totalPercentage = percentageSplits.reduce((sum, split) => sum + (split.percentage || 0), 0);
      if (Math.abs(totalPercentage - 100) > 0.01) {
        throw new Error('Revenue splits must sum to 100%.');
      }
    }
  }

  /**
   * Checks if the requester is the project owner or admin.
   * @param projectId - Project ID to check
   * @param requesterId - User ID making the request
   * @param requesterRole - User role for admin check
   * @throws {Error} 'PermissionDenied' | 'ProjectNotFound'
   * @returns Project document if authorized
   */
  private async checkOwnerAccess(projectId: string, requesterId: string, requesterRole?: string): Promise<IProject> {
    const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
    if (!project) {
      throw new Error('ProjectNotFound');
    }
    
    // Allow access if user is project owner or admin
    if (project.ownerId.toString() !== requesterId && requesterRole !== 'admin') {
      throw new Error('PermissionDenied');
    }
    
    return project;
  }

  /**
   * Invites a user to a specific role.
   * @param projectId - Project ID
   * @param requesterId - User ID of inviter (must be owner)
   * @param targetUserId - User ID to invite
   * @param roleId - Role ID to invite for
   * @param message - Optional invitation message
   * @throws {Error} - 'ProjectNotFound', 'PermissionDenied', 'RoleNotFound', 'RoleFull', 'UserNotFound'
   * @returns Created invite record
   */
  public async inviteUser(
    projectId: string,
    requesterId: string,
    targetUserId: string,
    roleId: string,
    message?: string,
    requesterRole?: string
  ): Promise<IProjectInvite> {
    const project = await this.checkOwnerAccess(projectId, requesterId, requesterRole);
    const roleObjectId = new Types.ObjectId(roleId);
    const targetObjectId = new Types.ObjectId(targetUserId);

    // 1. Validate role exists and has capacity
    const role = project.roles.find(r => r._id?.equals(roleObjectId));
    if (!role) {
      throw new Error('RoleNotFound');
    }
    if (role.assignedUserIds.length >= role.slots) {
      throw new Error('RoleFull');
    }

    // 2. Verify target user exists
    const targetUser = await UserModel.findById(targetObjectId);
    if (!targetUser) {
      throw new Error('UserNotFound');
    }

    // 3. Create Invite Record
    const newInvite = new ProjectInviteModel({
      projectId: project._id,
      roleId: roleObjectId,
      invitedBy: new Types.ObjectId(requesterId),
      invitedUserId: targetObjectId,
      message,
    });
    const savedInvite = await newInvite.save();

    // 4. Trigger Notifications (Mocked for Task 13)
    await mockNotificationService.sendInvite(projectId, targetUserId, role.title);

    // PRODUCTION: Emit 'project.invite.sent' event
    console.warn(`[Event] Project ${projectId} invite sent to User ${targetUserId} for role ${role.title}`);

    return savedInvite.toObject();
  }

  /**
   * User applies for a role in an Open project.
   * @param projectId - Project ID
   * @param applicantId - User ID applying
   * @param roleId - Role ID to apply for
   * @param message - Optional application message
   * @param proposedRate - Optional proposed hourly rate in cents
   * @throws {Error} - 'ProjectNotFound', 'ProjectNotOpen', 'RoleNotFound', 'UserNotFound'
   * @returns Created application record
   */
  public async applyForRole(
    projectId: string,
    applicantId: string,
    roleId: string,
    message?: string,
    proposedRate?: number
  ): Promise<IProjectApplication> {
    const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
    const roleObjectId = new Types.ObjectId(roleId);
    const applicantObjectId = new Types.ObjectId(applicantId);

    if (!project) {
      throw new Error('ProjectNotFound');
    }
    if (project.collaborationType !== 'open') {
      throw new Error('ProjectNotOpen');
    }

    // 1. Validate role exists
    const role = project.roles.find(r => r._id?.equals(roleObjectId));
    if (!role) {
      throw new Error('RoleNotFound');
    }

    // 2. Verify applicant exists
    const applicant = await UserModel.findById(applicantObjectId);
    if (!applicant) {
      throw new Error('UserNotFound');
    }

    // 3. Create Application Record (unique index prevents duplicates)
    const newApplication = new ProjectApplicationModel({
      projectId: project._id,
      roleId: roleObjectId,
      applicantId: applicantObjectId,
      message,
      proposedRate,
    });
    const savedApplication = await newApplication.save();

    // 4. Trigger Notifications (Mocked for Task 13)
    await mockNotificationService.notifyOwnerOfApplication(projectId, applicantId);

    // PRODUCTION: Emit 'project.application.submitted' event
    console.warn(`[Event] User ${applicantId} applied for role ${role.title} in Project ${projectId}`);

    return savedApplication.toObject();
  }

  /**
   * Assigns a user to a specific role, consuming a slot.
   * @param projectId - Project ID
   * @param requesterId - User ID of assigner (must be owner)
   * @param targetUserId - User ID to assign
   * @param roleId - Role ID to assign to
   * @throws {Error} - 'ProjectNotFound', 'PermissionDenied', 'RoleNotFound', 'RoleFull', 'AlreadyAssigned', 'UserNotFound'
   * @returns Updated project
   */
  public async assignRole(
    projectId: string,
    requesterId: string,
    targetUserId: string,
    roleId: string,
    requesterRole?: string
  ): Promise<IProject> {
    const project = await this.checkOwnerAccess(projectId, requesterId, requesterRole);
    const roleObjectId = new Types.ObjectId(roleId);
    const targetObjectId = new Types.ObjectId(targetUserId);

    // 1. Validate role exists
    const role = project.roles.find(r => r._id?.equals(roleObjectId));
    if (!role) {
      throw new Error('RoleNotFound');
    }

    // 2. Capacity and conflict checks
    if (role.assignedUserIds.length >= role.slots) {
      throw new Error('RoleFull');
    }
    if (role.assignedUserIds.some(id => id.equals(targetObjectId))) {
      throw new Error('AlreadyAssigned');
    }

    // 3. Verify target user exists
    const targetUser = await UserModel.findById(targetObjectId);
    if (!targetUser) {
      throw new Error('UserNotFound');
    }

    // 4. Perform Atomic Update: Push to embedded role array and denormalized teamMemberIds
    const updatedProject = await ProjectModel.findOneAndUpdate(
      { _id: project._id, 'roles._id': roleObjectId },
      {
        $push: {
          'roles.$.assignedUserIds': targetObjectId
        },
        $addToSet: {
          // Add to denormalized list only if not already present
          teamMemberIds: targetObjectId,
        }
      },
      { new: true }
    );

    if (!updatedProject) {
      throw new Error('ProjectNotFound'); // Should not happen
    }

    // PRODUCTION: Emit 'project.role.assigned' event (Tasks 16, 17 subscribe)
    console.warn(`[Event] User ${targetUserId} assigned to role ${role.title} in Project ${projectId}`);

    return updatedProject.toObject() as IProject;
  }

  // --- Milestone CRUD ---

  /**
   * Finds and returns a specific milestone from the project document.
   * @param project - Project document
   * @param milestoneId - Milestone ID to find
   * @throws {Error} 'MilestoneNotFound'
   * @returns Milestone subdocument
   */
  private getMilestone(project: IProject, milestoneId: string): any {
    const milestoneObjectId = new Types.ObjectId(milestoneId);
    const milestone = project.milestones.find(m => m._id?.equals(milestoneObjectId));
    if (!milestone) {
      throw new Error('MilestoneNotFound');
    }
    return milestone;
  }

  /**
   * Checks if user is a project member.
   * @param project - Project document
   * @param userId - User ID to check
   * @returns True if user is a team member
   */
  private isProjectMember(project: IProject, userId: string): boolean {
    return project.teamMemberIds.some(id => id.toString() === userId);
  }

  /**
   * Adds a new milestone to a project.
   * @param projectId - Project ID
   * @param requesterId - User ID creating milestone (must be owner)
   * @param data - Milestone data
   * @throws {Error} - 'ProjectNotFound', 'PermissionDenied'
   * @returns Created milestone
   */
  public async addMilestone(
    projectId: string,
    requesterId: string,
    data: {
      title: string;
      description?: string;
      amount: number;
      currency?: string;
      dueDate?: string;
    },
    requesterRole?: string
  ): Promise<any> {
    const project = await this.checkOwnerAccess(projectId, requesterId, requesterRole);

    // 1. Create sub-document
    const newMilestone = {
      _id: new Types.ObjectId(),
      title: data.title,
      description: data.description,
      amount: data.amount,
      currency: data.currency || 'USD',
      dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
      status: 'pending',
      escrowId: undefined, // Will be set in Task 35
    };

    // 2. Push to embedded array
    await ProjectModel.updateOne(
      { _id: project._id },
      { $push: { milestones: newMilestone } }
    );

    // PRODUCTION: Emit 'project.milestone.created' event (Task 16, 17, 11 subscribe)
    console.warn(`[Event] Project ${projectId} milestone ${newMilestone._id.toString()} created`);

    return newMilestone;
  }

  /**
   * Updates an existing milestone.
   * @param projectId - Project ID
   * @param requesterId - User ID updating milestone (must be owner)
   * @param milestoneId - Milestone ID to update
   * @param data - Updated milestone data
   * @throws {Error} - 'ProjectNotFound', 'PermissionDenied', 'MilestoneNotFound', 'MilestoneFundedConflict'
   * @returns Updated milestone
   */
  public async updateMilestone(
    projectId: string,
    requesterId: string,
    milestoneId: string,
    data: {
      title?: string;
      description?: string;
      amount?: number;
      currency?: string;
      dueDate?: string;
    },
    requesterRole?: string
  ): Promise<any> {
    const project = await this.checkOwnerAccess(projectId, requesterId, requesterRole);
    const milestone = this.getMilestone(project, milestoneId);
    const milestoneObjectId = new Types.ObjectId(milestoneId);

    // SECURITY CHECK: Prevent financial changes if funds are already locked/released
    if (milestone.status === 'funded' && (data.amount !== undefined || data.currency !== undefined)) {
      throw new Error('MilestoneFundedConflict');
    }

    // 1. Build dynamic update set for sub-document positional update
    const setUpdate: Record<string, any> = {};
    if (data.title !== undefined) setUpdate['milestones.$.title'] = data.title;
    if (data.description !== undefined) setUpdate['milestones.$.description'] = data.description;
    if (data.amount !== undefined) setUpdate['milestones.$.amount'] = data.amount;
    if (data.currency !== undefined) setUpdate['milestones.$.currency'] = data.currency;
    if (data.dueDate !== undefined) setUpdate['milestones.$.dueDate'] = new Date(data.dueDate);

    // 2. Perform Positional Update
    const updatedProject = await ProjectModel.findOneAndUpdate(
      { _id: project._id, 'milestones._id': milestoneObjectId },
      { $set: setUpdate },
      { new: true }
    );

    if (!updatedProject) {
      throw new Error('UpdateFailed');
    }

    // 3. Return the specific updated milestone
    return this.getMilestone(updatedProject, milestoneId);
  }

  /**
   * Deletes an existing milestone.
   * @param projectId - Project ID
   * @param requesterId - User ID deleting milestone (must be owner)
   * @param milestoneId - Milestone ID to delete
   * @throws {Error} - 'ProjectNotFound', 'PermissionDenied', 'MilestoneNotFound', 'MilestoneFundedConflict'
   */
  public async deleteMilestone(
    projectId: string,
    requesterId: string,
    milestoneId: string,
    requesterRole?: string
  ): Promise<void> {
    const project = await this.checkOwnerAccess(projectId, requesterId, requesterRole);
    const milestone = this.getMilestone(project, milestoneId);
    const milestoneObjectId = new Types.ObjectId(milestoneId);

    // SECURITY CHECK: Cannot delete if funds are locked/released (Task 35 integration required)
    if (milestone.escrowId) {
      throw new Error('MilestoneFundedConflict');
    }

    // 1. Perform atomic pull operation
    const result = await ProjectModel.updateOne(
      { _id: project._id },
      { $pull: { milestones: { _id: milestoneObjectId } } }
    );

    if (result.modifiedCount === 0) {
      throw new Error('MilestoneNotFound');
    }

    // PRODUCTION: Emit 'project.milestone.deleted' event
    console.warn(`[Event] Project ${projectId} milestone ${milestoneId} deleted`);
  }

  /**
   * Marks a milestone as completed by a project member/owner.
   * @param projectId - Project ID
   * @param milestoneId - Milestone ID to complete
   * @param completerId - User ID marking as complete
   * @param notes - Optional completion notes
   * @param evidenceAssetIds - Optional evidence asset IDs
   * @throws {Error} - 'ProjectNotFound', 'PermissionDenied', 'MilestoneNotFound', 'MilestoneAlreadyProcessed'
   * @returns Updated milestone
   */
  public async completeMilestone(
    projectId: string,
    milestoneId: string,
    completerId: string,
    notes?: string,
    evidenceAssetIds?: string[]
  ): Promise<any> {
    const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
    if (!project) {
      throw new Error('ProjectNotFound');
    }

    // 1. Check Project Membership
    if (!this.isProjectMember(project, completerId)) {
      throw new Error('PermissionDenied');
    }

    const milestone = this.getMilestone(project, milestoneId);
    const milestoneObjectId = new Types.ObjectId(milestoneId);

    // 2. State Check: Only transition from 'pending' or 'funded'
    if (milestone.status === 'completed' || milestone.status === 'approved') {
      throw new Error('MilestoneAlreadyProcessed');
    }

    // 3. Perform atomic status update
    const updatedProject = await ProjectModel.findOneAndUpdate(
      { _id: project._id, 'milestones._id': milestoneObjectId },
      {
        $set: {
          'milestones.$.status': 'completed',
          // PRODUCTION: Store completion metadata in separate log/sub-document if needed
          // For now, we acknowledge the parameters to avoid lint warnings
          ...(notes && { 'milestones.$.completionNotes': notes }),
          ...(evidenceAssetIds && { 'milestones.$.evidenceAssetIds': evidenceAssetIds }),
        }
      },
      { new: true }
    );

    if (!updatedProject) {
      throw new Error('UpdateFailed');
    }

    // PRODUCTION: Emit 'project.milestone.completed' event (Task 17, 11 subscribe)
    console.warn(`[Event] Milestone ${milestoneId} marked completed by ${completerId}`);

    return this.getMilestone(updatedProject, milestoneId);
  }

  // --- Read/Listing ---

  /**
   * Lists projects based on filters and requester role/membership.
   * @param requesterId - Optional authenticated user ID
   * @param queryParams - Filter and pagination parameters
   * @returns Paginated list of projects with visibility filtering
   */
  public async listProjects(
    requesterId?: string,
    queryParams: {
      status?: string;
      ownerId?: string;
      page?: number | string;
      per_page?: number | string;
    } = {}
  ): Promise<{
    data: any[];
    pagination: {
      page: number;
      per_page: number;
      total_items: number;
      total_pages: number;
      has_next: boolean;
      has_prev: boolean;
    };
  }> {
    const { status, ownerId, page = 1, per_page = 20 } = queryParams;
    const filters: Record<string, any> = {};

    // 1. Visibility Filters (Core RBAC for listings)
    if (requesterId) {
      // Authenticated users see public projects AND projects they are members of
      filters.$or = [
        { visibility: 'public' },
        { ownerId: new Types.ObjectId(requesterId) },
        { teamMemberIds: new Types.ObjectId(requesterId) }
      ];
    } else {
      // Anonymous users only see public projects
      filters.visibility = 'public';
    }

    // 2. Additional Filters
    if (status) filters.status = status;
    if (ownerId) filters.ownerId = new Types.ObjectId(ownerId);

    // 3. Pagination and Execution
    const limit = Math.min(Number(per_page) || 20, 100);
    const pageNum = Number(page) || 1;
    const skip = (pageNum - 1) * limit;

    const [totalResults, projects] = await Promise.all([
      ProjectModel.countDocuments(filters),
      ProjectModel.find(filters)
        .select('-milestones -revenueSplits') // Select minimal fields for list view
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // 4. Map to List DTO (Redacted/Summarized)
    const data = (projects as IProject[]).map(project => ({
      projectId: project._id!.toString(),
      title: project.title,
      description: project.description,
      category: project.category,
      ownerId: project.ownerId.toString(),
      status: project.status,
      visibility: project.visibility,
      collaborationType: project.collaborationType,
      rolesSummary: project.roles.map(r => ({
        title: r.title,
        slots: r.slots,
        filled: r.assignedUserIds.length
      })),
      teamMemberCount: project.teamMemberIds.length,
      createdAt: project.createdAt!.toISOString(),
      updatedAt: project.updatedAt!.toISOString(),
    }));

    const totalPages = Math.ceil(totalResults / limit) || 1;

    return {
      data,
      pagination: {
        page: pageNum,
        per_page: limit,
        total_items: totalResults,
        total_pages: totalPages,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
    };
  }

  /**
   * Retrieves detailed information for a single project, applying visibility rules.
   * @param projectId - Project ID to retrieve
   * @param requesterId - Optional authenticated user ID
   * @param requesterRole - Optional user role
   * @throws {Error} - 'ProjectNotFound', 'PermissionDenied'
   * @returns Project details with appropriate redaction
   */
  public async getProjectDetails(
    projectId: string,
    requesterId?: string,
    requesterRole?: string
  ): Promise<any> {
    const project = await ProjectModel.findById(new Types.ObjectId(projectId)).lean() as IProject;
    if (!project) {
      throw new Error('ProjectNotFound');
    }

    const isMember = requesterId ? project.teamMemberIds.some(id => id.toString() === requesterId) : false;
    const isPublic = project.visibility === 'public';

    // 1. Authorization Check (403/404 for private projects if not member/admin)
    if (!isMember && !isPublic && requesterRole !== 'admin') {
      // For security, return 404 to avoid revealing project existence
      throw new Error('PermissionDenied');
    }

    // 2. Redaction: Revenue Splits (Hiding user IDs for non-members)
    const redactedSplits = project.revenueSplits.map(split => {
      if (isMember || requesterRole === 'admin') {
        return {
          splitId: split._id?.toString(),
          userId: split.userId?.toString(),
          placeholder: split.placeholder,
          percentage: split.percentage,
          fixedAmount: split.fixedAmount,
        }; // Full DTO for members
      }
      // Public/Non-member view: hide userId, show placeholder/percentage
      return {
        splitId: split._id?.toString(),
        placeholder: split.placeholder || 'Contributor',
        percentage: split.percentage,
      };
    });

    // 3. Build DTO (Full/Redacted)
    const detailDTO = {
      projectId: project._id!.toString(),
      ownerId: project.ownerId.toString(),
      title: project.title,
      description: project.description,
      category: project.category,
      visibility: project.visibility,
      collaborationType: project.collaborationType,
      status: project.status,
      coverAssetId: project.coverAssetId?.toString(),
      roles: project.roles.map(r => ({
        roleId: r._id!.toString(),
        title: r.title,
        description: r.description,
        slots: r.slots,
        filled: r.assignedUserIds.length,
        assignedUserIds: isMember || requesterRole === 'admin' ? r.assignedUserIds.map(id => id.toString()) : [], // Hide member IDs if non-member
        requiredSkills: r.requiredSkills,
      })),
      milestones: project.milestones.map(m => ({
        milestoneId: m._id!.toString(),
        title: m.title,
        description: m.description,
        amount: m.amount,
        currency: m.currency,
        status: m.status,
        dueDate: m.dueDate?.toISOString(),
        createdAt: m.createdAt?.toISOString(),
        updatedAt: m.updatedAt?.toISOString(),
      })),
      revenueSplits: redactedSplits,
      teamMemberIds: isMember || requesterRole === 'admin' ? project.teamMemberIds.map(id => id.toString()) : [],
      teamMemberCount: project.teamMemberIds.length,
      createdAt: project.createdAt!.toISOString(),
      updatedAt: project.updatedAt!.toISOString(),
    };

    return detailDTO;
  }

  /**
   * Updates the main project document.
   * @param projectId - Project ID to update
   * @param requesterId - User ID updating (must be owner)
   * @param updateData - Fields to update
   * @param requesterRole - User role for admin check
   * @throws {Error} - 'PermissionDenied', 'ProjectNotFound'
   * @returns Updated project details
   */
  public async updateProject(
    projectId: string,
    requesterId: string,
    updateData: {
      title?: string;
      description?: string;
      visibility?: 'public' | 'private';
      status?: string;
      category?: string;
    },
    requesterRole?: string
  ): Promise<any> {
    // 1. Owner Access Check (handles ProjectNotFound and PermissionDenied)
    const project = await this.checkOwnerAccess(projectId, requesterId, requesterRole);

    // 2. Build Update Object (Filter allowed fields)
    const update: Record<string, any> = {};
    if (updateData.title !== undefined) update.title = updateData.title;
    if (updateData.description !== undefined) update.description = updateData.description;
    if (updateData.visibility !== undefined) update.visibility = updateData.visibility;
    if (updateData.status !== undefined) update.status = updateData.status;
    if (updateData.category !== undefined) update.category = updateData.category;

    // NOTE: Updating roles embedded array requires special handling
    // For simplicity in this task, roles array updates are deferred to future tasks

    // 3. Execute Update
    const updatedProject = await ProjectModel.findOneAndUpdate(
      { _id: project._id },
      { $set: update },
      { new: true }
    );

    if (!updatedProject) {
      throw new Error('UpdateFailed');
    }

    // 4. Trigger Events for Indexing (Updated/Visibility Change) (Task 16)
    eventEmitter.emit('project.updated', {
      projectId: updatedProject._id!.toString(),
      changes: Object.keys(update),
      visibility: updatedProject.visibility,
      status: updatedProject.status,
      ownerId: updatedProject.ownerId.toString(),
    });

    // 5. Return updated DTO (use the detailed getter)
    return this.getProjectDetails(projectId, requesterId, requesterRole);
  }

  /**
   * Archives a project (sets status to 'archived' and visibility to 'private').
   * @param projectId - Project ID to archive
   * @param requesterId - User ID archiving (must be owner)
   * @param requesterRole - User role for admin check
   * @throws {Error} - 'PermissionDenied', 'ProjectNotFound'
   */
  public async archiveProject(
    projectId: string,
    requesterId: string,
    requesterRole?: string
  ): Promise<void> {
    // 1. Owner Access Check
    await this.checkOwnerAccess(projectId, requesterId, requesterRole);

    // 2. Archive Project
    const result = await ProjectModel.updateOne(
      { _id: new Types.ObjectId(projectId) },
      { $set: { status: 'archived', visibility: 'private' } }
    );

    if (result.modifiedCount === 0) {
      throw new Error('ProjectNotFound');
    }

    // 3. Emit archive event for index removal (Task 16)
    eventEmitter.emit('project.archived', { projectId });

    // PRODUCTION: Check for and handle pending escrows (Task 35)
    console.warn(`[Event] Project ${projectId} archived.`);
  }
}
