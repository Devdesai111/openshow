import { FilterQuery } from 'mongoose';
import { CreatorProfileModel, ICreatorProfile } from '../models/creatorProfile.model';
import { IUser } from '../models/user.model';
import { PaginatedResponse, PaginationMeta } from '../types/pagination-dtos';
import { ProjectModel, IProject } from '../models/project.model';
import { getCurrentRankingWeights } from '../config/rankingWeights';

// Placeholder for the Index Document (Simulating a document in ElasticSearch/OpenSearch)
// PRODUCTION: This would be the actual ES/OpenSearch client interaction.
const MockSearchIndexStore = new Map<string, any>();

interface IIndexDocumentRequest {
  docType: 'creator' | 'project';
  docId: string;
  payload: Record<string, any>;
  updatedAt: string;
}

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

  /**
   * Updates or creates a document in the search index with out-of-order protection.
   * @param data - Index document request with docType, docId, payload, and updatedAt
   * @throws {Error} - 'StaleUpdate' if incoming updatedAt is older than the current index record
   */
  public async indexDocument(data: IIndexDocumentRequest): Promise<void> {
    const { docType, docId, payload, updatedAt } = data;
    const indexKey = `${docType}_${docId}`;
    const newUpdatedAt = new Date(updatedAt);

    // 1. Check for Stale/Out-of-Order Update (CRITICAL)
    const currentDoc = MockSearchIndexStore.get(indexKey);

    if (currentDoc && currentDoc.updatedAt && newUpdatedAt <= new Date(currentDoc.updatedAt)) {
      // New update is older or same as current indexed document, ignore.
      console.warn(`[Index] Stale update rejected for ${indexKey}. Current: ${currentDoc.updatedAt}, Incoming: ${updatedAt}`);
      throw new Error('StaleUpdate');
    }

    // 2. Merge/Upsert Logic (Simulate partial update and indexing)
    const newDoc = {
      ...currentDoc,
      ...payload,
      docId,
      docType,
      updatedAt: newUpdatedAt.toISOString(),
    };

    MockSearchIndexStore.set(indexKey, newDoc);

    // PRODUCTION: Call ElasticSearch/OpenSearch Client:
    // esClient.update({ index: docType, id: docId, body: { doc: payload, doc_as_upsert: true } });

    console.warn(`[Index] Document ${indexKey} successfully indexed/updated.`);
  }

  /**
   * Exposes the mock search index store for testing purposes.
   * @internal This should only be used in tests
   */
  public _getMockIndexStore(): Map<string, any> {
    return MockSearchIndexStore;
  }

  /**
   * Clears the mock search index store for testing purposes.
   * @internal This should only be used in tests
   */
  public _clearMockIndexStore(): void {
    MockSearchIndexStore.clear();
  }

  /**
   * Applies the current blended ranking formula to a search document.
   * NOTE: This is a utility function used in search query builder (simulated).
   * @param document - Document to rank (creator or project)
   * @param textRelevanceScore - Text relevance score from search engine (0..1)
   * @param experimentId - Optional experiment ID for A/B testing
   * @returns Final blended score (0..100)
   */
  public applyBlendedRanking(document: any, textRelevanceScore: number, experimentId?: string): number {
    const weights = getCurrentRankingWeights(experimentId);

    // --- Calculate Signals (Mock/Placeholder Logic) ---
    // Trust Signal: Function of Verified + Rating (normalized 0..1)
    const trustSignal = (document.verified ? 1 : 0) * 0.5 + ((document.rating?.average || 0) / 5) * 0.5;

    // Recency Signal: Simple high value for recent update (normalized 0..1)
    const recencySignal =
      Date.now() - new Date(document.updatedAt || 0).getTime() < 30 * 24 * 60 * 60 * 1000 ? 1 : 0.2;

    // --- Apply Blended Formula ---
    const finalScore =
      weights.alpha * textRelevanceScore +
      weights.beta * trustSignal +
      weights.gamma * recencySignal +
      weights.delta * 0.5 + // Mock Activity
      weights.epsilon * (document.sponsoredBoost || 0);

    // Normalize to a 0-100 range for client display
    return Math.min(100, Math.round(finalScore * 100));
  }

  /**
   * Retrieves real-time search suggestions.
   * @param data - Suggestion request with query, optional type filter, and limit
   * @returns List of ranked suggestions
   */
  public async getSuggestions(data: {
    q: string;
    type?: 'creator' | 'project' | 'skill' | 'tag';
    limit: number;
  }): Promise<{ query: string; suggestions: Array<{ text: string; type: string; score: number; id?: string }> }> {
    const { q, type, limit } = data;
    const queryLower = q.toLowerCase();

    // 1. Filter and Score based on the query (Simulated Edge N-Gram Match)
    let results = MockSuggestionCache.filter(item => {
      const textMatch = item.text.toLowerCase().startsWith(queryLower);
      const typeMatch = !type || item.type === type;
      return textMatch && typeMatch;
    })
      // 2. Apply simulated ranking/sort
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // 3. Map to final DTO
    const suggestions = results.map(item => ({
      text: item.text,
      type: item.type,
      score: item.score,
      id: item.id?.startsWith('skill') ? undefined : item.id, // Only return ID for entities (Creator/Project)
    }));

    return {
      query: q,
      suggestions,
    };
  }
}

// --- Mock Index/Cache for Suggestions (Simulating a highly optimized index/Redis cache) ---
interface ISuggestionCacheItem {
  text: string;
  type: 'creator' | 'project' | 'skill' | 'tag';
  score: number;
  id?: string;
}

const MockSuggestionCache: ISuggestionCacheItem[] = [
  { text: 'Prompt Engineer', type: 'skill', score: 0.98, id: 'skill_prompt' },
  { text: 'AI Video Editor', type: 'skill', score: 0.95, id: 'skill_video' },
  { text: 'Dev Bhai (Creator)', type: 'creator', score: 0.9, id: 'creator_1' },
  { text: 'Echoes - AI Short Film', type: 'project', score: 0.85, id: 'proj_echo' },
  { text: 'AI Music Composer', type: 'skill', score: 0.7, id: 'skill_music' },
  { text: 'PrompTech Innovations', type: 'project', score: 0.92, id: 'proj_promptech' },
  { text: 'Video Production Specialist', type: 'skill', score: 0.88, id: 'skill_video_prod' },
  { text: 'Creative Director', type: 'creator', score: 0.75, id: 'creator_2' },
];


