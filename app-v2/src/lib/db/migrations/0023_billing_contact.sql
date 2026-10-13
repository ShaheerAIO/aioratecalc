-- MIGRATION 0023 — billing_contact (2026-10-13). See types/merchant.ts's
-- billingContact comment and lib/db/schema.ts's column comment.
--
-- Who AIO bills / sends subscription paperwork to, if different from
-- ownerContact ("add billing contact" / "overwrite the billing contact in
-- hs", 10/13 notes). Same jsonb-blob shape as owner_contact, nullable, and
-- null on every existing row and on every row where the rep never set one.
ALTER TABLE "merchant_applications" ADD COLUMN "billing_contact" jsonb;
