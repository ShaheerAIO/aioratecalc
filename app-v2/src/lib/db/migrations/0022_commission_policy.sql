-- MIGRATION 0022 — commission_policy (2026-10-13). See lib/commission.ts and
-- lib/db/schema.ts's commissionPolicy table comment for the full reasoning.
--
-- Holds exactly ONE admin-configurable rate: hardware commission, in whole
-- basis points, nullable. NULL is the seeded/default state and means
-- "unset -- contributes exactly zero" (lib/commission.ts's hardwareCommission
-- function), because the product owner asked for this on 10/13 but has not
-- given a rate yet. The processing-commission split (5% signing / 5%
-- activation, off total ARR) is NOT a column here -- it's a fixed constant in
-- lib/commission.ts, because it mirrors a split HubSpot's own automation
-- already computes natively on ~700 live deals, not a number an admin tunes.
CREATE TABLE IF NOT EXISTS "commission_policy" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hardware_commission_bps" integer,
  "updated_by_user_id" uuid REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL
);
