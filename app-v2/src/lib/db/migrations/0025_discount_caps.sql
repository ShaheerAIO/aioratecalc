-- Per-product discount caps (2026-10-15, product owner: "make max discounts
-- per line item instead of a global"). Mirrors quote_limit_policy.unit_caps
-- exactly -- same jsonb shape, same seeding/fallback posture, same reason:
-- product ids are an open set maintained in HubSpot by non-engineers, so a
-- new product must be cappable without a deploy.
--
-- margin_policy.max_discount_percent is NOT replaced or removed -- it stays
-- as the FALLBACK for any product absent from this map, and as the standing
-- approval lever ("raising it is how a discount over 50% gets approved").
-- A product with no row here is still capped by something.
--
-- Seeded EMPTY, same as unit_caps: getQuoteLimits() falls back to an empty
-- map (no per-product cap, so the global applies) when there is no row, so an
-- unseeded table can never block a quote.
ALTER TABLE "quote_limit_policy"
  ADD COLUMN IF NOT EXISTS "discount_caps" jsonb DEFAULT '{}'::jsonb NOT NULL;
