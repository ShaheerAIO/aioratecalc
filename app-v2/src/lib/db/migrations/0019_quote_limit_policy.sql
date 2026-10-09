-- Admin-owned limits on what a rep may put on a quote (2026-10-09):
--   * how many of each product -- the quantity box now takes a TYPED number,
--     so a rep can enter 25 without pressing + twenty-five times, and a box
--     that accepts 25 also accepts 250.
--   * how long billing may be delayed before an admin has to approve it. The
--     "approval" is an admin raising this number, exactly the way the discount
--     cap in margin_policy already works -- deliberately not a request queue.
--
-- Seeded EMPTY on purpose. getQuoteLimits() falls back to DEFAULT_UNIT_CAPS /
-- DEFAULT_MAX_APPROVED_DELAY_DAYS in quoting.ts when there is no row, so an
-- unseeded table can never block a quote and never silently uncaps one either
-- -- the same posture quote_template_policy takes. An admin saving at
-- /admin/settings/quote-limits writes the first row, pre-filled from those
-- same defaults.
CREATE TABLE IF NOT EXISTS "quote_limit_policy" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "unit_caps" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "max_billing_delay_days" integer DEFAULT 90 NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL
);
