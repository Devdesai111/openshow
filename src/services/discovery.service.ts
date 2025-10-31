import { FilterQuery } from 'mongoose';
import { CreatorProfileModel, ICreatorProfile } from '../models/creatorProfile.model';
import { IUser } from '../models/user.model';
import { PaginatedResponse, PaginationMeta } from '../types/pagination-dtos';
import { ProjectModel, IProject } from '../models/project.model';

export interface CreatorListItemDTO {
  id: string;
  userId: string;
  preferredName?: string;
  headline?: string;
  skills: string[];
  verified: boolean;
  rating?: ICreatorProfile['rating'];
  availability?: ICreatorProfile['availability'];
}

export class DiscoveryService {
  public async searchCreators(queryParams: Record<string, unknown>): Promise<PaginatedResponse<CreatorListItemDTO>> {
    const {
      q,
      skill,
      verified,
      availability,
      sort = 'rating',
      page = 1,
      per_page = 20,
    } = queryParams as {
      q?: string;
      skill?: string;
      verified?: string | boolean;
      availability?: string;
      sort?: string;
      page?: number | string;
      per_page?: number | string;
    };

    const limit = Number(per_page) || 20;
    const pageNum = Number(page) || 1;
    const skip = (pageNum - 1) * limit;

    const filters: FilterQuery<ICreatorProfile> = {};
    if (skill) filters.skills = { $in: [skill] } as any;
    if (verified !== undefined) filters.verified = String(verified) === 'true';
    if (availability) filters.availability = availability as any;

    // Basic text-like search on headline or skills (simulation)
    if (q) {
      filters.$or = [
        { headline: { $regex: q, $options: 'i' } },
        { skills: { $elemMatch: { $regex: q, $options: 'i' } } },
      ];
    }

    const sortOrder: Record<string, 1 | -1> = {};
    if (sort === 'rating') sortOrder['rating.average'] = -1;
    else if (sort === 'newest') sortOrder['createdAt'] = -1;

    const [totalItems, profiles] = await Promise.all([
      CreatorProfileModel.countDocuments(filters),
      CreatorProfileModel.find(filters)
        .sort(sortOrder)
        .skip(skip)
        .limit(limit)
        .populate({ path: 'userId', select: 'preferredName fullName role' })
        .lean(),
    ]);

    const data: CreatorListItemDTO[] = (profiles as any[]).map((profile) => {
      const user = profile.userId as IUser;
      return {
        id: String(profile._id),
        userId: String((user as any)._id),
        preferredName: user.preferredName || user.fullName,
        headline: profile.headline,
        skills: profile.skills || [],
        verified: !!profile.verified,
        rating: profile.rating,
        availability: profile.availability,
      };
    });

    const pagination: PaginationMeta = {
      page: pageNum,
      per_page: limit,
      total_items: totalItems,
      total_pages: Math.ceil(totalItems / limit) || 1,
      has_next: pageNum * limit < totalItems,
      has_prev: pageNum > 1,
    };

    return { data, pagination };
  }

  /**
   * Searches and lists public projects with pagination and filtering.
   * @param queryParams - Query parameters for filtering and pagination
   * @returns Paginated list of public projects
   */
  public async searchProjects(queryParams: Record<string, unknown>): Promise<PaginatedResponse<{
    projectId: string;
    title: string;
    ownerId: string;
    category: string;
    status: IProject['status'];
    visibility: IProject['visibility'];
    collaborationType: IProject['collaborationType'];
    createdAt: string;
  }>> {
    const {
      q,
      category,
      sort = 'newest',
      page = 1,
      per_page = 20,
    } = queryParams as {
      q?: string;
      category?: string;
      sort?: string;
      page?: number | string;
      per_page?: number | string;
    };

    // 1. Build Query and Filter (Simulation of Search Engine Query)
    const limit = Math.min(Number(per_page) || 20, 100);
    const pageNum = Number(page) || 1;
    const skip = (pageNum - 1) * limit;

    const filters: FilterQuery<IProject> = {
      // CORE SECURITY: Only include public and active/completed projects
      visibility: 'public',
      status: { $in: ['active', 'completed'] },
    };

    // Apply Filters
    if (category) {
      filters.category = category;
    }

    // NOTE: Full text search 'q' requires dedicated index (omitted in this DB simulation)
    // For now, basic text search on title
    if (q) {
      filters.title = { $regex: q, $options: 'i' };
    }

    // 2. Build Sort Order
    const sortOrder: Record<string, 1 | -1> = {};
    if (sort === 'newest') {
      sortOrder.createdAt = -1;
    }
    // NOTE: 'relevance' sort is omitted in this DB simulation.

    // 3. Execute DB Query
    const [totalResults, projects] = await Promise.all([
      ProjectModel.countDocuments(filters),
      ProjectModel.find(filters)
        .select('title ownerId category status visibility collaborationType createdAt')
        .sort(sortOrder)
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // 4. Map to Public DTOs
    const data = (projects as IProject[]).map(project => ({
      projectId: project._id!.toString(),
      title: project.title,
      ownerId: project.ownerId.toString(),
      category: project.category,
      status: project.status,
      visibility: project.visibility,
      collaborationType: project.collaborationType,
      createdAt: project.createdAt!.toISOString(),
      // SECURITY: Ensure no sensitive data is exposed (no revenueSplits, milestones, etc.)
    }));

    // 5. Construct Paginated Response
    const totalPages = Math.ceil(totalResults / limit) || 1;
    const pagination: PaginationMeta = {
      page: pageNum,
      per_page: limit,
      total_items: totalResults,
      total_pages: totalPages,
      has_next: pageNum < totalPages,
      has_prev: pageNum > 1,
    };

    return { data, pagination };
  }
}


