-- Payment plan (2026-10-26): how the merchant pays the one-time invoice,
-- chosen on /lead/[token]/payment before they confirm their details.
-- 'full' (5% off), '2' or '4' monthly installments. Additive and nullable;
-- written only by savePaymentPlanAction, so it is not in appToRow.
ALTER TABLE "merchant_applications" ADD COLUMN IF NOT EXISTS "payment_plan" text;
ALTER TABLE "merchant_applications" ADD COLUMN IF NOT EXISTS "payment_plan_at" timestamp with time zone;
