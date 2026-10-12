-- The card-present rate card (2026-10-12): monthly volume x average ticket ->
-- the rate a rep is offered, from AIO-Restaurant-Payment-Pricing-Guide §10.3
-- (the $0.15/transaction option, which §10.5 names the recommended default).
--
-- Until now every quote started at a flat 2.49% + $0.15, with a comment on
-- DEFAULT_QUOTE_RATES saying so: "a flat default rather than a lookup because
-- the ticket-size x volume matrix that should choose the rate doesn't exist
-- yet". This is that matrix. The flat default STAYS as the fallback for a
-- quote with no volume and no ticket behind it.
--
-- Only the NUMBERS are stored. Which nine volume bands and which nine ticket
-- columns the card has lives in code (RATE_MATRIX_VOLUME_BANDS /
-- RATE_MATRIX_TICKETS in lib/rateMatrix.ts), because the volume bands must
-- stay identical to MARGIN_REQS' -- the matrix prices off a tier's desired
-- margin and the floor check runs against that same tier.
--
-- Seeded EMPTY on purpose, the same posture quote_limit_policy and
-- quote_template_policy take: getRateMatrix() falls back to
-- DEFAULT_RATE_MATRIX when there is no row, so an unseeded settings table can
-- never leave a rep with no rate to quote. An admin saving at
-- /admin/settings/rate-matrix writes the first row, pre-filled from the guide.
CREATE TABLE IF NOT EXISTS "rate_matrix_policy" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_present_bps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "card_not_present_bps" integer DEFAULT 330 NOT NULL,
  "per_transaction_fee_cents" integer DEFAULT 15 NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL
);
