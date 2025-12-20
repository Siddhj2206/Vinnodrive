import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

// Files table - stores actual file content metadata (deduplicated)
// Each unique file content is stored once, identified by SHA-256 hash
export const files = pgTable(
  "files",
  {
    hash: text("hash").primaryKey(), // SHA-256 hash of file content
    size: bigint("size", { mode: "number" }).notNull(), // File size in bytes
    path: text("path").notNull(), // S3 object key/path
    refCount: integer("ref_count").notNull().default(1), // Number of references to this file
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("files_ref_count_idx").on(table.refCount)]
);

// Folders table - user's folder structure
export const folders = pgTable(
  "folders",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    parentId: text("parent_id"), // Self-referencing for nested folders
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at"), // Soft delete for trash feature
  },
  (table) => [
    index("folders_user_id_idx").on(table.userId),
    index("folders_parent_id_idx").on(table.parentId),
    index("folders_deleted_at_idx").on(table.deletedAt),
  ]
);

// UserAssets table - links users to files (many-to-many with metadata)
export const userAssets = pgTable(
  "user_assets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(), // User-visible filename
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    fileHash: text("file_hash")
      .notNull()
      .references(() => files.hash, { onDelete: "restrict" }),
    isPublic: boolean("is_public").notNull().default(false),
    publicShareId: text("public_share_id"), // Unique share link ID
    downloadCount: integer("download_count").notNull().default(0),
    deletedAt: timestamp("deleted_at"), // Soft delete for trash feature
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("user_assets_user_id_idx").on(table.userId),
    index("user_assets_folder_id_idx").on(table.folderId),
    index("user_assets_file_hash_idx").on(table.fileHash),
    uniqueIndex("user_assets_public_share_id_idx").on(table.publicShareId),
  ]
);

// User storage quotas and rate limiting tracking
export const userQuotas = pgTable("user_quotas", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  storageUsed: bigint("storage_used", { mode: "number" }).notNull().default(0), // Bytes used (after dedup)
  storageLimit: bigint("storage_limit", { mode: "number" })
    .notNull()
    .default(1 * 1024 * 1024 * 1024), // 1GB default
  rateLimit: integer("rate_limit").notNull().default(2), // API calls per second
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

// Rate limiting window tracking
export const rateLimitWindows = pgTable(
  "rate_limit_windows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start").notNull(),
    requestCount: integer("request_count").notNull().default(1),
  },
  (table) => [
    index("rate_limit_user_window_idx").on(table.userId, table.windowStart),
  ]
);

// Relations
export const filesRelations = relations(files, ({ many }) => ({
  userAssets: many(userAssets),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
  user: one(user, {
    fields: [folders.userId],
    references: [user.id],
  }),
  parent: one(folders, {
    fields: [folders.parentId],
    references: [folders.id],
    relationName: "folderHierarchy",
  }),
  children: many(folders, {
    relationName: "folderHierarchy",
  }),
  assets: many(userAssets),
}));

export const userAssetsRelations = relations(userAssets, ({ one }) => ({
  user: one(user, {
    fields: [userAssets.userId],
    references: [user.id],
  }),
  folder: one(folders, {
    fields: [userAssets.folderId],
    references: [folders.id],
  }),
  file: one(files, {
    fields: [userAssets.fileHash],
    references: [files.hash],
  }),
}));

export const userQuotasRelations = relations(userQuotas, ({ one }) => ({
  user: one(user, {
    fields: [userQuotas.userId],
    references: [user.id],
  }),
}));

export const rateLimitWindowsRelations = relations(
  rateLimitWindows,
  ({ one }) => ({
    user: one(user, {
      fields: [rateLimitWindows.userId],
      references: [user.id],
    }),
  })
);
