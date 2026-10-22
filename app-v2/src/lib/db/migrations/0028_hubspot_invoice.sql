-- The one-time invoice (2026-10-22, product owner): hardware, install and
-- training move off the HubSpot quote onto a HubSpot invoice created right
-- after acceptance. Additive only; null until an invoice is built.
--
-- Its own column rather than a key inside hubspot_ids: several paths rewrite
-- hubspot_ids whole from a copy read earlier, and losing the invoice id to one
-- of them would let a retry bill the merchant a second time. Only
-- lib/billing/oneTimeInvoice.ts writes this column.
ALTER TABLE "merchant_applications" ADD COLUMN IF NOT EXISTS "hubspot_invoice" jsonb;
