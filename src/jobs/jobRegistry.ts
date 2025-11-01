// src/jobs/jobRegistry.ts

interface IJobSchema {
    type: string;
    required: string[];
    properties: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>;
}

export interface IJobPolicy {
    type: string;
    maxAttempts: number; // Max retries
    timeoutSeconds: number; // Max execution time for worker
    concurrencyLimit?: number; // Max jobs of this type running simultaneously
}

// --- Schemas for Core Job Types (Simplified JSON Schema) ---
const THUMBNAIL_CREATE_SCHEMA: IJobSchema = {
    type: 'thumbnail.create',
    required: ['assetId', 'versionNumber'],
    properties: {
        assetId: 'string',
        versionNumber: 'number',
        sizes: 'array',
    },
};

const PAYOUT_EXECUTE_SCHEMA: IJobSchema = {
    type: 'payout.execute',
    required: ['batchId', 'escrowId'],
    properties: {
        batchId: 'string',
        escrowId: 'string',
        isRetry: 'boolean',
    },
};

const PDF_GENERATE_SCHEMA: IJobSchema = {
    type: 'pdf.generate',
    required: ['agreementId', 'payloadJson'],
    properties: {
        agreementId: 'string',
        payloadJson: 'object', // Schema.Types.Mixed - validated as object type
    },
};

const REINDEX_BATCH_SCHEMA: IJobSchema = {
    type: 'reindex.batch',
    required: ['docType', 'docIds'],
    properties: {
        docType: 'string', // 'creator' or 'project'
        docIds: 'array',
    },
};

const BLOCKCHAIN_ANCHOR_SCHEMA: IJobSchema = {
    type: 'blockchain.anchor',
    required: ['agreementId', 'immutableHash', 'chain'],
    properties: {
        agreementId: 'string',
        immutableHash: 'string',
        chain: 'string', // e.g., 'polygon', 'ipfs'
    },
};

const EXPORT_AUDIT_SCHEMA: IJobSchema = {
    type: 'export.audit',
    required: ['exportFilters', 'format', 'requesterId'],
    properties: {
        exportFilters: 'object',
        format: 'string',
        requesterId: 'string',
        requesterEmail: 'string',
    },
};

const AUDIT_SNAPSHOT_SCHEMA: IJobSchema = {
    type: 'audit.snapshot',
    required: ['from', 'to'],
    properties: {
        from: 'string',
        to: 'string',
    },
};

// --- Job Policies (Concurrency/Retry Rules) ---
const THUMBNAIL_CREATE_POLICY: IJobPolicy = {
    type: THUMBNAIL_CREATE_SCHEMA.type,
    maxAttempts: 3,
    timeoutSeconds: 300, // 5 minutes
};

const PAYOUT_EXECUTE_POLICY: IJobPolicy = {
    type: PAYOUT_EXECUTE_SCHEMA.type,
    maxAttempts: 10, // Higher max attempts for critical financial job
    timeoutSeconds: 60, // 1 minute (should be fast once initiated)
    concurrencyLimit: 5, // Limit simultaneous payout requests to PSP
};

const PDF_GENERATE_POLICY: IJobPolicy = {
    type: PDF_GENERATE_SCHEMA.type,
    maxAttempts: 5,
    timeoutSeconds: 600, // 10 minutes for potentially long rendering process
};

const REINDEX_BATCH_POLICY: IJobPolicy = {
    type: REINDEX_BATCH_SCHEMA.type,
    maxAttempts: 3,
    timeoutSeconds: 3600, // 1 hour for long batch processes
};

const BLOCKCHAIN_ANCHOR_POLICY: IJobPolicy = {
    type: BLOCKCHAIN_ANCHOR_SCHEMA.type,
    maxAttempts: 10, // High attempts due to network/gas failures
    timeoutSeconds: 1800, // 30 minutes
};

const EXPORT_AUDIT_POLICY: IJobPolicy = {
    type: EXPORT_AUDIT_SCHEMA.type,
    maxAttempts: 3,
    timeoutSeconds: 3600, // 1 hour for large exports
};

const AUDIT_SNAPSHOT_POLICY: IJobPolicy = {
    type: AUDIT_SNAPSHOT_SCHEMA.type,
    maxAttempts: 3,
    timeoutSeconds: 3600, // 1 hour for major snapshots
};

// --- Registry Setup ---

const JOB_REGISTRY: Record<string, { schema: IJobSchema, policy: IJobPolicy }> = {
    [THUMBNAIL_CREATE_SCHEMA.type]: { schema: THUMBNAIL_CREATE_SCHEMA, policy: THUMBNAIL_CREATE_POLICY },
    [PAYOUT_EXECUTE_SCHEMA.type]: { schema: PAYOUT_EXECUTE_SCHEMA, policy: PAYOUT_EXECUTE_POLICY },
    [PDF_GENERATE_SCHEMA.type]: { schema: PDF_GENERATE_SCHEMA, policy: PDF_GENERATE_POLICY },
    [REINDEX_BATCH_SCHEMA.type]: { schema: REINDEX_BATCH_SCHEMA, policy: REINDEX_BATCH_POLICY },
    [BLOCKCHAIN_ANCHOR_SCHEMA.type]: { schema: BLOCKCHAIN_ANCHOR_SCHEMA, policy: BLOCKCHAIN_ANCHOR_POLICY },
    [EXPORT_AUDIT_SCHEMA.type]: { schema: EXPORT_AUDIT_SCHEMA, policy: EXPORT_AUDIT_POLICY },
    [AUDIT_SNAPSHOT_SCHEMA.type]: { schema: AUDIT_SNAPSHOT_SCHEMA, policy: AUDIT_SNAPSHOT_POLICY },
};

/**
 * Validates a job payload against its registered schema.
 * @throws {Error} - 'JobTypeNotFound' or 'SchemaValidationFailed'.
 */
export function validateJobPayload(jobType: string, payload: any): void {
    const entry = JOB_REGISTRY[jobType];
    if (!entry) {
        throw new Error('JobTypeNotFound');
    }
    
    const { schema } = entry;
    const errors: string[] = [];

    // 1. Check Required Fields
    schema.required.forEach(field => {
        if (!payload.hasOwnProperty(field)) {
            errors.push(`Missing required field: ${field}`);
        }
    });

    // 2. Check Type (Simplified Type Check)
    for (const field in payload) {
        if (schema.properties[field]) {
            const expectedType = schema.properties[field];
            const actualType = typeof payload[field];
            
            if (expectedType === 'array' && !Array.isArray(payload[field])) {
                errors.push(`Invalid type for field ${field}: expected ${expectedType}, got ${actualType}`);
            } else if (expectedType === 'number' && actualType !== 'number') {
                // Strict number check
                errors.push(`Invalid type for field ${field}: expected ${expectedType}, got ${actualType}`);
            } else if (expectedType === 'boolean' && actualType !== 'boolean') {
                errors.push(`Invalid type for field ${field}: expected ${expectedType}, got ${actualType}`);
            } else if (expectedType === 'string' && actualType !== 'string') {
                errors.push(`Invalid type for field ${field}: expected ${expectedType}, got ${actualType}`);
            } else if (expectedType === 'object' && actualType !== 'object') {
                errors.push(`Invalid type for field ${field}: expected ${expectedType}, got ${actualType}`);
            }
        }
    }

    if (errors.length > 0) {
        throw new Error(`SchemaValidationFailed: ${errors.join('; ')}`);
    }
}

/** Retrieves the execution policy for a job type. */
export function getJobPolicy(jobType: string): IJobPolicy {
    const entry = JOB_REGISTRY[jobType];
    if (!entry) {
        throw new Error('JobTypeNotFound');
    }
    return entry.policy;
}

