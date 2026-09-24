export type PricingModel = "flat-rate" | "2-tier" | "interchange-plus";

export type DealStage =
  | "prospect_created"      // rep created a prospect + set a margin target, no link sent yet
  | "lead_link_sent"        // rep sent the tokenized self-serve upload link, awaiting customer
  | "quote_sent"            // link sent with a quote already prepared (rep set configs and/or uploaded the statement)
  | "lead_analysis_pending" // customer clicked the link and uploaded a statement, analyzing
  | "analysis"
  | "pricing"
  | "proposal_ready"
  | "proposal_sent"
  | "quote_accepted"        // customer explicitly accepted the quote on the customer quote view
  | "merchant_link_sent"    // post-proposal Adyen KYC handoff link sent (see customerLinkPurpose)
  | "merchant_filling"
  | "adyen_kyc_pending"
  | "adyen_kyc_complete"
  | "adyen_approved"
  | "closed_lost";

export type StatementAnalysis = {
  merchantName: string;
  processingMonth: string;
  totalVolume: number;
  totalTransactions: number;
  totalFees: number;
  interchangeFees: number;
  processorFees: number;
  otherFees: number;
  effectiveRate: number;
  interchangeRate: number;
  processorMarkup: number;
  statedMarkupRate: number;
  statedPerTxnFee: number;
  interchangeNotShown: boolean;
  averageTicket: number;
  cardPresentVolume: number;
  cardNotPresentVolume: number;
  cardPresentPct: number;
  cardNotPresentPct: number;
  visaVolume: number;
  mastercardVolume: number;
  amexVolume: number;
  discoverVolume: number;
  rewardCardPct: number;
  corporateCardPct: number;
  currentPricingModel: PricingModel | "unknown";
  currentProcessorName: string;
  annualVolume: number;
  confidence: "high" | "medium" | "low";
  notes: string;
  currentMargin: number;
  icEstimated?: boolean;
};

export type ProposedRatesFlatRate = {
  pricingModel: "flat-rate";
  flatRate: number;
  perTransaction: number;
  monthlyFee: number;
};
export type ProposedRates2Tier = {
  pricingModel: "2-tier";
  cardPresentRate: number;
  cardPresentPerTxn: number;
  cardNotPresentRate: number;
  cardNotPresentPerTxn: number;
  monthlyFee: number;
};
export type ProposedRatesIcPlus = {
  pricingModel: "interchange-plus";
  basisPoints: number;
  perTransaction: number;
  monthlyFee: number;
};
export type ProposedRates = ProposedRatesFlatRate | ProposedRates2Tier | ProposedRatesIcPlus;

export type ProposalOutput = {
  pricingModel: PricingModel;
  proposedRates: ProposedRates;
  projectedFees: { monthly: number; annual: number; effectiveRate: number };
  currentFees: { monthly: number; annual: number; effectiveRate: number };
  savings: { monthly: number; annual: number; savingsPct: number };
  sellingPoints: string[];
  proposalSummary: string;
};

// HubSpot's own billing-frequency enum, plus "one_time" for catalog items that
// carry no recurringbillingfrequency (hardware, installation). Kept identical to
// HubSpot's values so a quote line maps straight onto a line item.
export type BillingFrequency =
  | "one_time"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "per_six_months"
  | "annually"
  | "per_two_years"
  | "per_three_years"
  | "per_four_years"
  | "per_five_years";

// A product as it exists in AIO's HubSpot catalog. Read-only mirror — the
// catalog is maintained in HubSpot, never here.
// NOTE: `price` is per BILLING CYCLE, not per month. The flagship platform
// products bill WEEKLY, so "AIO Platform (1 to 5 Order Points)" at $99 is
// $99/week (~$429/mo). Never render a catalog price as monthly.
export type CatalogProduct = {
  hubspotProductId: string;
  name: string;
  price: number;
  billingFrequency: BillingFrequency;
  productType: string; // HubSpot hs_product_type: "inventory" | "Software" | "Service" | "AIO Payment Processing"
};

// What kind of quote this is. Chosen BEFORE anything is picked, because every
// selection rule hangs off it: which products a rep may put on the quote, which
// platform line is derived, whether the mandatory network/install/training lines
// are added, and whether a processing rate is quoted at all.
export type QuoteType =
  // The normal deal: POS hardware, an order-point-tiered platform fee, a rate.
  | "full_pos"
  // Same shape, but the platform fee is the flat food-truck product rather than
  // an order-point tier.
  | "food_truck"
  // Marketing products alone. No POS hardware, no platform fee, no processing
  // rate, and none of the mandatory install lines.
  | "marketing_only";

// A line on a quote. Price and frequency are SNAPSHOT at quote time rather than
// joined live from the catalog — HubSpot line items work the same way (they
// capture the product at time of sale and don't move when the catalog changes).
export type QuoteLine = {
  hubspotProductId: string;
  name: string;
  qty: number;
  unitPrice: number;
  billingFrequency: BillingFrequency;
  productType: string;
  /**
   * Percent off this line, 0–100 → HubSpot's `hs_discount_percentage`.
   * Absent/null is the overwhelming majority of lines and means full price.
   *
   * On a RECURRING line this is permanent, not a promo: 50% off a $99/wk
   * platform fee is $49.50 every week for the life of the subscription. The
   * "free for a while, then full price" lever is `billingStart`, not this —
   * they are different things and AIO's portal uses both.
   *
   * `unitPrice` stays the LIST price and the discount rides alongside it,
   * matching HubSpot (`price` + `hs_discount_percentage`, with `amount` and
   * `hs_total_discount` derived). Baking it into unitPrice instead would make
   * the quote unable to show what was given away.
   */
  discountPercent?: number | null;
  /**
   * When the recurring charges start, if not at checkout. Only ever set on a
   * recurring line — a one-time charge has no billing schedule to delay, and
   * `applyLineAdjustment` strips it rather than emitting a property HubSpot
   * would ignore.
   */
  billingStart?: BillingStart | null;
};

/**
 * A delayed billing start. Mirrors the two `hs_billing_start_delay_type` modes
 * AIO actually uses — 286 lines on a custom date, 72 on a day delay (60 days on
 * most of them). The other two modes HubSpot offers are deliberately absent:
 * `hs_billing_start_delay_months` is used on 2 lines portal-wide and
 * `milestone_based` on none, so neither earns a third code path through an
 * irreversible publish.
 */
export type BillingStart =
  /** A fixed calendar date, `yyyy-MM-dd` → `hs_recurring_billing_start_date`. */
  | { mode: "date"; date: string }
  /** N days after checkout → `hs_billing_start_delay_days`. */
  | { mode: "days"; days: number };

/**
 * The rep's per-line commercial edits, keyed by HubSpot product id.
 *
 * Kept OUT of the picks and applied to the built quote instead, because the
 * lines reps most often discount — Onsite Installation and System Onboarding
 * and Training, the two most-discounted line names in the portal — are DERIVED
 * lines that are never picked at all. Keying by product id works because a
 * product appears at most once on a quote: picks are already keyed that way and
 * each derived line is a single unit.
 */
export type LineAdjustment = {
  discountPercent?: number | null;
  billingStart?: BillingStart | null;
};

/** hubspotProductId → the rep's edits to that line. */
export type QuoteAdjustments = Record<string, LineAdjustment>;

// Quote arithmetic, kept apart by billing cycle on purpose. `oneTime` and
// `recurring` are different units and must never be added together; the
// `monthlyEquivalent` is the only figure comparable to a statement's monthly
// numbers, and it covers the recurring side only.
export type QuoteTotals = {
  oneTime: number;
  recurring: Array<{ frequency: BillingFrequency; amount: number }>;
  monthlyEquivalent: number;
};

// The QUOTED ordering-point count — order-point-bearing hardware lines plus the
// non-hardware channels declared on the deal (a website is an ordering point
// and will never appear in an inventory system). It selects the platform tier,
// i.e. the largest recurring line on the quote, so it is part of what we
// quoted: frozen at publish alongside quoteConfig/quoteLines, never overwritten
// by a later sync. The DEPLOYED count is a separate, post-go-live thing that
// comes from aioinventory — don't conflate the two.
// `hardware` maps catalog product name → points that line contributed.
export type OrderPoints = {
  hardware: Record<string, number>;
  channels: string[];
  total: number;
};

// The rep-entered basis for a quote when there's no statement to read it from
// (E2E.md's "configs"). When an analysis exists its numbers win; this is also
// what Phase G compares trailing actuals against.
export type QuoteConfig = {
  avgTicket: number;
  monthlyVolume: number;
};

// One subscription HubSpot created from a quote's checkout. PLURAL on the
// application, because a quote produces one subscription per distinct
// `recurringbillingfrequency` — verified against 45 of the 46 paid quotes in
// the live portal, two of which produced two each (weekly + monthly)
// (PAYMENT-TEST-PLAN.md §1.3). AIO's catalog mixes weekly platform lines with
// monthly add-ons, so a mixed quote routinely yields two.
//
// We never create these. HubSpot does, ~1–9 minutes after the buyer finishes
// checkout — which is DAYS before the quote itself flips to `PAID`
// (PAYMENT-TEST-PLAN.md §1.5). That ordering is why this snapshot, not the
// quote's `paymentStatus`, is what the customer's Billing module gates on.
export type HubspotSubscriptionSnapshot = {
  subscriptionId: string;
  /** hs_status: active|past_due|unpaid|canceled|expired|scheduled|paused.
   *  `paused` and `canceled` are COMMON here (35 of 91 live subscriptions) —
   *  real billing-ops states the UI must render, not a default to fall through. */
  status: string | null;
  /** hs_payment_method, e.g. "ACH - 1117". Non-null is the proof that the buyer
   *  actually authorized at checkout; a hand-made billing-tool subscription
   *  reads null here (PAYMENT-TEST-PLAN.md §1.2). */
  paymentMethod: string | null;
  /** hs_recurring_billing_frequency — weekly vs monthly, i.e. the thing that
   *  split one quote into two subscriptions. */
  billingFrequency: string | null;
  /** hs_recurring_billing_start_date — what to tell the customer ("first charge
   *  on …"). Can be up to 60 days out. */
  billingStartDate: string | null;
  /** hs_mrr — HubSpot's own weekly × 52/12 figure. Cached so EasyOB never
   *  re-derives it and disagrees with the CRM. */
  mrr: number | null;
  nextPaymentDueDate: string | null;
  /** hs_last_payment_status: succeeded|failed|partially_refunded|refunded|processing. */
  lastPaymentStatus: string | null;
  completedPayments: number | null;   // hs_number_of_completed_payments
  totalCollected: number | null;      // hs_total_collected_amount
};

// HubSpot billing linkage. The quote is BOTH the rep-visible CRM artifact and
// the customer's checkout — see E2E-PLAN.md. We never create the subscription
// or its invoices; HubSpot does that when the customer pays the quote.
export type HubspotIds = {
  // dealId intentionally absent — the canonical home is the flat hubspotDealId
  // column (schema.ts), which is the one actually populated, read by five call
  // sites, and on the customer-writable whitelist. Adopting a JSONB copy would
  // create a SECOND deal per application until a backfill ran.
  // See PHASE-E-SPEC.md §5.1 / O-14.
  quoteId: string | null;
  /** Which quote template this quote was built on (association typeId 286).
   *  Admin-configurable — the portal carries several ("AIO Quote v3",
   *  "Marketing Only Quote", "Hardware Addition Quote") plus inactive ones. */
  quoteTemplateId: string | null;
  /** Quote-side line items, in quoteLines order. Lets a DRAFT re-save reconcile
   *  instead of duplicating. HubSpot clones its own deal-side copies at publish
   *  — those ids are NOT these and are never tracked here. */
  lineItemIds: string[] | null;
  /** The Contact associated (69) and taken as signer (702). */
  contactId: string | null;
  /** hs_quote_link. Populated at publish, ~3s later. NOT a one-time-use link,
   *  so unlike Adyen/Check links it may be stored and re-served
   *  (PHASE-E-SPEC.md §7.3). Re-read on null; never authoritative here. */
  quoteLink: string | null;
  /** ISO timestamp of the successful publish. THE one-way-door marker: null
   *  means the quote is still a DRAFT and still editable from EasyOB. A
   *  published quote cannot be edited, deleted, or voided via the API. */
  publishedAt: string | null;
  /** hs_payment_status: PENDING | PROCESSING | PAID | PAYMENT_NOT_ENABLED.
   *  Calculated and read-only in HubSpot. Worth caching as the "the money
   *  actually moved" signal, but it lags checkout by a median 5.7 days (daily
   *  ACH settlement batch) so it must NOT gate module completion
   *  (PAYMENT-TEST-PLAN.md §1.5). */
  paymentStatus: string | null;
  paymentDate: string | null;
  /** Every subscription this quote produced, via association 304. */
  subscriptions: HubspotSubscriptionSnapshot[] | null;
  /** Worst-of roll-up across `subscriptions`, so one broken subscription on a
   *  mixed-frequency quote cannot be hidden by a healthy sibling.
   *  Computed by rollUpSubscriptionStatus below. */
  subscriptionStatus: string | null;
  /** When the snapshot fields above were last refreshed. Mirrors
   *  checkIds.onboardStatusAt — list views read this cache and never call
   *  HubSpot. */
  syncedAt: string | null;
  /** Last swallowed background-sync failure, persisted so it is VISIBLE. The
   *  deal sync failed silently for the entire life of the feature purely
   *  because a console.error was the only record. Cleared on the next success. */
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
};

// The starting value for the conditional-claim lock that guards quote creation
// against a concurrent double-click (PHASE-E-SPEC.md §5.6): claiming the row
// means writing a non-null hubspotIds, so it has to be writable as a whole.
export const EMPTY_HUBSPOT_IDS: HubspotIds = {
  quoteId: null,
  quoteTemplateId: null,
  lineItemIds: null,
  contactId: null,
  quoteLink: null,
  publishedAt: null,
  paymentStatus: null,
  paymentDate: null,
  subscriptions: null,
  subscriptionStatus: null,
  syncedAt: null,
  lastSyncError: null,
  lastSyncErrorAt: null,
};

// Worst-of first. A presentation choice, not a HubSpot concept: a mixed-frequency
// quote has two subscriptions and the account is only as healthy as its sickest
// one, so a canceled weekly platform line must not be masked by an active
// monthly add-on (PAYMENT-TEST-PLAN.md §1.6).
const SUBSCRIPTION_STATUS_SEVERITY = [
  "canceled",
  "unpaid",
  "past_due",
  "paused",
  "expired",
  "scheduled",
  "active",
] as const;

/**
 * Pure: the single `subscriptionStatus` shown on an application, given every
 * subscription its quote produced. Null for no subscriptions — that is a
 * distinct state from any status (checkout hasn't happened, or the quote was
 * one-time charges only) and must not collapse into one.
 *
 * An unrecognised status sorts WORST, ahead of `canceled`: a value this build
 * doesn't know about is a reason to look, not a reason to reassure.
 */
export function rollUpSubscriptionStatus(subs: HubspotSubscriptionSnapshot[]): string | null {
  let worst: string | null = null;
  let worstRank = Number.POSITIVE_INFINITY;
  for (const sub of subs) {
    const status = (sub.status ?? "").trim();
    if (status === "") continue;
    const known = (SUBSCRIPTION_STATUS_SEVERITY as readonly string[]).indexOf(status);
    const rank = known === -1 ? -1 : known;
    if (rank < worstRank) {
      worstRank = rank;
      worst = status;
    }
  }
  return worst;
}

export type BusinessInfo = {
  legalName: string;
  dba: string;
  bizType: "llc" | "corp" | "s-corp" | "sole-prop" | "partnership" | "non-profit";
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  website: string;
  yearsInBusiness: string;
  annualRevenue: string;
};

export type OwnerContact = {
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  phone: string;
};

export type ProcessingInfo = {
  monthlyVolume: string;
  avgTicket: string;
  cardPresentPct: string;
  mcc: string;
  businessDescription: string;
  previouslyTerminated: "yes" | "no";
  bankruptcy: "yes" | "no";
  currentProcessor: string;
};

export type AgreementInfo = {
  sigName: string;
  sigDate: string;
  termsAccepted: boolean;
  electronicConsentAccepted: boolean;
  // WHO performed this legal act. "customer" is the only value there is, because
  // the merchant is the only party who may consent on their own behalf — a rep
  // preparing the form has nothing it could write here. OPTIONAL because this is
  // a stored JSON column: rows written before the field existed carry no actor,
  // and an agreement whose origin can't be established is not the customer's.
  // See lib/consent.ts — the rule, and why absence must read as "not consent".
  actor?: "customer";
};

export type ProcessorTier = {
  id: string;
  name: string;
  isDefault: boolean;
  processingBps: number;
  perTxnFee: number;
  schemeBps: number;
  monthlyFee: number;
};

export type Processor = {
  id: string;
  name: string;
  isDefault: boolean;
  tiers: ProcessorTier[];
};

export type AppSettings = {
  processors: Processor[];
  adyenConfig?: {
    environment: "test" | "live";
    companyId: string;
    lemApiKey: string;
    managementApiKey: string;
    balancePlatformApiKey: string;
    corsProxy?: string;
  };
};

// The AIO platform tenant graph this merchant was provisioned into, and the
// bookkeeping the provisioning cron needs to be safely re-runnable.
//
// EasyOB used to create its own Adyen legal entity, which produced accounts
// that were misnamed and unlinked from the AIO platform. Since 2026-09-23 the
// AIO dashboard API is the ONLY way we obtain an Adyen account: it creates the
// tenant ("business"), the location ("restaurant"), and mints a KYC link
// already wired to the right tenant.
//
// Everything here is IRREVERSIBLE on AIO's side. A business alias is globally
// unique and a delete is soft — it never frees the alias — so a duplicate
// create is permanent debris in a database shared with other AIO teams. That
// is why `alias` is deterministic (easyob_{app.id}), why `claimedAt` exists,
// and why the provisioner reconciles by alias before it ever creates.
export type AioTenantIds = {
  // AIO "business" id — ALSO the AIO tenant number, which is what
  // adyenIds.tenantNumber and therefore the prod-{n} settlement attribution in
  // src/lib/adyen/paymentsAccountingParser.ts is built from.
  businessId: number;
  locationId: number | null;     // AIO "restaurant" — the physical site
  companyId: string | null;      // Check company the PLATFORM auto-creates ("com_…")
  workplaceId: string | null;    // Check workplace the platform auto-creates ("wrk_…")
  alias: string;                 // globally unique and permanently burned
  businessName: string;          // what we actually named it (may carry a dedupe suffix)
  environment: string;           // which AIO deployment holds it, e.g. "internal-dev"
  createdAt: string;             // the business landed
  provisionedAt: string | null;  // all three steps landed — the gate the UI reads
  claimedAt: string | null;      // cron lease; stale after 15 minutes
  attempts: number;
  lastAttemptAt: string | null;
  // Persisted, not merely logged. Provisioning is a cron with no human in the
  // loop, and the repo has already been bitten once by a failure that lived
  // only in a Vercel log (see HubspotIds.lastSyncError).
  lastError: string | null;
  lastErrorAt: string | null;
};

// Check's own read of how far a company got through payroll onboarding.
// "needs_attention" still allows payroll to run; "blocking" does not.
export type CheckOnboardStatus = "completed" | "needs_attention" | "blocking";

// Check (checkhq.com) payroll onboarding state — the payroll-side counterpart
// to adyenIds. We persist the company id and the signer, never the onboard
// link: Check links are one-time use and expire after 24h, so they're minted
// per click (same rule as Adyen's, just a longer fuse).
export type CheckIds = {
  companyId: string;
  environment: "sandbox" | "production";
  startDate: string;                          // first payday on Check (YYYY-MM-DD)
  signer: { name: string; title: string; email: string };
  createdAt: string;
  // Snapshot of Check's onboard status, refreshed when the customer views the
  // application detail page. Cached rather than fetched everywhere so the
  // dashboard/list views don't fan out one Check API call per application.
  onboardStatus: CheckOnboardStatus | null;
  onboardStatusAt: string | null;
};

// Foodbuy enrollment: there is no API — it's a paper participation agreement
// (AIO_Foodbuy_Enrollment_Form_V1) that asks for the Federal ID #, a wet
// signature, GPO-affiliation disclosure, and per-location distributor account
// numbers, none of which AIO ever collects. So there's nothing to poll for
// status; this only records that the customer has generated their pre-filled
// copy of the form (see lib/foodbuyForm.ts) to sign and hand off themselves.
export type FoodbuyIds = {
  generatedAt: string;
};

// The HubSpot deal an application is currently backed by, captured at the
// moment a rep attaches it — either by ADOPTING a deal that already existed
// in the rep's own pipeline, or by EasyOB CREATING a brand-new one. Mirrors
// TenantLink's self-describing-snapshot shape below: it lets the app answer
// "how did we get this deal" without a live HubSpot call.
//
// `origin` is what `buildDealProperties` (adapters/hubspot.ts) gates on to
// decide whether `dealname`/`amount` may be written back:
//   - "created" — EasyOB minted this deal itself, so it owns those fields.
//   - "adopted" — the deal existed first; a rep has had it in the pipeline
//     for weeks, with their own forecast in `amount` and a name a HubSpot
//     portal workflow renames on its own schedule. EasyOB must never write
//     either back onto an adopted deal.
//
// `dealName` is what the deal was called AT LINK TIME — for display only,
// NEVER written back (see the "adopted" case above for why).
//
// A NULL `dealLink` is every row written before deal adoption existed. It is
// read as "adopted" — the conservative default, since we genuinely don't
// know whether EasyOB created this deal, and writing nothing is the only
// safe assumption when we don't know what we own.
export type DealLink = {
  origin: "adopted" | "created";
  dealName: string;
  pipelineStageAtLink: string | null;
  linkedAt: string;
  linkedByUserId: string;
};

export type MerchantApplication = {
  id: string;
  ownerUserId: string; // the rep who owns this deal — distinct from ownerContact (merchant's contact)
  customerUserId: string | null; // set once the customer completes magic-link signup
  createdAt: string;
  updatedAt: string;
  stage: DealStage;
  hubspotDealId: string | null;
  // See DealLink above. Null (every pre-adoption row) reads as "adopted".
  dealLink: DealLink | null;
  tenantLink: TenantLink | null; // Phase 3 — HubSpot Company (AIO tenant) this ezacc is linked to
  adyenIds: {
    legalEntityId: string | null;
    accountHolderId: string | null;
    balanceAccountId: string | null;
    merchantAccountId: string | null; // the shared POS merchant account the store lives under (e.g. AIOAppIncPOS)
    storeId: string | null;           // Adyen store id (ST…) — created only once the tenant number is known
    businessLineId: string | null;    // this restaurant's business line; links the store to the legal entity
    tenantNumber: string | null;      // AIO tenant number (from the AIO dashboard); drives the AH reference and store ref prod-{n}
    environment: "test" | "live";
  } | null;
  adyenOnboardingUrl: string | null;
  // The AIO platform tenant this merchant was provisioned into. Null until
  // billing is paid and the provisioning cron runs. See AioTenantIds.
  aioTenant: AioTenantIds | null;
  checkIds: CheckIds | null; // Check payroll onboarding — null until the customer opts in
  foodbuyIds: FoodbuyIds | null; // Foodbuy enrollment — null until the customer opts in
  hubspotIds: HubspotIds | null; // HubSpot deal/quote/subscription — null until a quote is built
  // What kind of quote this is. Frozen with the rest of the quote, because it's
  // what the lines were derived UNDER: re-reading a marketing-only quote as a
  // full-POS one would imply a platform fee that was never quoted. Null on rows
  // written before quote types existed; read those as "full_pos".
  quoteType: QuoteType | null;
  quoteConfig: QuoteConfig | null; // rep-entered ticket/volume basis when there's no statement
  quoteLines: QuoteLine[] | null;  // hardware/platform/service lines; priced at quote time
  orderPoints: OrderPoints | null; // the quoted order-point count that selected the platform tier
  // When the customer explicitly accepted the quote on the customer quote view.
  // Distinct from stage: stage keeps moving through onboarding, this doesn't —
  // it's the moment the quote was agreed, and it belongs with the frozen
  // quoteConfig/quoteLines rather than with the live deal state.
  quoteAcceptedAt: string | null;
  targetMargin: number | null; // rep-set margin target, exists before any analysis
  pricingModel: PricingModel | null; // rep's pre-selected model for the prospect
  // Generalized token slot — serves both the pre-analysis self-serve upload
  // link (purpose "lead_upload") and the post-proposal Adyen KYC handoff
  // link (purpose "kyc_handoff"); these are different moments in the deal
  // lifecycle and can't share one unqualified token.
  customerLinkToken: string | null;
  customerLinkPurpose: "lead_upload" | "kyc_handoff" | null;
  customerLinkSentAt: string | null;
  customerLinkExpiresAt: string | null;
  analysis: StatementAnalysis | null;
  proposal: ProposalOutput | null;
  business: BusinessInfo | null;
  ownerContact: OwnerContact | null;
  processing: ProcessingInfo | null;
  agreement: AgreementInfo | null;
};

// Phase 3 — the "tenant ↔ ezacc equivalency". Links this easyob account
// (ezacc) to the HubSpot Company that represents the AIO tenant. HubSpot is
// the system of record for the AIO-dashboard-created Adyen objects (AIOad),
// so we snapshot the tenant's identifiers here at link time: it makes the
// link self-describing in the dashboard without a live HubSpot call on every
// render, and pre-captures exactly the AIOad identifiers the LATER
// "replace AIOad with ezad" work will need. Recording only — no Adyen call.
export type TenantLink = {
  hubspotCompanyId: string;
  companyName: string;
  tenantRef: string | null;             // HubSpot "tenant_id" value, e.g. "prod-1024" (store ref format)
  adyenAccountHolderId: string | null;  // AIOad account holder, e.g. "AH32..."
  linkedAt: string;
  linkedByUserId: string;
};

export type CustomerSubmission = {
  id: number;
  submittedAt: string;
  contactInfo: { dba: string; name: string; email: string; phone: string };
  analysis: StatementAnalysis;
  quote: {
    type: "quote" | "referral";
    flatRate?: number;
    monthlyCost?: number;
    annualCost?: number;
    savings?: { monthly: number; annual: number; pct: number };
  };
};

// The only shape a customer is ever allowed to see (enforced server-side at
// the API response boundary) — no cost breakdown, no margin, no raw analysis.
// The bar for adding a field here: would we print it on the quote we hand the
// merchant? Their own volume/ticket and the rate we're quoting pass; AIO's
// cost, margin, floor, or interchange assumptions do not.
// Phase C: quote lines and the order-point count are customer-safe — they are
// literally what's printed on the paper quote. Costs, margins and floors are
// not, and never join this shape.
// The priced-lines half, present on every basis.
type CustomerSafeLines = {
  // Hardware / platform / service lines as quoted, price and cycle snapshotted.
  // Empty (not null) when nothing was configured, so the view has one shape.
  lines: QuoteLine[];
  // Totals for those lines. Null when there are none. Never one number: the
  // one-time and recurring halves are different units.
  lineTotals: QuoteTotals | null;
  // Stated on the quote as the basis for the platform-fee line.
  orderPoints: OrderPoints | null;
};

// The processing-rate half. A discriminated union rather than nullable fields
// because a marketing-only quote has no rate at ALL — no volume, no effective
// rate, no projected cost — and zeros there would render as a real 0.00% quote.
// The `basis` tag is what the view branches on.
type CustomerSafeRate = {
  // "statement" — read off the merchant's own statement (theirs or the rep's upload).
  // "config"    — derived from the rep-entered quoteConfig, no statement in hand.
  basis: "statement" | "config";
  monthlyVolume: number;
  averageTicket: number;
  effectiveRate: number;          // AIO's quoted all-in effective rate on that volume
  projectedMonthlyCost: number;
  projectedAnnualCost: number;
  // Savings need a CURRENT cost to compare against, and only a statement
  // supplies one. These are null on the config path on purpose — we quote a
  // rate there rather than invent what the merchant pays today.
  currentMonthlyCost: number | null;
  currentEffectiveRate: number | null;
  monthlySavings: number | null;
  annualSavings: number | null;
  savingsPct: number | null;
};

export type CustomerSafeQuote =
  | (CustomerSafeRate & CustomerSafeLines)
  // "products" — priced lines with no processing rate behind them. A
  // marketing-only quote (QuoteType "marketing_only"): AIO isn't processing for
  // this merchant, so there is nothing to quote a rate on.
  | ({ basis: "products" } & CustomerSafeLines);
