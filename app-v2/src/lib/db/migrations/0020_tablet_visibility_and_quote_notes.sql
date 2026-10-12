-- Two unrelated columns from the same 2026-10-12 feedback pass.
--
-- 1. quote_limit_policy.show_tablets — whether the picker offers the Orders
--    Hub and Clock-in tablets at all. DEFAULT FALSE, which hides them: nobody
--    is selling them today ("Delete tablet options", Elizabeth Phillips), but
--    the use case she names in the same breath is why this is a switch rather
--    than a deletion. Visibility only: it never refuses a quote that already
--    carries one. See TABLET_PRODUCT_IDS in quoting.ts.
--
-- 2. merchant_applications.quote_note — the rep's own note on this quote,
--    mirrored onto the HubSpot deal as a note. Nullable, because almost every
--    existing row has nothing to say; it becomes REQUIRED only when a rep
--    pushes a recurring line's first charge past the 60-day default, which is
--    the one case where "why" has to survive the rep who decided it.
ALTER TABLE "quote_limit_policy"
  ADD COLUMN IF NOT EXISTS "show_tablets" boolean DEFAULT false NOT NULL;

ALTER TABLE "merchant_applications"
  ADD COLUMN IF NOT EXISTS "quote_note" text;
