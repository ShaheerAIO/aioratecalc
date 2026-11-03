-- Draft quotes + admin override approval (2026-11-02). Additive and nullable;
-- quote_status null = live, so every pre-existing row is unchanged.
ALTER TABLE "merchant_applications" ADD COLUMN IF NOT EXISTS "quote_status" text;
ALTER TABLE "merchant_applications" ADD COLUMN IF NOT EXISTS "quote_approval" jsonb;
ALTER TABLE "merchant_applications" ADD COLUMN IF NOT EXISTS "pending_deal_choice" jsonb;
