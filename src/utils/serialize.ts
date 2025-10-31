import { Types } from 'mongoose';

/**
 * Recursively serializes MongoDB documents:
 * - Converts ObjectIds to strings
 * - Converts Dates to ISO 8601 strings
 * - Handles nested objects and arrays
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
export function serializeDocument<T = any>(doc: any): T {
  if (!doc) return doc;

  // Handle Mongoose documents
  const obj = doc.toObject ? doc.toObject() : doc;

  return JSON.parse(
    JSON.stringify(obj, (_key, value) => {
      // Convert ObjectIds to strings
      if (value && value._bsontype === 'ObjectID') {
        return value.toString();
      }

      // Convert Mongoose ObjectIds
      if (value instanceof Types.ObjectId) {
        return value.toString();
      }

      // Convert Dates to ISO strings
      if (value instanceof Date) {
        return value.toISOString();
      }

      return value;
    })
  );
}

/**
 * Ensures all ObjectId references are strings
 */
export function stringifyIds<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    if (
      value instanceof Types.ObjectId ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (value && (value as any)._bsontype === 'ObjectID')
    ) {
      result[key] = value.toString();
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        item instanceof Types.ObjectId || (item && (item as any)._bsontype === 'ObjectID')
          ? item.toString()
          : stringifyIds(item)
      );
    } else if (value && typeof value === 'object') {
      result[key] = stringifyIds(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Converts all Date fields to ISO 8601 strings
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
export function serializeDates(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Date) {
      result[key] = value.toISOString();
    } else if (value && typeof value === 'object') {
      result[key] = serializeDates(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}
