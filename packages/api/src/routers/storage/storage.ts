import { z } from "zod";
import { S3Client } from "bun";
import { router, protectedProcedure, publicProcedure } from "../../index";
import { getEnv } from "../../env";
import { db } from "@Vinnodrive/db";
import {
  files,
  userAssets,
  folders,
  userQuotas,
  rateLimitWindows,
} from "@Vinnodrive/db/schema/storage";
import { eq, sql, and, desc, isNull, isNotNull, count } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

// Get validated environment
const env = getEnv();

// Cloudflare R2 Client configuration (S3-compatible)
// Endpoint format: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
const s3 = new S3Client({
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET_NAME,
  endpoint: env.R2_ENDPOINT,
  region: "auto", // R2 uses "auto" for region
});

// Default configuration (configurable)
const DEFAULT_STORAGE_LIMIT = 1 * 1024 * 1024 * 1024; // 1GB
const DEFAULT_RATE_LIMIT = 2; // 2 API calls per second
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second window
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB max file size

// Validation schemas
/**
 * Filename validation:
 * - 1-255 characters
 * - Cannot contain path traversal characters (/, \, ..)
 * - Cannot contain null bytes
 * - Cannot be reserved names on Windows (CON, PRN, AUX, etc.)
 */
const filenameSchema = z
  .string()
  .min(1, "Filename is required")
  .max(255, "Filename must be 255 characters or less")
  .regex(
    /^[^\/\\:\*\?"<>\|\x00]+$/,
    "Filename contains invalid characters"
  )
  .refine(
    (name) => !name.includes(".."),
    "Filename cannot contain path traversal sequences"
  )
  .refine(
    (name) =>
      !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name),
    "Filename is a reserved system name"
  );

/**
 * Content type validation:
 * - Must be a valid MIME type format (type/subtype)
 * - Optionally with parameters (e.g., charset=utf-8)
 */
const contentTypeSchema = z
  .string()
  .regex(
    /^[a-z]+\/[a-z0-9.+-]+(\s*;\s*[a-z0-9-]+=\S+)*$/i,
    "Invalid MIME type format"
  )
  .optional();

/**
 * File size validation:
 * - Must be positive
 * - Maximum 10GB
 */
const fileSizeSchema = z
  .number()
  .positive("File size must be positive")
  .max(MAX_FILE_SIZE, `File size cannot exceed ${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB`);

// Helper: Get user ID from session
const getUserId = (ctx: { session: { user: { id: string } } }) =>
  ctx.session.user.id;

// Helper: Check and enforce rate limit
async function checkRateLimit(userId: string): Promise<void> {
  const now = new Date();
  const windowStart = new Date(
    Math.floor(now.getTime() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS
  );

  // Get user's rate limit setting
  const quota = await db.query.userQuotas.findFirst({
    where: eq(userQuotas.userId, userId),
  });
  const rateLimit = quota?.rateLimit ?? DEFAULT_RATE_LIMIT;

  // Check current window
  const currentWindow = await db.query.rateLimitWindows.findFirst({
    where: and(
      eq(rateLimitWindows.userId, userId),
      eq(rateLimitWindows.windowStart, windowStart)
    ),
  });

  if (currentWindow && currentWindow.requestCount >= rateLimit) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Rate limit exceeded. Maximum ${rateLimit} requests per second.`,
    });
  }

  // Increment or create window
  if (currentWindow) {
    await db
      .update(rateLimitWindows)
      .set({ requestCount: sql`${rateLimitWindows.requestCount} + 1` })
      .where(eq(rateLimitWindows.id, currentWindow.id));
  } else {
    await db.insert(rateLimitWindows).values({
      userId,
      windowStart,
      requestCount: 1,
    });

    // Clean up old windows (older than 1 minute)
    const cutoff = new Date(now.getTime() - 60000);
    await db
      .delete(rateLimitWindows)
      .where(
        and(
          eq(rateLimitWindows.userId, userId),
          sql`${rateLimitWindows.windowStart} < ${cutoff}`
        )
      );
  }
}

// Helper: Check storage quota
async function checkStorageQuota(
  userId: string,
  additionalBytes: number
): Promise<void> {
  // Get or create user quota
  let quota = await db.query.userQuotas.findFirst({
    where: eq(userQuotas.userId, userId),
  });

  if (!quota) {
    // Create default quota for user
    await db.insert(userQuotas).values({
      userId,
      storageUsed: 0,
      storageLimit: DEFAULT_STORAGE_LIMIT,
      rateLimit: DEFAULT_RATE_LIMIT,
    });
    quota = {
      userId,
      storageUsed: 0,
      storageLimit: DEFAULT_STORAGE_LIMIT,
      rateLimit: DEFAULT_RATE_LIMIT,
      updatedAt: new Date(),
    };
  }

  if (quota.storageUsed + additionalBytes > quota.storageLimit) {
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Storage quota exceeded. Used: ${formatBytes(quota.storageUsed)}, Limit: ${formatBytes(quota.storageLimit)}, Requested: ${formatBytes(additionalBytes)}`,
    });
  }
}

// Helper: Update storage usage
async function updateStorageUsage(
  userId: string,
  deltaBytes: number
): Promise<void> {
  await db
    .insert(userQuotas)
    .values({
      userId,
      storageUsed: Math.max(0, deltaBytes),
      storageLimit: DEFAULT_STORAGE_LIMIT,
      rateLimit: DEFAULT_RATE_LIMIT,
    })
    .onConflictDoUpdate({
      target: userQuotas.userId,
      set: {
        storageUsed: sql`GREATEST(0, ${userQuotas.storageUsed} + ${deltaBytes})`,
      },
    });
}

// Helper: Format bytes for display
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Rate limited procedure - wraps protectedProcedure with rate limit check
const rateLimitedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  await checkRateLimit(getUserId(ctx));
  return next();
});

export const storageRouter = router({
  // ============================================
  // UPLOAD AND DEDUPLICATION
  // ============================================

  /**
   * Get presigned URL for upload with deduplication check
   * If file already exists (same hash), returns deduplicated status
   */
  getUploadPresignedUrl: rateLimitedProcedure
    .input(
      z.object({
        filename: filenameSchema,
        size: fileSizeSchema,
        hash: z.string().regex(/^[a-f0-9]{64}$/i, "Invalid SHA-256 hash"),
        contentType: contentTypeSchema,
        folderId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Check storage quota before proceeding
      await checkStorageQuota(userId, input.size);

      // Check for deduplication
      const existingFile = await db.query.files.findFirst({
        where: eq(files.hash, input.hash),
      });

      if (existingFile) {
        // File content already exists - create reference without uploading
        await db.transaction(async (tx) => {
          // Create user asset linking to existing file
          await tx.insert(userAssets).values({
            name: input.filename,
            contentType: input.contentType ?? null,
            userId,
            folderId: input.folderId ?? null,
            fileHash: existingFile.hash,
          });

          // Increment reference count
          await tx
            .update(files)
            .set({ refCount: sql`${files.refCount} + 1` })
            .where(eq(files.hash, existingFile.hash));
        });

        // Update user's storage usage (still counts against their quota)
        await updateStorageUsage(userId, input.size);

        return {
          deduplicated: true,
          url: null,
          key: null,
          message: "File already exists, created reference without re-uploading",
        };
      }

      // File doesn't exist - generate presigned URL for upload
      const key = input.hash; // Store by hash for deduplication
      const url = s3.presign(key, {
        method: "PUT",
        expiresIn: 3600, // 1 hour
      });

      return {
        deduplicated: false,
        url,
        key,
        message: "Upload to presigned URL, then call confirmUpload",
      };
    }),

  /**
   * Confirm upload after file has been uploaded to S3
   */
  confirmUpload: rateLimitedProcedure
    .input(
      z.object({
        filename: filenameSchema,
        size: fileSizeSchema,
        hash: z.string().regex(/^[a-f0-9]{64}$/i, "Invalid SHA-256 hash"),
        contentType: contentTypeSchema,
        folderId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Verify file exists in S3
      const exists = await s3.file(input.hash).exists();
      if (!exists) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File upload verification failed. File not found in storage.",
        });
      }

      await db.transaction(async (tx) => {
        // Create or update file record
        await tx
          .insert(files)
          .values({
            hash: input.hash,
            size: input.size,
            path: input.hash,
            refCount: 1,
          })
          .onConflictDoUpdate({
            target: files.hash,
            set: { refCount: sql`${files.refCount} + 1` },
          });

        // Create user asset
        await tx.insert(userAssets).values({
          name: input.filename,
          contentType: input.contentType ?? null,
          userId,
          folderId: input.folderId ?? null,
          fileHash: input.hash,
        });
      });

      // Update storage usage
      await updateStorageUsage(userId, input.size);

      return { success: true, message: "File uploaded and confirmed" };
    }),

  // ============================================
  // FILE MANAGEMENT
  // ============================================

  /**
   * List files and folders for the current user
   */
  listFiles: rateLimitedProcedure
    .input(
      z
        .object({
          folderId: z.string().uuid().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Get files in the specified folder (or root if no folderId)
      // Exclude trashed items (deletedAt is not null)
      const assets = await db.query.userAssets.findMany({
        where: and(
          eq(userAssets.userId, userId),
          isNull(userAssets.deletedAt),
          input?.folderId
            ? eq(userAssets.folderId, input.folderId)
            : isNull(userAssets.folderId)
        ),
        with: { file: true },
        orderBy: [desc(userAssets.createdAt)],
      });

      // Get subfolders (exclude trashed)
      const userFolders = await db.query.folders.findMany({
        where: and(
          eq(folders.userId, userId),
          isNull(folders.deletedAt),
          input?.folderId
            ? eq(folders.parentId, input.folderId)
            : isNull(folders.parentId)
        ),
        orderBy: [desc(folders.createdAt)],
      });

      // Format response with deduplication status
      const formattedFiles = assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.file.size,
        contentType: asset.contentType,
        uploadDate: asset.createdAt,
        uploader: userId, // In a full implementation, fetch user name
        isOriginal: asset.file.refCount === 1,
        isDeduplicated: asset.file.refCount > 1,
        refCount: asset.file.refCount,
        isPublic: asset.isPublic,
        publicShareId: asset.publicShareId,
        downloadCount: asset.downloadCount,
      }));

      return {
        files: formattedFiles,
        folders: userFolders,
        currentFolderId: input?.folderId ?? null,
      };
    }),

  /**
   * Get file details
   */
  getFile: rateLimitedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const asset = await db.query.userAssets.findFirst({
        where: and(
          eq(userAssets.id, input.id),
          eq(userAssets.userId, userId),
          isNull(userAssets.deletedAt)
        ),
        with: { file: true, folder: true },
      });

      if (!asset) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found",
        });
      }

      // Generate download URL
      const downloadUrl = s3.presign(asset.file.path, {
        expiresIn: 3600,
      });

      return {
        id: asset.id,
        name: asset.name,
        size: asset.file.size,
        contentType: asset.contentType,
        uploadDate: asset.createdAt,
        folder: asset.folder,
        isOriginal: asset.file.refCount === 1,
        isDeduplicated: asset.file.refCount > 1,
        refCount: asset.file.refCount,
        isPublic: asset.isPublic,
        publicShareId: asset.publicShareId,
        downloadCount: asset.downloadCount,
        downloadUrl,
      };
    }),

  // ============================================
  // FOLDER MANAGEMENT
  // ============================================

/**
   * List only folders (lightweight query for sidebar)
   */
  listFolders: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    const userFolders = await db.query.folders.findMany({
      where: and(
        eq(folders.userId, userId),
        isNull(folders.deletedAt)
      ),
      orderBy: [desc(folders.createdAt)],
    });

    return userFolders;
  }),

  /**
   * Create a new folder
   */
  createFolder: rateLimitedProcedure
    .input(
      z.object({
        name: filenameSchema,
        parentId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Verify parent folder exists and belongs to user if specified
      if (input.parentId) {
        const parentFolder = await db.query.folders.findFirst({
          where: and(
            eq(folders.id, input.parentId),
            eq(folders.userId, userId)
          ),
        });
        if (!parentFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Parent folder not found",
          });
        }
      }

      const [folder] = await db
        .insert(folders)
        .values({
          name: input.name,
          parentId: input.parentId ?? null,
          userId,
        })
        .returning();

      return { success: true, folder };
    }),

  /**
   * Rename a folder
   */
  renameFolder: rateLimitedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: filenameSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const [updated] = await db
        .update(folders)
        .set({ name: input.name })
        .where(and(eq(folders.id, input.id), eq(folders.userId, userId)))
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found",
        });
      }

      return { success: true, folder: updated };
    }),

  /**
   * Delete a folder (must be empty)
   */
  deleteFolder: rateLimitedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Check folder exists and belongs to user
      const folder = await db.query.folders.findFirst({
        where: and(eq(folders.id, input.id), eq(folders.userId, userId)),
      });

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found",
        });
      }

      // Check if folder has contents
      const hasFiles = await db.query.userAssets.findFirst({
        where: eq(userAssets.folderId, input.id),
      });
      const hasSubfolders = await db.query.folders.findFirst({
        where: eq(folders.parentId, input.id),
      });

      if (hasFiles || hasSubfolders) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Folder is not empty. Delete all contents first.",
        });
      }

      await db.delete(folders).where(eq(folders.id, input.id));

      return { success: true };
    }),

  /**
   * Move a folder to trash (soft delete - recursive)
   * Moves the folder and all its contents (files and subfolders) to trash
   */
  moveFolderToTrash: rateLimitedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const now = new Date();

      // Check folder exists and belongs to user
      const folder = await db.query.folders.findFirst({
        where: and(
          eq(folders.id, input.id),
          eq(folders.userId, userId),
          isNull(folders.deletedAt)
        ),
      });

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found or already in trash",
        });
      }

      // Recursively collect all folder IDs to trash
      async function collectFolderIds(folderId: string): Promise<string[]> {
        const subfolders = await db.query.folders.findMany({
          where: and(
            eq(folders.parentId, folderId),
            eq(folders.userId, userId),
            isNull(folders.deletedAt)
          ),
        });

        const ids = [folderId];
        for (const subfolder of subfolders) {
          const subIds = await collectFolderIds(subfolder.id);
          ids.push(...subIds);
        }
        return ids;
      }

      const folderIds = await collectFolderIds(input.id);

      await db.transaction(async (tx) => {
        // Trash all files in these folders
        if (folderIds.length > 0) {
          await tx
            .update(userAssets)
            .set({ deletedAt: now })
            .where(
              and(
                eq(userAssets.userId, userId),
                isNull(userAssets.deletedAt),
                sql`${userAssets.folderId} IN (${sql.join(folderIds.map(id => sql`${id}`), sql`, `)})`
              )
            );
        }

        // Trash all folders
        for (const folderId of folderIds) {
          await tx
            .update(folders)
            .set({ deletedAt: now })
            .where(eq(folders.id, folderId));
        }
      });

      return { 
        success: true, 
        message: "Folder and contents moved to trash",
        trashedFolders: folderIds.length,
      };
    }),

  /**
   * Restore a folder from trash (recursive)
   * Restores the folder and all its contents
   */
  restoreFolderFromTrash: rateLimitedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Check folder exists and is in trash
      const folder = await db.query.folders.findFirst({
        where: and(
          eq(folders.id, input.id),
          eq(folders.userId, userId),
          isNotNull(folders.deletedAt)
        ),
      });

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found in trash",
        });
      }

      // Check if parent folder exists and is not trashed (if not root)
      if (folder.parentId) {
        const parentFolder = await db.query.folders.findFirst({
          where: and(
            eq(folders.id, folder.parentId),
            eq(folders.userId, userId)
          ),
        });

        if (!parentFolder) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Parent folder no longer exists",
          });
        }

        if (parentFolder.deletedAt) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Parent folder is in trash. Restore it first or restore this folder to root.",
          });
        }
      }

      // Recursively collect all trashed folder IDs under this folder
      async function collectTrashedFolderIds(folderId: string): Promise<string[]> {
        const subfolders = await db.query.folders.findMany({
          where: and(
            eq(folders.parentId, folderId),
            eq(folders.userId, userId),
            isNotNull(folders.deletedAt)
          ),
        });

        const ids = [folderId];
        for (const subfolder of subfolders) {
          const subIds = await collectTrashedFolderIds(subfolder.id);
          ids.push(...subIds);
        }
        return ids;
      }

      const folderIds = await collectTrashedFolderIds(input.id);

      await db.transaction(async (tx) => {
        // Restore all files in these folders
        if (folderIds.length > 0) {
          await tx
            .update(userAssets)
            .set({ deletedAt: null })
            .where(
              and(
                eq(userAssets.userId, userId),
                isNotNull(userAssets.deletedAt),
                sql`${userAssets.folderId} IN (${sql.join(folderIds.map(id => sql`${id}`), sql`, `)})`
              )
            );
        }

        // Restore all folders
        for (const folderId of folderIds) {
          await tx
            .update(folders)
            .set({ deletedAt: null })
            .where(eq(folders.id, folderId));
        }
      });

      return { 
        success: true, 
        message: "Folder and contents restored from trash",
        restoredFolders: folderIds.length,
      };
    }),

  // ============================================
  // FILE DELETION
  // ============================================

  /**
   * Delete a file asset
   * Only the uploader can delete their own files
   * Actual S3 content only deleted when all references are gone
   */
  deleteAsset: rateLimitedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Find the asset - must belong to current user
      const asset = await db.query.userAssets.findFirst({
        where: and(eq(userAssets.id, input.id), eq(userAssets.userId, userId)),
        with: { file: true },
      });

      if (!asset) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "File not found or you do not have permission to delete it",
        });
      }

      const fileSize = asset.file.size;
      const fileHash = asset.fileHash;

      await db.transaction(async (tx) => {
        // Delete the user asset
        await tx.delete(userAssets).where(eq(userAssets.id, input.id));

        // Decrement reference count
        const [updatedFile] = await tx
          .update(files)
          .set({ refCount: sql`${files.refCount} - 1` })
          .where(eq(files.hash, fileHash))
          .returning();

        // If no more references, delete from S3 and database
        if (updatedFile && updatedFile.refCount <= 0) {
          await s3.file(updatedFile.path).delete();
          await tx.delete(files).where(eq(files.hash, fileHash));
        }
      });

      // Update storage usage (decrease)
      await updateStorageUsage(userId, -fileSize);

      return { success: true, message: "File deleted successfully" };
    }),

  // ============================================
  // TRASH MANAGEMENT
  // ============================================

  /**
   * Move a file to trash (soft delete)
   */
  moveToTrash: rateLimitedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const [updated] = await db
        .update(userAssets)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(userAssets.id, input.id),
            eq(userAssets.userId, userId),
            isNull(userAssets.deletedAt)
          )
        )
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found or already in trash",
        });
      }

      return { success: true, message: "File moved to trash" };
    }),

  /**
   * Restore a file from trash
   */
  restoreFromTrash: rateLimitedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const [updated] = await db
        .update(userAssets)
        .set({ deletedAt: null })
        .where(
          and(
            eq(userAssets.id, input.id),
            eq(userAssets.userId, userId),
            isNotNull(userAssets.deletedAt)
          )
        )
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found in trash",
        });
      }

      return { success: true, message: "File restored from trash" };
    }),

  /**
   * List files and folders in trash
   */
  listTrash: rateLimitedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    // Get trashed files
    const trashedAssets = await db.query.userAssets.findMany({
      where: and(
        eq(userAssets.userId, userId),
        isNotNull(userAssets.deletedAt)
      ),
      with: { file: true },
      orderBy: [desc(userAssets.deletedAt)],
    });

    // Get trashed folders (only top-level trashed folders - those whose parent is not trashed or is null)
    const allTrashedFolders = await db.query.folders.findMany({
      where: and(
        eq(folders.userId, userId),
        isNotNull(folders.deletedAt)
      ),
      orderBy: [desc(folders.deletedAt)],
    });

    // Filter to only show "root" trashed folders (parent not trashed or no parent)
    const trashedFolderIds = new Set(allTrashedFolders.map(f => f.id));
    const topLevelTrashedFolders = allTrashedFolders.filter(folder => {
      // If no parent, it's a top-level trashed folder
      if (!folder.parentId) return true;
      // If parent is not in trash, show this folder
      if (!trashedFolderIds.has(folder.parentId)) return true;
      // Otherwise, it's nested within a trashed folder - don't show at top level
      return false;
    });

    const files = trashedAssets.map((asset) => ({
      id: asset.id,
      type: "file" as const,
      name: asset.name,
      size: asset.file.size,
      deletedAt: asset.deletedAt,
      uploadDate: asset.createdAt,
    }));

    const trashedFolders = topLevelTrashedFolders.map((folder) => ({
      id: folder.id,
      type: "folder" as const,
      name: folder.name,
      deletedAt: folder.deletedAt,
      createdAt: folder.createdAt,
    }));

    return {
      files,
      folders: trashedFolders,
    };
  }),

  /**
   * Permanently delete a file from trash
   */
  permanentlyDelete: rateLimitedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Find the asset in trash
      const asset = await db.query.userAssets.findFirst({
        where: and(
          eq(userAssets.id, input.id),
          eq(userAssets.userId, userId),
          isNotNull(userAssets.deletedAt)
        ),
        with: { file: true },
      });

      if (!asset) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found in trash",
        });
      }

      const fileSize = asset.file.size;
      const fileHash = asset.fileHash;

      await db.transaction(async (tx) => {
        // Delete the user asset
        await tx.delete(userAssets).where(eq(userAssets.id, input.id));

        // Decrement reference count
        const [updatedFile] = await tx
          .update(files)
          .set({ refCount: sql`${files.refCount} - 1` })
          .where(eq(files.hash, fileHash))
          .returning();

        // If no more references, delete from S3 and database
        if (updatedFile && updatedFile.refCount <= 0) {
          await s3.file(updatedFile.path).delete();
          await tx.delete(files).where(eq(files.hash, fileHash));
        }
      });

      // Update storage usage (decrease)
      await updateStorageUsage(userId, -fileSize);

      return { success: true, message: "File permanently deleted" };
    }),

  /**
   * Permanently delete a folder from trash (recursive)
   * Deletes the folder and all its contents permanently
   */
  permanentlyDeleteFolder: rateLimitedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Find the folder in trash
      const folder = await db.query.folders.findFirst({
        where: and(
          eq(folders.id, input.id),
          eq(folders.userId, userId),
          isNotNull(folders.deletedAt)
        ),
      });

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found in trash",
        });
      }

      // Recursively collect all folder IDs
      async function collectAllFolderIds(folderId: string): Promise<string[]> {
        const subfolders = await db.query.folders.findMany({
          where: and(
            eq(folders.parentId, folderId),
            eq(folders.userId, userId)
          ),
        });

        const ids = [folderId];
        for (const subfolder of subfolders) {
          const subIds = await collectAllFolderIds(subfolder.id);
          ids.push(...subIds);
        }
        return ids;
      }

      const folderIds = await collectAllFolderIds(input.id);
      let totalFreedBytes = 0;

      // Get all files in these folders
      const assetsInFolders = await db.query.userAssets.findMany({
        where: and(
          eq(userAssets.userId, userId),
          sql`${userAssets.folderId} IN (${sql.join(folderIds.map(id => sql`${id}`), sql`, `)})`
        ),
        with: { file: true },
      });

      await db.transaction(async (tx) => {
        // Delete all files and update reference counts
        for (const asset of assetsInFolders) {
          await tx.delete(userAssets).where(eq(userAssets.id, asset.id));

          const [updatedFile] = await tx
            .update(files)
            .set({ refCount: sql`${files.refCount} - 1` })
            .where(eq(files.hash, asset.fileHash))
            .returning();

          if (updatedFile && updatedFile.refCount <= 0) {
            await s3.file(updatedFile.path).delete();
            await tx.delete(files).where(eq(files.hash, asset.fileHash));
          }

          totalFreedBytes += asset.file.size;
        }

        // Delete all folders (children first, then parents)
        for (const folderId of folderIds.reverse()) {
          await tx.delete(folders).where(eq(folders.id, folderId));
        }
      });

      // Update storage usage
      await updateStorageUsage(userId, -totalFreedBytes);

      return { 
        success: true, 
        message: "Folder and contents permanently deleted",
        deletedFiles: assetsInFolders.length,
        deletedFolders: folderIds.length,
        freedBytes: totalFreedBytes,
        freedBytesFormatted: formatBytes(totalFreedBytes),
      };
    }),

  /**
   * Empty entire trash (permanently delete all trashed files and folders)
   */
  emptyTrash: rateLimitedProcedure.mutation(async ({ ctx }) => {
    const userId = getUserId(ctx);

    // Get all trashed assets
    const trashedAssets = await db.query.userAssets.findMany({
      where: and(
        eq(userAssets.userId, userId),
        isNotNull(userAssets.deletedAt)
      ),
      with: { file: true },
    });

    // Get all trashed folders
    const trashedFolders = await db.query.folders.findMany({
      where: and(
        eq(folders.userId, userId),
        isNotNull(folders.deletedAt)
      ),
    });

    if (trashedAssets.length === 0 && trashedFolders.length === 0) {
      return { 
        success: true, 
        deletedFiles: 0, 
        deletedFolders: 0, 
        message: "Trash is already empty" 
      };
    }

    let totalFreedBytes = 0;

    await db.transaction(async (tx) => {
      // Delete all trashed files
      for (const asset of trashedAssets) {
        await tx.delete(userAssets).where(eq(userAssets.id, asset.id));

        const [updatedFile] = await tx
          .update(files)
          .set({ refCount: sql`${files.refCount} - 1` })
          .where(eq(files.hash, asset.fileHash))
          .returning();

        if (updatedFile && updatedFile.refCount <= 0) {
          await s3.file(updatedFile.path).delete();
          await tx.delete(files).where(eq(files.hash, asset.fileHash));
        }

        totalFreedBytes += asset.file.size;
      }

      // Delete all trashed folders (children first by sorting by depth)
      // Sort by depth (deeper folders first) to avoid FK constraint issues
      const folderDepths = new Map<string, number>();
      
      function calculateDepth(folderId: string, depth: number = 0): number {
        const folder = trashedFolders.find(f => f.id === folderId);
        if (!folder || !folder.parentId) return depth;
        const parent = trashedFolders.find(f => f.id === folder.parentId);
        if (!parent) return depth;
        return calculateDepth(parent.id, depth + 1);
      }

      for (const folder of trashedFolders) {
        folderDepths.set(folder.id, calculateDepth(folder.id));
      }

      // Sort by depth descending (deepest first)
      const sortedFolders = [...trashedFolders].sort(
        (a, b) => (folderDepths.get(b.id) ?? 0) - (folderDepths.get(a.id) ?? 0)
      );

      for (const folder of sortedFolders) {
        await tx.delete(folders).where(eq(folders.id, folder.id));
      }
    });

    // Update storage usage
    await updateStorageUsage(userId, -totalFreedBytes);

    return {
      success: true,
      deletedFiles: trashedAssets.length,
      deletedFolders: trashedFolders.length,
      freedBytes: totalFreedBytes,
      freedBytesFormatted: formatBytes(totalFreedBytes),
      message: `Permanently deleted ${trashedAssets.length} file(s) and ${trashedFolders.length} folder(s)`,
    };
  }),

  /**
   * Rename a file
   */
  renameFile: rateLimitedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: filenameSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      const [updated] = await db
        .update(userAssets)
        .set({ name: input.name })
        .where(and(eq(userAssets.id, input.id), eq(userAssets.userId, userId)))
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found",
        });
      }

      return { success: true, asset: updated };
    }),

  /**
   * Move a file to a different folder
   */
  moveFile: rateLimitedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        folderId: z.string().uuid().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Verify target folder if specified
      if (input.folderId) {
        const targetFolder = await db.query.folders.findFirst({
          where: and(
            eq(folders.id, input.folderId),
            eq(folders.userId, userId)
          ),
        });
        if (!targetFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Target folder not found",
          });
        }
      }

      const [updated] = await db
        .update(userAssets)
        .set({ folderId: input.folderId })
        .where(and(eq(userAssets.id, input.id), eq(userAssets.userId, userId)))
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found",
        });
      }

      return { success: true };
    }),

  /**
   * Move multiple files to a different folder
   */
  moveFiles: rateLimitedProcedure
    .input(
      z.object({
        ids: z.array(z.string().uuid()).max(100, "Cannot move more than 100 files at once"),
        folderId: z.string().uuid().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Verify target folder if specified
      if (input.folderId) {
        const targetFolder = await db.query.folders.findFirst({
          where: and(
            eq(folders.id, input.folderId),
            eq(folders.userId, userId),
            isNull(folders.deletedAt)
          ),
        });
        if (!targetFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Target folder not found",
          });
        }
      }

      // Move all files
      let movedCount = 0;
      for (const id of input.ids) {
        const [updated] = await db
          .update(userAssets)
          .set({ folderId: input.folderId })
          .where(and(eq(userAssets.id, id), eq(userAssets.userId, userId)))
          .returning();
        if (updated) movedCount++;
      }

      return { success: true, movedCount };
    }),

  /**
   * Move a folder to a different parent folder
   */
  moveFolder: rateLimitedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        parentId: z.string().uuid().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Get the folder being moved
      const folder = await db.query.folders.findFirst({
        where: and(
          eq(folders.id, input.id),
          eq(folders.userId, userId),
          isNull(folders.deletedAt)
        ),
      });

      if (!folder) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Folder not found",
        });
      }

      // Cannot move folder to itself
      if (input.parentId === input.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot move folder to itself",
        });
      }

      // Verify target folder if specified
      if (input.parentId) {
        const targetFolder = await db.query.folders.findFirst({
          where: and(
            eq(folders.id, input.parentId),
            eq(folders.userId, userId),
            isNull(folders.deletedAt)
          ),
        });
        if (!targetFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Target folder not found",
          });
        }

        // Check for circular reference - target cannot be a child of the folder being moved
        async function isDescendant(ancestorId: string, checkId: string): Promise<boolean> {
          const checkFolder = await db.query.folders.findFirst({
            where: eq(folders.id, checkId),
          });
          if (!checkFolder || !checkFolder.parentId) return false;
          if (checkFolder.parentId === ancestorId) return true;
          return isDescendant(ancestorId, checkFolder.parentId);
        }

        if (await isDescendant(input.id, input.parentId)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot move folder into its own subfolder",
          });
        }
      }

      const [updated] = await db
        .update(folders)
        .set({ parentId: input.parentId })
        .where(eq(folders.id, input.id))
        .returning();

      return { success: true, folder: updated };
    }),

  /**
   * Move multiple folders to a different parent folder
   */
  moveFolders: rateLimitedProcedure
    .input(
      z.object({
        ids: z.array(z.string().uuid()).max(100, "Cannot move more than 100 folders at once"),
        parentId: z.string().uuid().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Verify target folder if specified
      if (input.parentId) {
        const targetFolder = await db.query.folders.findFirst({
          where: and(
            eq(folders.id, input.parentId),
            eq(folders.userId, userId),
            isNull(folders.deletedAt)
          ),
        });
        if (!targetFolder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Target folder not found",
          });
        }
      }

      // Helper to check circular reference
      async function isDescendant(ancestorId: string, checkId: string): Promise<boolean> {
        const checkFolder = await db.query.folders.findFirst({
          where: eq(folders.id, checkId),
        });
        if (!checkFolder || !checkFolder.parentId) return false;
        if (checkFolder.parentId === ancestorId) return true;
        return isDescendant(ancestorId, checkFolder.parentId);
      }

      let movedCount = 0;
      for (const id of input.ids) {
        // Skip if trying to move to itself
        if (input.parentId === id) continue;

        // Skip if target is a descendant of this folder
        if (input.parentId && await isDescendant(id, input.parentId)) continue;

        const folder = await db.query.folders.findFirst({
          where: and(
            eq(folders.id, id),
            eq(folders.userId, userId),
            isNull(folders.deletedAt)
          ),
        });

        if (folder) {
          await db
            .update(folders)
            .set({ parentId: input.parentId })
            .where(eq(folders.id, id));
          movedCount++;
        }
      }

      return { success: true, movedCount };
    }),

  // ============================================
  // SHARING
  // ============================================

  /**
   * Toggle public sharing for a file
   */
  togglePublic: rateLimitedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        isPublic: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);

      // Generate or clear share ID
      const publicShareId = input.isPublic ? crypto.randomUUID() : null;

      const [updated] = await db
        .update(userAssets)
        .set({
          isPublic: input.isPublic,
          publicShareId,
        })
        .where(and(eq(userAssets.id, input.id), eq(userAssets.userId, userId)))
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found",
        });
      }

      return {
        success: true,
        isPublic: updated.isPublic,
        shareUrl: updated.publicShareId
          ? `/share/${updated.publicShareId}`
          : null,
      };
    }),

  /**
   * Get public file by share ID (no auth required)
   * Increments download count
   */
  getPublicFile: publicProcedure
    .input(z.object({ shareId: z.string().uuid() }))
    .query(async ({ input }) => {
      const asset = await db.query.userAssets.findFirst({
        where: and(
          eq(userAssets.publicShareId, input.shareId),
          eq(userAssets.isPublic, true)
        ),
        with: { file: true },
      });

      if (!asset) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "File not found or is not publicly shared",
        });
      }

      // Increment download count
      await db
        .update(userAssets)
        .set({ downloadCount: sql`${userAssets.downloadCount} + 1` })
        .where(eq(userAssets.id, asset.id));

      // Generate download URL
      const downloadUrl = s3.presign(asset.file.path, {
        expiresIn: 3600,
      });

      return {
        id: asset.id,
        name: asset.name,
        size: asset.file.size,
        contentType: asset.contentType,
        downloadCount: asset.downloadCount + 1, // Include current download
        uploadDate: asset.createdAt,
        downloadUrl,
      };
    }),

  // ============================================
  // STATISTICS
  // ============================================

  /**
   * Get storage statistics for the current user
   */
  getStats: rateLimitedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    // Get user quota info
    const quota = await db.query.userQuotas.findFirst({
      where: eq(userQuotas.userId, userId),
    });

    // Calculate total original size (what user uploaded)
    const [originalStats] = await db
      .select({
        totalOriginalSize: sql<number>`COALESCE(SUM(${files.size}), 0)`,
        fileCount: count(),
      })
      .from(userAssets)
      .innerJoin(files, eq(userAssets.fileHash, files.hash))
      .where(eq(userAssets.userId, userId));

    // Calculate actual unique storage used (considering deduplication)
    // This counts each unique file only once regardless of references
    const [uniqueStats] = await db
      .select({
        uniqueSize: sql<number>`COALESCE(SUM(DISTINCT ${files.size}), 0)`,
      })
      .from(userAssets)
      .innerJoin(files, eq(userAssets.fileHash, files.hash))
      .where(eq(userAssets.userId, userId));

    // Get deduplication stats per file
    const [dedupStats] = await db
      .select({
        dedupedFiles: sql<number>`COUNT(CASE WHEN ${files.refCount} > 1 THEN 1 END)`,
        savedBytes: sql<number>`COALESCE(SUM(CASE WHEN ${files.refCount} > 1 THEN ${files.size} ELSE 0 END), 0)`,
      })
      .from(userAssets)
      .innerJoin(files, eq(userAssets.fileHash, files.hash))
      .where(eq(userAssets.userId, userId));

    const storageUsed = quota?.storageUsed ?? 0;
    const storageLimit = quota?.storageLimit ?? DEFAULT_STORAGE_LIMIT;
    const totalOriginalSize = Number(originalStats?.totalOriginalSize ?? 0);
    const actualStorageUsed = Number(uniqueStats?.uniqueSize ?? 0);
    const savedBytes = totalOriginalSize - actualStorageUsed;
    const savedPercent =
      totalOriginalSize > 0 ? (savedBytes / totalOriginalSize) * 100 : 0;

    return {
      // Quota info
      storageUsed,
      storageLimit,
      storageUsedFormatted: formatBytes(storageUsed),
      storageLimitFormatted: formatBytes(storageLimit),
      usagePercent: (storageUsed / storageLimit) * 100,

      // File counts
      totalFiles: Number(originalStats?.fileCount ?? 0),
      dedupedFiles: Number(dedupStats?.dedupedFiles ?? 0),

      // Deduplication savings
      originalSize: totalOriginalSize,
      actualStorageUsed,
      savedBytes,
      savedPercent,
      originalSizeFormatted: formatBytes(totalOriginalSize),
      actualStorageUsedFormatted: formatBytes(actualStorageUsed),
      savedBytesFormatted: formatBytes(savedBytes),

      // Rate limit
      rateLimit: quota?.rateLimit ?? DEFAULT_RATE_LIMIT,
    };
  }),

  /**
   * Get quota settings (admin use or display)
   */
  getQuota: rateLimitedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    let quota = await db.query.userQuotas.findFirst({
      where: eq(userQuotas.userId, userId),
    });

    if (!quota) {
      // Create default quota
      const [newQuota] = await db
        .insert(userQuotas)
        .values({
          userId,
          storageUsed: 0,
          storageLimit: DEFAULT_STORAGE_LIMIT,
          rateLimit: DEFAULT_RATE_LIMIT,
        })
        .returning();

      if (!newQuota) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create user quota",
        });
      }

      return {
        storageUsed: newQuota.storageUsed,
        storageLimit: newQuota.storageLimit,
        storageUsedFormatted: formatBytes(newQuota.storageUsed),
        storageLimitFormatted: formatBytes(newQuota.storageLimit),
        usagePercent: (newQuota.storageUsed / newQuota.storageLimit) * 100,
        rateLimit: newQuota.rateLimit,
      };
    }

    return {
      storageUsed: quota.storageUsed,
      storageLimit: quota.storageLimit,
      storageUsedFormatted: formatBytes(quota.storageUsed),
      storageLimitFormatted: formatBytes(quota.storageLimit),
      usagePercent: (quota.storageUsed / quota.storageLimit) * 100,
      rateLimit: quota.rateLimit,
    };
  }),

  // ============================================
  // AVATAR UPLOAD
  // ============================================

  /**
   * Get presigned URL for avatar upload
   * Avatars are stored in avatars/ prefix with user ID as key
   */
  getAvatarUploadUrl: rateLimitedProcedure
    .input(
      z.object({
        contentType: z.string().regex(/^image\/(jpeg|png|gif|webp)$/),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = getUserId(ctx);
      const key = `avatars/${userId}`;

      const url = s3.presign(key, {
        method: "PUT",
        expiresIn: 3600,
        type: input.contentType,
      });

      return {
        url,
        key,
        avatarUrl: env.R2_PUBLIC_URL ? `${env.R2_PUBLIC_URL}/${key}` : null,
      };
    }),

  /**
   * Get presigned URL for viewing the current user's avatar
   * Returns a presigned download URL for the user's avatar
   */
  getAvatarUrl: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);
    const key = `avatars/${userId}`;

      // Check if avatar exists
      const exists = await s3.file(key).exists();
      if (!exists) {
        return { avatarUrl: null };
      }

      // Generate presigned URL for viewing (1 hour expiry)
      const avatarUrl = s3.presign(key, {
        expiresIn: 3600,
      });

      return { avatarUrl };
    }),
});
