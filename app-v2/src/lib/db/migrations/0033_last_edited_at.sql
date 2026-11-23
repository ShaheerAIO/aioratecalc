-- "Last edited" column on the dashboard (2026-11-11, product owner). Stamped
-- only by the staff edit actions (never webhooks, provisioning, link sends or
-- customer actions). Additive and nullable.
ALTER TABLE "merchant_applications" ADD COLUMN IF NOT EXISTS "last_edited_at" timestamp with time zone;
-- Backfill from updated_at: the closest existing signal of "last touched".
-- It over-states edits (webhooks bumped it too), but created_at would claim
-- nothing was ever edited; either is an approximation for pre-existing rows.
UPDATE "merchant_applications" SET "last_edited_at" = "updated_at" WHERE "last_edited_at" IS NULL;
