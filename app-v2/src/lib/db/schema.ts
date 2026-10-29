import { pgTable, uuid, text, timestamp, boolean, integer, numeric, jsonb, serial, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { ReportAnomalies } from "@/lib/adyen/paymentsAccountingParser";
import type {
  StatementAnalysis,
  ProposalOutput,
  BusinessInfo,
  OwnerContact,
  ProcessingInfo,
  AgreementInfo,
  Processor,
  AppSettings,
  MerchantApplication,
  CustomerSubmission,
} from "@/types/merchant";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // Staff no longer sign in with a password — Entra ID does that (see
  // lib/auth/entra.ts). Still populated for two cases: customers, who set
  // their own password after a magic-link signup, and the admin breakglass
  // (/login/breakglass) that keeps /admin reachable if Entra is unavailable.
  passwordHash: text("password_hash"),
  name: text("name").notNull(),
  role: text("role", { enum: ["rep", "admin", "customer"] }).notNull(),
  // The Entra directory object id (`oid`) this staff row is bound to, stamped
  // on first successful Entra sign-in. Immutable and tenant-scoped, unlike
  // email/UPN — so once linked, a rename in Entra still resolves to this row.
  // Unique: two Entra identities must never claim one account. Null means
  // "not linked yet" (a row an admin pre-created, or a customer).
  entraOid: text("entra_oid").unique(),
  entraLinkedAt: timestamp("entra_linked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
});

// Global, admin-controlled padding policy — the padding applied to the true
// margin floor / Adyen cost before a rep is allowed to see it. See pricing.ts.
export const marginPolicy = pgTable("margin_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  paddingBps: integer("padding_bps").notNull().default(20),
  paddingMinMrrAdd: numeric("padding_min_mrr_add", { precision: 10, scale: 2 }).notNull().default("0"),
  paddingAdyenCostHide: boolean("padding_adyen_cost_hide").notNull().default(true),
  // The most a rep may discount a single quote line. Lives here rather than in
  // its own table because margin_policy is already "the global, admin-owned
  // policy limiting what a rep can do with AIO's margin" — concealing the floor
  // and capping the giveaway are two halves of the same guardrail.
  maxDiscountPercent: integer("max_discount_percent").notNull().default(50),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

// Global, admin-controlled mapping from EasyOB's QuoteType to the HubSpot
// quote_template a Phase E quote is created against (v4 association typeId
// 286). Mirrors margin_policy's shape (single active row, admin-owned).
// Explicit per-QuoteType columns rather than a jsonb blob: QuoteType is a
// closed, rarely-changing 3-value enum, so a column per type gives a
// compile-time-checked, never-optional slot for each one — a new QuoteType
// requires a migration (visible, forces a decision) instead of silently
// falling through a jsonb key that was never populated.
export const quoteTemplatePolicy = pgTable("quote_template_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Renamed from full_pos_template_id / food_truck_template_id in migration
  // 0016, when the quote types became plans. Exactly what the comment above
  // predicted: a changed QuoteType forces a migration rather than silently
  // falling through a jsonb key nobody populated.
  allInOneTemplateId: text("all_in_one_template_id").notNull().default("817263673055"),
  orderPayOnlyTemplateId: text("order_pay_only_template_id").notNull().default("817263673055"),
  marketingOnlyTemplateId: text("marketing_only_template_id").notNull().default("817697352408"),
  // Added in migration 0017, when the marketing plan split into $199 and the
  // $299 2-year term. Same template as the $199 plan by default — the document
  // reads identically, only the plan line and the included kiosk differ.
  // UNREAD since 2026-10-27, when the plan was retired; left in place rather
  // than dropped, like `min_rate_margin_bps`.
  marketingTermTemplateId: text("marketing_term_template_id").notNull().default("817697352408"),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

// Global, admin-controlled limits on what a rep may put on a quote: how many
// of each product, and how long billing may be delayed. Mirrors
// margin_policy's shape (single active row, admin-owned).
//
// NOT folded into margin_policy, which is specifically "what a rep may learn
// about, or give away of, AIO's margin". A quantity ceiling is neither — it
// catches a typo in a quantity box, and the delay ceiling is a commitment
// question, not a margin one.
//
// unit_caps is jsonb where quote_template_policy uses one column per key, and
// the difference is deliberate: QuoteType is a closed three-value enum, so a
// column per type forces a migration when it changes. Product ids are an open
// set maintained in HubSpot by non-engineers, so a new product must be
// cappable without a deploy.
export const quoteLimitPolicy = pgTable("quote_limit_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  // productId → the most of it one quote may carry. A product absent from the
  // map is uncapped; see DEFAULT_UNIT_CAPS, which seeds the editor and is what
  // an unseeded table falls back to.
  unitCaps: jsonb("unit_caps").$type<Record<string, number>>().notNull().default({}),
  // productId → the most that LINE may be discounted, as a whole percent.
  // Added migration 0025 (2026-10-15, product owner: "make max discounts per
  // line item instead of a global"). A product absent from the map falls back
  // to `margin_policy.maxDiscountPercent` — that global did not go away, it
  // became the DEFAULT for anything not listed here, because a product absent
  // from this map still has to be capped by something. Same jsonb-over-column
  // reasoning as unitCaps: the catalog is an open set maintained in HubSpot by
  // non-engineers, so a new product must be cappable without a deploy.
  discountCaps: jsonb("discount_caps").$type<Record<string, number>>().notNull().default({}),
  // `min_rate_margin_bps` (migration 0026) still exists in the database but is
  // no longer read or written: the minimum-rate floor was removed 2026-10-21.
  // The longest billing delay a rep may set without an admin raising it.
  maxBillingDelayDays: integer("max_billing_delay_days").notNull().default(90),
  // Whether the picker offers the two tablets. A visibility switch, not a
  // cap — see TABLET_PRODUCT_IDS in quoting.ts for why it is neither a
  // deletion nor a refusal. Default false: nobody sells them today.
  showTablets: boolean("show_tablets").notNull().default(false),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

// The card-present rate card — monthly volume × average ticket → the rate a
// rep is offered. Structure (which nine volume bands, which nine ticket
// columns) lives in code as RATE_MATRIX_VOLUME_BANDS / RATE_MATRIX_TICKETS;
// only the NUMBERS are editable, which is what "show that same table and have
// the values editable" asks for and is why one jsonb holds the whole grid.
//
// Its own table rather than more columns on margin_policy for the reason that
// one already states: margin_policy is what a rep may LEARN about, or GIVE
// AWAY of, AIO's margin. A rate card is neither — every figure on it is
// printed on the merchant's own quote.
//
// Seeded empty, like quote_limit_policy: getRateMatrix() falls back to
// DEFAULT_RATE_MATRIX (the pricing guide §10.3), so an unseeded table can
// never leave a rep with no rate to quote.
export const rateMatrixPolicy = pgTable("rate_matrix_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Row-major [volumeBand][ticketColumn], whole basis points. Bps because
  // every figure on AIO's rate card is a two-decimal percentage, which is
  // exact in bps and is not in a float — on a document nobody can amend.
  cardPresentBps: jsonb("card_present_bps").$type<number[][]>().notNull().default([]),
  cardNotPresentBps: integer("card_not_present_bps").notNull().default(330),
  perTransactionFeeCents: integer("per_transaction_fee_cents").notNull().default(15),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

// The margin table (MARGIN_REQS' min / desired / max per volume band), made
// admin-editable on the rate-matrix page (2026-10-21, migration 0027). Its own
// table, not a column on rate_matrix_policy, so a database that hasn't run the
// migration can only lose THIS (falls back to the constants in pricing.ts) and
// never the saved rate card. `rows` is [{minBps, desiredBps, maxBps}] x 9, in
// the same band order as RATE_MATRIX_VOLUME_BANDS. TRUE margin floors: read
// only server-side via lib/marginReqsLoader.ts, never sent to a rep.
export const marginReqsPolicy = pgTable("margin_reqs_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  rows: jsonb("rows").$type<{ minBps: number; desiredBps: number; maxBps: number }[]>().notNull(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

// Admin-controlled commission rates (2026-10-13, migration 0022). The
// processing-commission split — 5% at signing, 5% at activation, each off
// total ARR — is NOT stored here: it's a FIXED constant in lib/commission.ts,
// because it mirrors a split HubSpot's own automation already computes
// natively on ~700 live deals (product owner, 2026-10-13), not a number an
// admin gets to tune. The ONE rate this table holds is hardware commission,
// because the product owner has not given it yet: nullable, and null means
// "contributes exactly zero" — see `hardwareCommission` in lib/commission.ts,
// and that file's module comment for why hardware MARGIN (the thing this rate
// is a percentage of) isn't computable at all today regardless of this rate.
// Its own table rather than a column on margin_policy, for the same reason
// rate_matrix_policy and quote_limit_policy get their own: this is neither
// "what a rep may learn of AIO's margin" nor "what a rep may give away of
// it" — a commission rate for a different purpose entirely. Single active
// row, admin-owned, same shape as every other *_policy table here.
export const commissionPolicy = pgTable("commission_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Whole basis points (500 = 5.00%), same convention as rate_matrix_policy —
  // every commission figure here is a two-decimal percentage, exact in bps
  // and not in a float, feeding a number that pays people. NULL = unset.
  hardwareCommissionBps: integer("hardware_commission_bps"),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

// Where a customer's Foodbuy enrollment PDF is emailed when they press "Send
// to Foodbuy" (api/customer/applications/[id]/foodbuy/send). Set from the
// drawer on /admin/users. Its own table for the same reason as every other
// *_policy table here; single active row, admin-owned. NULL = not set up,
// and the send refuses rather than guessing a recipient.
export const foodbuyPolicy = pgTable("foodbuy_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  repEmail: text("rep_email"),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

// Replaces localStorage "clearrate:settings" / "clearrate:adyen_config".
export const appSettings = pgTable("app_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  processors: jsonb("processors").$type<Processor[]>().notNull(),
  adyenConfig: jsonb("adyen_config").$type<AppSettings["adyenConfig"] | null>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Replaces localStorage "aio_applications". owner_user_id is the REP who
// owns this deal — distinct from ownerContact (the merchant's own business
// contact person, stored in the ownerContact jsonb column below).
export const merchantApplications = pgTable("merchant_applications", {
  id: text("id").primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  // Set once the customer completes magic-link signup from the lead page —
  // distinct from ownerUserId (the rep) and ownerContact (contact info blob).
  customerUserId: uuid("customer_user_id").references(() => users.id),
  stage: text("stage").notNull(),
  hubspotDealId: text("hubspot_deal_id"),
  // How this application got hubspotDealId — adopted an existing deal, or
  // EasyOB created one. Null (every pre-adoption row) is read as "adopted"
  // by buildDealProperties. See DealLink.
  dealLink: jsonb("deal_link").$type<MerchantApplication["dealLink"]>(),
  // Phase 3 — links this ezacc to the HubSpot Company (AIO tenant). See TenantLink.
  tenantLink: jsonb("tenant_link").$type<MerchantApplication["tenantLink"]>(),
  adyenIds: jsonb("adyen_ids").$type<MerchantApplication["adyenIds"]>(),
  adyenOnboardingUrl: text("adyen_onboarding_url"),
  // The AIO platform tenant this merchant was provisioned into, and the cron's
  // lease/retry bookkeeping. See AioTenantIds — everything in it is
  // irreversible on AIO's side, so the provisioner leans on it for idempotency.
  aioTenant: jsonb("aio_tenant").$type<MerchantApplication["aioTenant"]>(),
  // Check payroll onboarding. No matching *_onboarding_url column on purpose —
  // Check's onboard links are one-time use / 24h, so they're minted per click
  // and never stored (see src/lib/adapters/check.ts).
  checkIds: jsonb("check_ids").$type<MerchantApplication["checkIds"]>(),
  // Foodbuy enrollment — same posture as checkIds (opt-in, link minted per
  // click, never stored). See src/lib/adapters/foodbuy.ts.
  foodbuyIds: jsonb("foodbuy_ids").$type<MerchantApplication["foodbuyIds"]>(),
  // HubSpot billing. No stored checkout URL beyond hs_quote_link inside the blob,
  // and that one is re-readable from HubSpot rather than authoritative here.
  // We never write the subscription or its recurring invoices — HubSpot creates
  // both when the customer pays the quote (see E2E-PLAN.md). The ONE invoice
  // EasyOB writes is the one-time invoice, in `hubspotInvoice` below.
  hubspotIds: jsonb("hubspot_ids").$type<MerchantApplication["hubspotIds"]>(),
  // The one-time invoice (migration 0028). Written ONLY by
  // lib/billing/oneTimeInvoice.ts, never by appToRow — see HubspotInvoice.
  hubspotInvoice: jsonb("hubspot_invoice").$type<MerchantApplication["hubspotInvoice"]>(),
  // What kind of quote this is — it decides which products may be on it, which
  // platform line was derived, and whether there's a processing rate at all.
  // Nullable because rows predate quote types. "full_pos"/"food_truck" are the
  // retired pre-2026-10-05 values, still on existing rows and still readable;
  // `quoteTypeOf` maps them onto a live plan. Plain text, not a PG enum, so
  // this list is TypeScript-side only and needs no migration.
  quoteType: text("quote_type", {
    enum: [
      "order_pay_only", "all_in_one", "marketing_only", "marketing_partial",
      "marketing_term", "full_pos", "food_truck",
    ],
  }),
  // The rep-entered ticket/volume basis for a quote built without a statement.
  quoteConfig: jsonb("quote_config").$type<MerchantApplication["quoteConfig"]>(),
  // Quote lines, priced at quote time. Prices are per BILLING CYCLE, never per
  // month — see BillingFrequency. Monthly on today's plans, weekly on the
  // published quotes that predate them.
  quoteLines: jsonb("quote_lines").$type<MerchantApplication["quoteLines"]>(),
  // The quoted ordering-point count. It no longer selects anything — the plan
  // sets the platform fee — but it belongs to the same frozen-at-publish
  // bucket as quoteConfig/quoteLines, and the later quoted-vs-deployed
  // comparison depends on it not moving.
  orderPoints: jsonb("order_points").$type<MerchantApplication["orderPoints"]>(),
  // Set once, when the customer accepts the quote on the customer quote view.
  // Frozen alongside quoteConfig/quoteLines — the record of what was agreed,
  // not a piece of live deal state (that's `stage`).
  quoteAcceptedAt: timestamp("quote_accepted_at", { withTimezone: true }),
  // Set once, when the MERCHANT confirms their own details on the public lead
  // link — which is what authorises the HubSpot quote to be built at all.
  // Earlier than both `quoteAcceptedAt` above and `hubspotIds.publishedAt`,
  // and the marker the rep's quote editor freezes on first.
  detailsConfirmedAt: timestamp("details_confirmed_at", { withTimezone: true }),
  // LEGACY, unread and unwritten since 2026-10-28 (payment step removed; every
  // invoice offers Affirm). Column kept: no migration — see hubspot-billing.md.
  paymentPlan: text("payment_plan"),
  paymentPlanAt: timestamp("payment_plan_at", { withTimezone: true }),
  // The rep's note on this quote, mirrored onto the HubSpot deal. Nullable:
  // most quotes have nothing to say. It becomes REQUIRED only when a first
  // charge doesn't sit on the plan's own default — see `quoteNoteBlockers`.
  quoteNote: text("quote_note"),
  analysis: jsonb("analysis").$type<StatementAnalysis | null>(),
  proposal: jsonb("proposal").$type<ProposalOutput | null>(),
  business: jsonb("business").$type<BusinessInfo | null>(),
  ownerContact: jsonb("owner_contact").$type<OwnerContact | null>(),
  // Who AIO bills, if different from ownerContact — see MerchantApplication's
  // own comment on billingContact. Added migration 0023; null on every row
  // before it and on every row where the rep never set one.
  billingContact: jsonb("billing_contact").$type<MerchantApplication["billingContact"]>(),
  processing: jsonb("processing").$type<ProcessingInfo | null>(),
  agreement: jsonb("agreement").$type<AgreementInfo | null>(),
  // What a 2-tier quote is priced on since 2026-10-06: both card rates and the
  // per-transaction fee, as the merchant reads them. jsonb rather than three
  // numeric columns because they are one decision and always move together —
  // and because the ticket × volume matrix that will eventually suggest them
  // may add terms. Null on rows written before, read through `ratesFor()`.
  quoteRates: jsonb("quote_rates").$type<MerchantApplication["quoteRates"]>(),
  // SUPERSEDED by quoteRates as the pricing input. Kept, not dropped: every
  // row written before 2026-10-06 carries one, and the margin work this was
  // built for is deferred rather than cancelled.
  targetMargin: numeric("target_margin", { precision: 8, scale: 6 }),
  pricingModel: text("pricing_model"),
  // Generalized replacement for the old single-purpose merchantLinkToken/
  // merchantLinkSentAt/merchantLinkExpiry fields: one token slot can't serve
  // both the pre-analysis lead-upload link and the post-proposal Adyen KYC
  // handoff link without colliding, hence the purpose discriminator.
  customerLinkToken: text("customer_link_token").unique(),
  customerLinkPurpose: text("customer_link_purpose", { enum: ["lead_upload", "kyc_handoff"] }),
  customerLinkSentAt: timestamp("customer_link_sent_at", { withTimezone: true }),
  customerLinkExpiresAt: timestamp("customer_link_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Legacy/retired: the old fully-anonymous self-serve flow (customer.html
// equivalent). Kept for historical data only — no new writes after cutover
// to the rep-initiated prospect flow.
export const customerSubmissions = pgTable("customer_submissions", {
  id: serial("id").primaryKey(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  contactInfo: jsonb("contact_info").$type<CustomerSubmission["contactInfo"]>().notNull(),
  analysis: jsonb("analysis").$type<StatementAnalysis>(),
  quote: jsonb("quote").$type<CustomerSubmission["quote"]>(),
});

// ── Phase G: Adyen actuals ingest ──────────────────────────────────────────
// Aggregated at ingest — never per-transaction rows, never the raw CSV.
// Money follows the rest of the schema: numeric with scale 2, in dollars.

// Staging aggregate, one row per (report file, tenant, day of sale).
// The report filename is part of the key on purpose: a daily file is written on
// a BOOKING-date basis but we roll up on DAY OF SALE, so one file can carry rows
// dated to earlier days. Keying on (tenant, day) alone would let one file's
// partial spill overwrite another file's totals for the same day. Keyed this way,
// reprocessing file F is "delete where filename = F, re-insert" — a clean
// recompute with no double count and no collateral damage. ~44 tenants × a
// couple of sale dates per file, so the volume is trivial.
export const merchantDailyActuals = pgTable("merchant_daily_actuals", {
  id: uuid("id").primaryKey().defaultRandom(),
  reportFilename: text("report_filename").notNull(),
  tenantNumber: text("tenant_number").notNull(),
  saleDate: date("sale_date").notNull(),
  month: text("month").notNull(), // "YYYY-MM", derived from saleDate
  grossVolume: numeric("gross_volume", { precision: 14, scale: 2 }).notNull(),
  transactionCount: integer("transaction_count").notNull(),
  aioCommission: numeric("aio_commission", { precision: 14, scale: 2 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("merchant_daily_actuals_file_tenant_day_key").on(t.reportFilename, t.tenantNumber, t.saleDate),
  // Serves the month re-sum in actualsIngest.recomputeMonth().
  index("merchant_daily_actuals_tenant_month_idx").on(t.tenantNumber, t.month),
]);

// What the admin comparison view reads: gross volume, transaction count and
// AIO's commission per tenant per month (average ticket = volume ÷ count).
// Always SET from a full re-sum of merchant_daily_actuals, never incremented.
export const merchantMonthlyActuals = pgTable("merchant_monthly_actuals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantNumber: text("tenant_number").notNull(),
  month: text("month").notNull(), // "YYYY-MM"
  grossVolume: numeric("gross_volume", { precision: 14, scale: 2 }).notNull(),
  transactionCount: integer("transaction_count").notNull(),
  aioCommission: numeric("aio_commission", { precision: 14, scale: 2 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("merchant_monthly_actuals_tenant_month_key").on(t.tenantNumber, t.month),
]);

// Which report files we've already ingested. Webhooks duplicate and reports get
// refetched, so this makes a re-delivery a no-op; it also lets the nightly cron
// backstop ask "which expected days are missing?". Written LAST in the ingest,
// so a crash mid-ingest leaves the file unrecorded and it is simply retried.
export const adyenProcessedReports = pgTable("adyen_processed_reports", {
  filename: text("filename").primaryKey(),
  reportDate: date("report_date"),
  rowCount: integer("row_count").notNull(),
  transactionCount: integer("transaction_count").notNull(),
  anomalies: jsonb("anomalies").$type<ReportAnomalies | null>(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Short-lived, single-use passwordless login tokens for the customer role.
// applicationId ties a signup token (from the lead page) to the specific
// deal it should attach to; login tokens requested from /customer/login
// have no applicationId (the customer may have multiple applications).
export const customerLoginTokens = pgTable("customer_login_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  applicationId: text("application_id").references(() => merchantApplications.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Check payroll billing (2026-10-23) — see docs/claude/check-payroll-billing.md.
// Check's usage export names companies by their LEGAL name, which rarely
// matches the HubSpot company, so an admin confirms each pairing once and it
// is remembered here for every later month.
export const checkCompanyLinks = pgTable("check_company_links", {
  checkCompanyId: text("check_company_id").primaryKey(),
  checkCompanyName: text("check_company_name").notNull(),
  hubspotCompanyId: text("hubspot_company_id").notNull(),
  hubspotCompanyName: text("hubspot_company_name").notNull(),
  linkedBy: text("linked_by"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per company per billed month: the double-billing guard. Claimed
// before the first HubSpot write and every id persisted as it is created, so a
// rerun resumes instead of creating a second invoice. `invoicedAt` is set only
// once the draft invoice is fully associated.
export const checkPayrollInvoices = pgTable("check_payroll_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkCompanyId: text("check_company_id").notNull(),
  periodStart: date("period_start").notNull(),
  employeeCount: integer("employee_count").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  hubspotCompanyId: text("hubspot_company_id").notNull(),
  contactId: text("contact_id").notNull(),
  dealId: text("deal_id"),
  lineItemId: text("line_item_id"),
  hubspotInvoiceId: text("hubspot_invoice_id"),
  invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("check_payroll_invoices_company_period").on(t.checkCompanyId, t.periodStart)]);
