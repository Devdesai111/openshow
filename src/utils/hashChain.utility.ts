// src/utils/hashChain.utility.ts
import crypto from 'crypto';
import { IAuditLog } from '../models/auditLog.model';

/**
 * Deterministically stringifies an object by sorting keys for stable hashing (Canonicalization).
 */
export function canonicalizeJson(obj: any): string {
  if (typeof obj !== 'object' || obj === null) {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const parts = keys.map(key => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`);
  return '{' + parts.join(',') + '}';
}

/**
 * Computes the unique, chainable hash for an audit log entry.
 * @param logData - The core log data (excluding current hash).
 * @param previousHash - The hash of the previous log entry.
 * @returns The SHA256 hash string.
 */
export function computeLogHash(
  logData: Omit<IAuditLog, 'hash' | 'createdAt' | 'updatedAt' | '_id' | 'immutable'>,
  previousHash: string
): string {
  // 1. Prepare hashable object including the chain link
  const hashableObject = {
    ...logData,
    previousHash: previousHash,
    // Convert IDs to strings explicitly for hashing consistency
    resourceId: logData.resourceId?.toString(),
    actorId: logData.actorId?.toString(),
    timestamp: logData.timestamp.toISOString(), // Normalize date to ISO string
  };

  // 2. Canonicalize and Hash (SHA256)
  const canonicalString = canonicalizeJson(hashableObject);
  return crypto.createHash('sha256').update(canonicalString).digest('hex');
}

