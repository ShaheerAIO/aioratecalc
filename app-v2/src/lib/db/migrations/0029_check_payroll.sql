-- Check payroll billing (2026-10-23): the hidden /admin/payroll-billing page
-- turns Check's monthly usage export into draft HubSpot invoices. Additive only.
CREATE TABLE IF NOT EXISTS "check_company_links" (
  "check_company_id" text PRIMARY KEY NOT NULL,
  "check_company_name" text NOT NULL,
  "hubspot_company_id" text NOT NULL,
  "hubspot_company_name" text NOT NULL,
  "linked_by" text,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "check_payroll_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "check_company_id" text NOT NULL,
  "period_start" date NOT NULL,
  "employee_count" integer NOT NULL,
  "amount" numeric(10, 2) NOT NULL,
  "hubspot_company_id" text NOT NULL,
  "contact_id" text NOT NULL,
  "deal_id" text,
  "line_item_id" text,
  "hubspot_invoice_id" text,
  "invoiced_at" timestamp with time zone,
  "last_error" text,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "check_payroll_invoices_company_period"
  ON "check_payroll_invoices" ("check_company_id", "period_start");
