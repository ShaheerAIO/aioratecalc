-- Foodbuy send (2026-10-26): the Foodbuy rep's address, set from /admin/users,
-- that a customer's enrollment PDF is emailed to. Additive only.
CREATE TABLE IF NOT EXISTS "foodbuy_policy" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rep_email" text,
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL
);
