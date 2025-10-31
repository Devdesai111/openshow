import { IProject, IProjectRole } from '../models/project.model';
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
