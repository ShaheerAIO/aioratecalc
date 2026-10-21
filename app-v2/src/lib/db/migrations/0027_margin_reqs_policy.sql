-- Admin-editable margin table (2026-10-21, product owner): MARGIN_REQS' min /
-- desired / max margin per volume band, edited beside the rate matrix at
-- /admin/settings/rate-matrix. Additive only.
--
-- Its own table rather than a column on rate_matrix_policy: a database that has
-- not run this migration can then only lose THIS policy (loadMarginReqs falls
-- back to the constants in pricing.ts), never the saved rate card.
--
-- Seeded EMPTY, same posture as every other *_policy table: no row means "use
-- MARGIN_REQS". `rows` is [{minBps, desiredBps, maxBps}] x 9, in the band order
-- of RATE_MATRIX_VOLUME_BANDS; whole basis points (85 = 0.85%).
--
-- quote_limit_policy needs no change for the per-product discount caps: its
-- discount_caps jsonb (migration 0025) already holds productId -> percent.
-- quote_limit_policy.min_rate_margin_bps (0026) is left in place, unused.
CREATE TABLE IF NOT EXISTS "margin_reqs_policy" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rows" jsonb NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL
);
