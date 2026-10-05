-- The quote types became plans (2026-10-05): "full_pos" and "food_truck" are
-- retired, "order_pay_only" and "all_in_one" replace them, and each one now
-- names one monthly HubSpot platform product instead of an order-point tier.
--
-- Renames rather than drop/add: the two ids are the same HubSpot templates,
-- only the EasyOB-side key changed. The table holds no rows today (and never
-- more than one), so either would work — a rename says what happened.
--
-- merchant_applications.quote_type needs no migration: it is plain text with
-- no check constraint, the retired values stay on the rows that carry them,
-- and quoteTypeOf() maps them to a live plan on read.
ALTER TABLE "quote_template_policy" RENAME COLUMN "full_pos_template_id" TO "all_in_one_template_id";--> statement-breakpoint
ALTER TABLE "quote_template_policy" RENAME COLUMN "food_truck_template_id" TO "order_pay_only_template_id";
