// src/services/revenue.service.ts
import { ProjectModel, IProject } from '../models/project.model';
import { calculateRevenueSplit } from '../utils/revenueCalculator';
import { Types } from 'mongoose';

export class RevenueService {
  /**
   * Calculates the revenue split breakdown for a given amount, using Project data or provided splits.
   * @param data - Contains amount, currency, and optional projectId/revenueModel override.
   * @returns Revenue breakdown with platform fees and distribution
   * @throws {Error} - 'ProjectNotFound', 'RevenueModelNotFound'
   */
  public async calculateRevenueSplit(data: {
    projectId?: string;
    amount: number;
    currency: string;
    revenueModel?: { splits: any[] };
  }): Promise<any> {
    const { projectId, amount, currency, revenueModel } = data;

    let splits: any[] = revenueModel?.splits || [];

    // 1. Fetch splits from Project if not provided
    if (projectId && splits.length === 0) {
      const project = (await ProjectModel.findById(new Types.ObjectId(projectId))
        .select('revenueSplits')
        .lean()) as IProject | null;
      if (!project) {
        throw new Error('ProjectNotFound');
      }
      splits = project.revenueSplits || [];
    }

    if (!splits || splits.length === 0) {
      throw new Error('RevenueModelNotFound');
    }

    // 2. Execute Deterministic Calculation
    const result = calculateRevenueSplit({ amount, splits });

    return { ...result, currency };
  }
}

