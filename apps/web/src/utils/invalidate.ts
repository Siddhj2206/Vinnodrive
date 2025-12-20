import type { QueryClient } from "@tanstack/react-query";

/**
 * Centralized query invalidation utilities for storage operations.
 * 
 * Using predicate-based invalidation ensures ALL matching queries are invalidated,
 * regardless of their input parameters. This is more reliable than key-based
 * invalidation for tRPC queries with varying inputs.
 */

type StorageQueryType = 
  | "listFiles" 
  | "listFolders" 
  | "listTrash" 
  | "getQuota" 
  | "getStats"
  | "getSharedFiles";

/**
 * Extract the procedure path from a tRPC query key.
 * Handles multiple possible formats:
 * - [["storage", "listFiles"], { input: ... }] (nested array)
 * - ["storage", "listFiles", { input: ... }] (flat array)
 * - ["storage.listFiles", { input: ... }] (dotted string)
 */
function extractProcedurePath(queryKey: unknown): [string, string] | null {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return null;
  
  const firstElement = queryKey[0];
  
  // Format: [["storage", "listFiles"], ...]
  if (Array.isArray(firstElement) && firstElement.length >= 2) {
    return [String(firstElement[0]), String(firstElement[1])];
  }
  
  // Format: ["storage.listFiles", ...] (dotted string)
  if (typeof firstElement === "string" && firstElement.includes(".")) {
    const parts = firstElement.split(".");
    if (parts.length >= 2) {
      return [parts[0], parts[1]];
    }
  }
  
  // Format: ["storage", "listFiles", ...]
  if (typeof firstElement === "string" && queryKey.length >= 2 && typeof queryKey[1] === "string") {
    return [firstElement, queryKey[1]];
  }
  
  return null;
}

/**
 * Invalidate specific storage queries by procedure name.
 * Uses predicate matching to catch all queries regardless of input params.
 */
export function invalidateStorageQueries(
  queryClient: QueryClient,
  queries: StorageQueryType[]
) {
  queryClient.invalidateQueries({
    predicate: (query) => {
      const path = extractProcedurePath(query.queryKey);
      if (!path) return false;
      
      const [router, procedure] = path;
      if (router !== "storage") return false;
      
      return queries.includes(procedure as StorageQueryType);
    },
  });
}

/**
 * Invalidate all storage-related queries.
 * Use sparingly - prefer targeted invalidation when possible.
 */
export function invalidateAllStorageQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({
    predicate: (query) => {
      const path = extractProcedurePath(query.queryKey);
      if (!path) return false;
      return path[0] === "storage";
    },
  });
}

/**
 * Pre-defined invalidation sets for common operations
 */
export const StorageInvalidations = {
  /** After uploading a file */
  afterUpload: (qc: QueryClient) => 
    invalidateStorageQueries(qc, ["listFiles", "listFolders", "getQuota", "getStats"]),
  
  /** After moving a file or folder to trash */
  afterMoveToTrash: (qc: QueryClient) => 
    invalidateStorageQueries(qc, ["listFiles", "listFolders", "listTrash", "getQuota", "getStats"]),
  
  /** After restoring from trash */
  afterRestore: (qc: QueryClient) => 
    invalidateStorageQueries(qc, ["listFiles", "listFolders", "listTrash"]),
  
  /** After permanently deleting */
  afterPermanentDelete: (qc: QueryClient) => 
    invalidateStorageQueries(qc, ["listTrash", "getQuota", "getStats"]),
  
  /** After emptying trash */
  afterEmptyTrash: (qc: QueryClient) => 
    invalidateStorageQueries(qc, ["listTrash", "getQuota", "getStats"]),
  
  /** After creating/renaming/deleting a folder */
  afterFolderChange: (qc: QueryClient) => 
    invalidateStorageQueries(qc, ["listFiles", "listFolders"]),
  
  /** After renaming a file */
  afterFileRename: (qc: QueryClient) => 
    invalidateStorageQueries(qc, ["listFiles"]),
  
  /** After toggling public sharing */
  afterToggleShare: (qc: QueryClient) => 
    invalidateStorageQueries(qc, ["listFiles"]),
} as const;
