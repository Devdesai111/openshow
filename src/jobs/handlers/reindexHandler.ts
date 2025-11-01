// src/jobs/handlers/reindexHandler.ts
import { IJob } from '../../models/job.model';
import { DiscoveryService } from '../../services/discovery.service'; // Task 41 dependency
import { CreatorProfileModel } from '../../models/creatorProfile.model'; // Source data
import { ProjectModel } from '../../models/project.model'; // Source data
import { Types } from 'mongoose';

const discoveryService = new DiscoveryService();

/**
 * Worker Logic Handler for the 'reindex.batch' job type.
 * Pulls source data and pushes updates to the search indexing API (Task 41).
 */
export async function handleReindexJob(job: IJob): Promise<{ totalIndexed: number }> {
    const { docType, docIds } = job.payload;
    
    if (!docType || !docIds || !Array.isArray(docIds) || docIds.length === 0) {
        throw new Error('JobDataMissing: Missing docType or docIds array.');
    }
    
    let totalIndexed = 0;

    // 1. Determine Source Model and Fields to Fetch
    if (docType === 'creator') {
        // Fetch CreatorProfile documents with populated User data (for preferredName)
        const documents = await CreatorProfileModel.find({
            _id: { $in: docIds.map((id: string) => new Types.ObjectId(id)) }
        })
        .populate('userId', 'preferredName fullName')
        .lean() as Array<any & { userId?: { preferredName?: string; fullName?: string } }>;
        
        // 3. Process and Push to Indexing API (Task 41)
        for (const doc of documents) {
            // Build the simplified indexing payload
            const indexingPayload = {
                docType: 'creator' as const,
                docId: doc._id!.toString(),
                // CRITICAL: Send only the denormalized/search-ready fields
                payload: {
                    title: doc.userId?.preferredName || doc.userId?.fullName || 'Untitled',
                    skills: doc.skills || [],
                    verified: doc.verified || false,
                    status: doc.availability || 'open',
                    // Add more denormalized fields here (e.g., ownerName, roleCounts)
                },
                updatedAt: doc.updatedAt?.toISOString() || new Date().toISOString(),
            };

            try {
                // Push update to Discovery Service's internal API (Task 41)
                await discoveryService.indexDocument(indexingPayload);
                totalIndexed++;
            } catch (e: any) {
                // Log failure to index a single document but continue the batch (soft failure)
                console.error(`Failed to index ${docType} ${doc._id}: ${e.message}`);
            }
        }
    } else if (docType === 'project') {
        // Fetch Project documents
        const documents = await ProjectModel.find({
            _id: { $in: docIds.map((id: string) => new Types.ObjectId(id)) }
        }).lean() as Array<any>;
        
        // 3. Process and Push to Indexing API (Task 41)
        for (const doc of documents) {
            // Build the simplified indexing payload
            const indexingPayload = {
                docType: 'project' as const,
                docId: doc._id!.toString(),
                // CRITICAL: Send only the denormalized/search-ready fields
                payload: {
                    title: doc.title || 'Untitled',
                    category: doc.category || '',
                    status: doc.status || 'draft',
                    visibility: doc.visibility || 'public',
                    collaborationType: doc.collaborationType || 'open',
                    // Add more denormalized fields here
                },
                updatedAt: doc.updatedAt?.toISOString() || new Date().toISOString(),
            };

            try {
                // Push update to Discovery Service's internal API (Task 41)
                await discoveryService.indexDocument(indexingPayload);
                totalIndexed++;
            } catch (e: any) {
                // Log failure to index a single document but continue the batch (soft failure)
                console.error(`Failed to index ${docType} ${doc._id}: ${e.message}`);
            }
        }
    } else {
        throw new Error(`InvalidDocType: ${docType}`);
    }

    // 4. Return summary
    return { totalIndexed };
}

