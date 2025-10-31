import { IProject, IProjectRole, IMilestone } from '../models/project.model';
import { UserModel } from '../models/user.model';

/**
 * Full project member details (not just IDs per Task-105)
 */
export interface ProjectMemberDTO {
  userId: string;
  name: string;
  avatar?: string;
  roles: Array<{
    roleId: string;
    title: string;
  }>;
  joinedAt: string; // ISO 8601
}

/**
 * Project role with semantic naming (Task-105)
 */
export interface ProjectRoleDTO {
  roleId: string; // NOT _id!
  title: string;
  description?: string;
  slots: number;
  filled: number;
  assignedUserIds: string[]; // Hidden for non-members
  requiredSkills?: string[];
}

/**
 * Milestone status types for state machine
 */
export type MilestoneStatus = 
  | 'pending' 
  | 'funded' 
  | 'completed' 
  | 'approved' 
  | 'disputed' 
  | 'rejected';

/**
 * Available actions for milestone state machine
 */
export type MilestoneAction = 
  | 'edit' 
  | 'delete' 
  | 'fund' 
  | 'complete' 
  | 'approve' 
  | 'dispute' 
  | 'resolve';

/**
 * Milestone DTO with state machine per Task-105
 */
export interface MilestoneDTO {
  milestoneId: string;
  title: string;
  description?: string;
  dueDate?: string;
  status: MilestoneStatus;
  amount?: number;
  currency?: string;
  availableActions: MilestoneAction[]; // ✅ Explicit state machine!
  createdAt: string;
  updatedAt: string;
}

/**
 * Maps milestones with state machine logic per Task-105 standards
 */
export class MilestoneMapper {
  /**
   * Maps IMilestone to DTO with state machine logic
   * @param milestone - Database milestone
   * @param userRole - User's role (admin, owner, creator)
   * @param isProjectMember - Whether user is project member
   * @param isProjectOwner - Whether user is project owner
   * @returns MilestoneDTO with availableActions
   */
  static toDTO(
    milestone: IMilestone,
    userRole: string,
    isProjectMember: boolean,
    isProjectOwner: boolean
  ): MilestoneDTO {
    return {
      milestoneId: milestone._id!.toString(),
      title: milestone.title,
      description: milestone.description,
      dueDate: milestone.dueDate?.toISOString(),
      status: milestone.status as MilestoneStatus,
      amount: milestone.amount,
      currency: milestone.currency,
      availableActions: this.getAvailableActions(
        milestone.status as MilestoneStatus,
        userRole,
        isProjectMember,
        isProjectOwner
      ),
      createdAt: milestone.createdAt?.toISOString() || new Date().toISOString(),
      updatedAt: milestone.updatedAt?.toISOString() || new Date().toISOString(),
    };
  }

  /**
   * State machine logic - defines valid transitions per Task-105
   */
  private static getAvailableActions(
    status: MilestoneStatus,
    userRole: string,
    isProjectMember: boolean,
    isProjectOwner: boolean
  ): MilestoneAction[] {
    const actions: MilestoneAction[] = [];

    switch (status) {
      case 'pending':
        if (isProjectOwner || userRole === 'admin') {
          actions.push('edit', 'delete', 'fund');
        }
        if (isProjectMember) {
          actions.push('complete');
        }
        break;

      case 'funded':
        if (isProjectMember) {
          actions.push('complete');
        }
        if (isProjectOwner || userRole === 'admin') {
          actions.push('edit'); // Limited edit (no amount/currency)
        }
        break;

      case 'completed':
        if (isProjectOwner || userRole === 'admin') {
          actions.push('approve', 'dispute');
        }
        break;

      case 'disputed':
        if (userRole === 'admin') {
          actions.push('resolve'); // Admin mediation
        }
        break;

      case 'approved':
        // Final state - no further actions
        break;

      case 'rejected':
        if (userRole === 'admin') {
          actions.push('resolve');
        }
        break;
    }

    return actions;
  }
}

/**
 * Maps project members to full DTOs per Task-105 standards
 */
export class ProjectMemberMapper {
  /**
   * Maps teamMemberIds to full member details
   * @param project - Project with teamMemberIds
   * @param includeRoles - Whether to include role details
   * @returns Array of ProjectMemberDTO with full user details
   */
  static async toDTOArray(
    project: IProject,
    includeRoles: boolean = true
  ): Promise<ProjectMemberDTO[]> {
    // Fetch all members in one query for efficiency
    const users = await UserModel.find({
      _id: { $in: project.teamMemberIds }
    }).select('_id preferredName fullName avatar createdAt').lean();

    return users.map(user => ({
      userId: user._id.toString(),
      name: user.preferredName || user.fullName || 'Unknown User',
      avatar: (user as any).avatar, // Avatar field might not be in current user model
      roles: includeRoles ? project.roles
        .filter(r => r.assignedUserIds.some(id => id.toString() === user._id.toString()))
        .map(r => ({
          roleId: r._id!.toString(),
          title: r.title,
        })) : [],
      joinedAt: (user as any).joinedAt?.toISOString() || project.createdAt?.toISOString() || new Date().toISOString(),
    }));
  }

  /**
   * Maps a single project role to DTO with semantic naming
   * @param role - Project role subdocument
   * @param showAssignees - Whether to include assigned user IDs
   * @returns ProjectRoleDTO with semantic naming
   */
  static roleToDTO(role: IProjectRole, showAssignees: boolean = false): ProjectRoleDTO {
    return {
      roleId: role._id!.toString(),
      title: role.title,
      description: role.description,
      slots: role.slots,
      filled: role.assignedUserIds.length,
      assignedUserIds: showAssignees ? role.assignedUserIds.map(id => id.toString()) : [],
      requiredSkills: role.requiredSkills,
    };
  }
}
