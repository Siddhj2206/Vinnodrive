ALTER TABLE "folders" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE INDEX "folders_deleted_at_idx" ON "folders" USING btree ("deleted_at");