import { Types } from 'mongoose';
import { ProjectModel, IProject, IRevenueSplit } from '../models/project.model';

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

    // 4. Trigger Events
    // PRODUCTION: Emit 'project.created' event (Task 16 subscribes for indexing)
    console.warn(`[Event] Project ${savedProject._id?.toString()} created by ${ownerId}.`);

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
}
