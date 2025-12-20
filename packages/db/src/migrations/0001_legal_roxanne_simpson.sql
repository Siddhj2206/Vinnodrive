ALTER TABLE "user_quotas" ALTER COLUMN "storage_limit" SET DEFAULT 1073741824;--> statement-breakpoint
ALTER TABLE "user_assets" ADD COLUMN "deleted_at" timestamp;