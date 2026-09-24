// Quote-line arithmetic and the ordering-point pricing rule.
//
// Pure and dependency-free on purpose: no DB, no HubSpot, no pricing.ts. That
// keeps it unit-testable AND safe to import from a client component — nothing
// in here is an AIO internal (no margin, no cost, no floor). The catalog it
// operates on is read from HubSpot server-side and passed in.

import { monthlyEquivalent } from "@/lib/utils";
import type {
  BillingFrequency, BillingStart, CatalogProduct, LineAdjustment, OrderPoints,
  QuoteAdjustments, QuoteLine, QuoteTotals, QuoteType,
} from "@/types/merchant";

// ── Quote types ─────────────────────────────────────────────────────────────

// The type is picked FIRST and everything else follows from it. It has to be,
// not inferred from what's on the quote: the mandatory install lines and the
// platform line are added to an EMPTY quote, so there's nothing to infer from
// at the moment the decision is needed.
export const QUOTE_TYPES: Array<{ id: QuoteType; label: string; note: string }> = [
  {
    id: "full_pos",
    label: "Full POS",
    note: "Hardware, software and a processing rate. Platform fee follows the ordering-point count.",
  },
  {
    id: "food_truck",
    label: "Food Truck",
    note: "Same as Full POS, but the platform fee is the flat food-truck rate rather than a tier.",
  },
  {
    id: "marketing_only",
    label: "Marketing Only",
    note: "Marketing products alone — no POS hardware, no platform fee, no processing rate.",
  },
];

/** Read a persisted quote type. Rows written before quote types existed are full-POS deals. */
export function quoteTypeOf(stored: QuoteType | null | undefined): QuoteType {
  return stored ?? "full_pos";
}

/** True for the quote types that carry a processing rate, an ordering-point count and a platform fee. */
export function isProcessingQuote(quoteType: QuoteType): boolean {
  return quoteType !== "marketing_only";
}

// ── The rep-facing picker ───────────────────────────────────────────────────

// Products a rep must not be able to put on a quote by hand. `listProducts()`
// already drops the TEST product and anything inactive; these are the further
// exclusions E2E-PLAN.md recommends.
//
// OPEN DECISION (E2E-PLAN.md "Catalog data hygiene"): the plan *recommends*
// hiding these but nobody has signed off, so the list is named and commented
// rather than inlined. Reverting any single entry is a one-line change.
//   - the two "AIO Payment Processing" entries are $0 placeholders; processing
//     margin is taken out of Adyen settlement, never billed through HubSpot
//   - "CAMP Invoice" is a billing artifact, not something a rep sells
//   - "AIO Pre Auth" ($0.50/Service) is a PER-TRANSACTION fee — quoting it as a
//     single $0.50 line is meaningless
export const PICKER_EXCLUDED_PRODUCT_NAMES = [
  "AIO Processing Two Tiered Rate",
  "AIO Tier Processing",
  "CAMP Invoice",
  "AIO Pre Auth",
] as const;

/**
 * Everything a rep can never pick by hand. Two reasons land here:
 *   - the exclusions above — things nobody sells as a line
 *   - DERIVED lines: all three platform products and the three mandatory
 *     install services. They still land on the quote, just not by hand, and
 *     leaving them in the picker is how you get billed for two platform fees
 *     or a second $999 install.
 */
export function isPickable(product: CatalogProduct): boolean {
  return (
    !PICKER_EXCLUDED_PRODUCT_NAMES.includes(product.name as (typeof PICKER_EXCLUDED_PRODUCT_NAMES)[number]) &&
    !isPlatformProduct(product.name, product.hubspotProductId) &&
    !isIncludedServiceProduct(product.hubspotProductId, product.name)
  );
}

// ── Selection rules per quote type ──────────────────────────────────────────

// The only products a marketing-only quote may carry. Confirmed with Shaheer
// 2026-08-20: the Marketing Platform and Add Spend, and nothing else — the
// Review Manager and Payroll are POS add-ons, not marketing.
export const MARKETING_PRODUCTS = [
  { name: "AIO Marketing Platform", hubspotProductId: "223152695997" },
  { name: "AIO Marketing Add Spend", hubspotProductId: "247901295335" },
] as const;

function isMarketingProduct(id: string, name: string): boolean {
  return MARKETING_PRODUCTS.some(m => m.hubspotProductId === id || m.name === name.trim());
}

/**
 * Whether a rep may put this product on a quote of this type. Applied to the
 * picker AND re-applied server-side, because "the rep can't see it" is not the
 * same as "it can't be sent".
 *
 * Only marketing-only restricts anything: a POS or food-truck deal can carry
 * any pickable product, marketing included (a restaurant buying both is one
 * deal, not two quotes).
 */
export function isAllowedForQuoteType(product: CatalogProduct, quoteType: QuoteType): boolean {
  if (!isPickable(product)) return false;
  if (quoteType !== "marketing_only") return true;
  return isMarketingProduct(product.hubspotProductId, product.name);
}

// ── Mandatory install services (derived, not chosen) ────────────────────────

// Confirmed with Shaheer 2026-08-20: every quote that puts AIO's system in a
// restaurant includes a network, an install and a training — qty 1 each, not a
// rep decision. So they're derived lines with no stepper, exactly like the
// platform fee, rather than three checkboxes a rep can forget or unpick.
//
// Two exceptions, both meaning "nothing is being installed":
//   - a marketing-only quote
//   - a RATE-ONLY quote: a processing quote with no products picked at all.
//     The services attach to the products, so an empty picker means there's
//     nothing to install, no network to run and nothing to train on. Declared
//     ordering channels do NOT pull them in — a website-ordering merchant has
//     no on-site anything for a $999 install or a $999 WiFi package to cover.
export const INCLUDED_SERVICE_PRODUCTS = [
  { name: "AIO WiFi Network Package", hubspotProductId: "281351401209" },
  { name: "Onsite Installation", hubspotProductId: "223452690133" },
  { name: "System Onboarding and Training", hubspotProductId: "223152695032" },
] as const;

function isIncludedServiceProduct(id: string, name: string): boolean {
  return INCLUDED_SERVICE_PRODUCTS.some(s => s.hubspotProductId === id || s.name === name.trim());
}

export type IncludedServicesResult = {
  /** The lines to put on the quote, qty 1 each. */
  lines: QuoteLine[];
  /**
   * Names a quote of this type requires but the catalog didn't yield (renamed,
   * archived, or the catalog didn't load). Same posture as an unresolved
   * platform tier: never quietly quote without them.
   */
  missing: string[];
};

/**
 * The install lines a quote carries. Resolved from the catalog like any other
 * line, so the price on the quote is the price HubSpot holds today and is
 * snapshotted from here on.
 *
 * Takes the picked lines because the services follow the products: no products
 * means a rate-only quote, and a rate-only quote installs nothing.
 */
export function resolveIncludedServices(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  catalog: CatalogProduct[]
): IncludedServicesResult {
  if (!isProcessingQuote(quoteType) || pickedLines.length === 0) return { lines: [], missing: [] };

  const lines: QuoteLine[] = [];
  const missing: string[] = [];
  for (const service of INCLUDED_SERVICE_PRODUCTS) {
    const product =
      catalog.find(p => p.hubspotProductId === service.hubspotProductId) ??
      catalog.find(p => p.name.trim() === service.name);
    if (product) lines.push(toQuoteLine(product, 1));
    else missing.push(service.name);
  }
  return { lines, missing };
}

// HubSpot's hs_product_type values, in the order a configurator should show
// them. Untyped products get their own bucket instead of disappearing — four
// live catalog entries carry no type and would otherwise be invisible.
export const UNCATEGORIZED_GROUP = "Uncategorized";

const GROUP_ORDER = ["inventory", "Software", "Service", UNCATEGORIZED_GROUP];

export const PRODUCT_GROUP_LABELS: Record<string, string> = {
  inventory: "Hardware",
  Software: "Software",
  Service: "Service",
  [UNCATEGORIZED_GROUP]: UNCATEGORIZED_GROUP,
};

export function groupProducts(products: CatalogProduct[]): Array<{ type: string; label: string; products: CatalogProduct[] }> {
  const groups = new Map<string, CatalogProduct[]>();
  for (const p of products) {
    const key = p.productType || UNCATEGORIZED_GROUP;
    const bucket = groups.get(key);
    if (bucket) bucket.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a[0]), bi = GROUP_ORDER.indexOf(b[0]);
      return (ai === -1 ? GROUP_ORDER.length : ai) - (bi === -1 ? GROUP_ORDER.length : bi);
    })
    .map(([type, list]) => ({ type, label: PRODUCT_GROUP_LABELS[type] ?? type, products: list }));
}

/** Snapshot a catalog product onto the quote. Price and frequency are frozen here. */
export function toQuoteLine(product: CatalogProduct, qty: number): QuoteLine {
  return {
    hubspotProductId: product.hubspotProductId,
    name: product.name,
    qty,
    unitPrice: product.price,
    billingFrequency: product.billingFrequency,
    productType: product.productType,
  };
}

// ── Frequency-aware totals ──────────────────────────────────────────────────

const FREQUENCY_SORT: BillingFrequency[] = [
  "weekly", "biweekly", "monthly", "quarterly", "per_six_months",
  "annually", "per_two_years", "per_three_years", "per_four_years", "per_five_years",
];

/** List price before any discount: `price × quantity`. HubSpot's `hs_pre_discount_amount`. */
export function lineListAmount(line: QuoteLine): number {
  return line.unitPrice * line.qty;
}

/**
 * What the line is actually worth per cycle, net of its discount — HubSpot's
 * calculated `amount`. This, not the list amount, is what bills.
 *
 * Rounded to cents because a percentage discount routinely produces fractions
 * of one (33.3% of $99) and an unrounded float would make our totals disagree
 * with the document HubSpot renders.
 */
export function lineNetAmount(line: QuoteLine): number {
  const pct = line.discountPercent ?? 0;
  if (!pct) return lineListAmount(line);
  return Math.round(lineListAmount(line) * (1 - pct / 100) * 100) / 100;
}

/** What the discount takes off this line. HubSpot's calculated `hs_total_discount`. */
export function lineDiscountAmount(line: QuoteLine): number {
  return Math.round((lineListAmount(line) - lineNetAmount(line)) * 100) / 100;
}

/**
 * Three totals that must never be added together: what's due once, what's due
 * per recurring cycle (grouped BY cycle, because a weekly $99 and a monthly $39
 * are not the same unit), and the monthly-equivalent normalization that makes
 * the recurring side comparable to a statement's monthly figures.
 *
 * Every figure is NET of discounts, so these agree with what HubSpot bills. A
 * delayed `billingStart` deliberately does NOT move them: it changes when the
 * first charge lands, not what the quote is worth per cycle.
 */
export function quoteTotals(lines: QuoteLine[]): QuoteTotals {
  let oneTime = 0;
  const byCycle = new Map<BillingFrequency, number>();
  let monthly = 0;

  for (const line of lines) {
    const amount = lineNetAmount(line);
    if (line.billingFrequency === "one_time") {
      oneTime += amount;
      continue;
    }
    byCycle.set(line.billingFrequency, (byCycle.get(line.billingFrequency) ?? 0) + amount);
    monthly += monthlyEquivalent(amount, line.billingFrequency);
  }

  return {
    oneTime,
    recurring: [...byCycle.entries()]
      .sort((a, b) => FREQUENCY_SORT.indexOf(a[0]) - FREQUENCY_SORT.indexOf(b[0]))
      .map(([frequency, amount]) => ({ frequency, amount })),
    monthlyEquivalent: monthly,
  };
}

// ── Ordering points ─────────────────────────────────────────────────────────

// THE pricing rule. It lives here — in EasyOB — and deliberately NOT in the
// aioinventory endpoint: the endpoint returns raw category counts, and this
// mapping changes whenever the tier definition does.
//
// Keyed by the trimmed HubSpot catalog product name for readability, but every
// rule also carries its live `hubspotProductId` and THAT is what a quote line
// is matched on first (see `ruleForLine`). The catalog is maintained in HubSpot
// by non-engineers: renaming "Mega Kiosk" must not silently stop counting it.
// The name stays as the fallback for a product created after this list.
//
// Rules confirmed by Steve 2026-08-18 (E2E-PLAN.md, "Which categories count"):
// POS terminals count 1 each; a kiosk counts 1 each, NOT one per lane; MPOS and
// Tableside AI Devices count. Payment terminals, card readers, customer-facing
// displays, KDS, printers, menu boards, mounts, network gear and cash drawers
// do not. Tablets were the one open question — conditional, unresolvable from a
// product record — and Shaheer settled them 2026-09-17: neither tablet counts.
type OrderPointRule = {
  pointsPerUnit: number;
  /** Live HubSpot product id — the primary key, so a rename can't drop the rule. */
  hubspotProductId?: string;
  /**
   * Set when the count is a human judgement the catalog can't make for us.
   * NO rule carries this today — both tablets were resolved 2026-09-17 — but
   * the mechanism stays for the next product nobody can classify from its
   * catalog record. It is not decorative: a rule that sets it REFUSES the
   * billing publish (billing/preconditions.ts rule 6) until a human edits the
   * quote, so adding one to a product reps actually pick will stall every deal
   * carrying it. Resolve the point count instead, the way these two were.
   */
  needsReview?: string;
};

export const ORDER_POINT_RULES: Record<string, OrderPointRule> = {
  // Counts
  "POS Unit": { pointsPerUnit: 1, hubspotProductId: "217445755632" },
  "POS Unit - With Customer Facing Display": { pointsPerUnit: 1, hubspotProductId: "223452690130" },
  "mPOS": { pointsPerUnit: 1, hubspotProductId: "223511653101" },
  "Mega Kiosk": { pointsPerUnit: 1, hubspotProductId: "260674226888" },
  "Kiosk + Payment Terminal (AMS1) and Mount": { pointsPerUnit: 1, hubspotProductId: "222497165009" },
  "Kiosk Mini + Payment Terminal (AMS1) and Mount": { pointsPerUnit: 1, hubspotProductId: "223519571666" },
  // Resolved by Shaheer 2026-08-20: the bundle contains exactly one POS, so it
  // counts one point like a bare POS Unit. Was 0-with-needsReview while the
  // contents were unknown.
  "QSR POS Hardware Bundle": { pointsPerUnit: 1, hubspotProductId: "252941875920" },

  // Explicitly does not count
  // Both tablets were 0-with-needsReview until Shaheer settled them
  // 2026-09-17: neither is an ordering point. They stay 0, but WITHOUT the
  // review flag, which was refusing the billing publish on every quote that
  // carried one (billing/preconditions.ts rule 6) with no way for a rep to
  // clear it short of dropping the line.
  "Orders Hub Tablet": { pointsPerUnit: 0, hubspotProductId: "276751313619" },
  "Clock in Tablet": { pointsPerUnit: 0, hubspotProductId: "276754193118" },
  "Payment Terminal - AMS1": { pointsPerUnit: 0, hubspotProductId: "223511653105" },
  "Customer Facing Display": { pointsPerUnit: 0, hubspotProductId: "318736467644" },
  "Kitchen Display System": { pointsPerUnit: 0, hubspotProductId: "223452690132" },
  "Kitchen Display for Customer": { pointsPerUnit: 0, hubspotProductId: "265825703641" },
  "Menu Board Computer": { pointsPerUnit: 0, hubspotProductId: "223511653103" },
  "Thermal Printer": { pointsPerUnit: 0, hubspotProductId: "223511653104" },
  "Epson Sticky Printer": { pointsPerUnit: 0, hubspotProductId: "250458906315" },
  "Cash Drawer": { pointsPerUnit: 0, hubspotProductId: "222497165011" },
  "AIO WiFi Network Package": { pointsPerUnit: 0, hubspotProductId: "281351401209" },
  "Large TV (75in)": { pointsPerUnit: 0, hubspotProductId: "316081071858" },
  "Medium TV (50in to 65in)": { pointsPerUnit: 0, hubspotProductId: "316074591968" },
  "Small TV (32in to 43in)": { pointsPerUnit: 0, hubspotProductId: "316076031729" },
};

const RULES_BY_PRODUCT_ID = new Map(
  Object.values(ORDER_POINT_RULES)
    .filter(r => r.hubspotProductId)
    .map(r => [r.hubspotProductId!, r] as const)
);

/** Product id first, trimmed display name as the fallback. */
export function ruleForLine(line: { hubspotProductId: string; name: string }): OrderPointRule | undefined {
  return RULES_BY_PRODUCT_ID.get(line.hubspotProductId) ?? ORDER_POINT_RULES[line.name.trim()];
}

// Product types that are never physical ordering hardware. A line with one of
// these and no rule isn't "unclassified" — it simply doesn't carry points.
// Anything else with no rule (inventory, or untyped) does get flagged.
const NON_HARDWARE_PRODUCT_TYPES = ["Software", "Service"];

// Ordering points that will never appear in an inventory system or on a
// hardware line. A website IS an ordering point — Steve called this one out
// specifically — so it has to be declared on the deal or the count is wrong.
export const ORDER_POINT_CHANNELS: Array<{ id: string; label: string; note?: string }> = [
  { id: "website", label: "Website / online ordering", note: "Counts — confirmed" },
  { id: "qr", label: "QR code ordering" },
  { id: "third_party_delivery", label: "Third-party delivery" },
  { id: "phone_ai", label: "Phone-AI ordering" },
];

export const CHANNEL_LABELS: Record<string, string> = Object.fromEntries(
  ORDER_POINT_CHANNELS.map(c => [c.id, c.label])
);

export type OrderPointsBreakdown = {
  orderPoints: OrderPoints;
  /** Hardware whose contribution a human has to settle. Never silently counted, never dropped. */
  needsReview: Array<{ name: string; qty: number; reason: string }>;
  /** Hardware the mapping doesn't know about. Contributes 0, but must stay visible. */
  unclassified: Array<{ name: string; qty: number }>;
};

/**
 * The QUOTED order-point count: order-point-bearing hardware lines plus the
 * non-hardware channels declared on the deal. (The DEPLOYED count is a
 * different thing entirely and comes from aioinventory — Phase H item 4/5.)
 */
export function deriveOrderPoints(lines: QuoteLine[], channels: string[]): OrderPointsBreakdown {
  const hardware: Record<string, number> = {};
  const needsReview: OrderPointsBreakdown["needsReview"] = [];
  const unclassified: OrderPointsBreakdown["unclassified"] = [];
  let total = 0;

  for (const line of lines) {
    // Every line is run through the rules, whatever hs_product_type says. The
    // type is HubSpot data maintained by hand: an untyped or mis-typed kiosk
    // must still count its point, and must still land in `unclassified` when
    // no rule knows it — the type gate used to swallow both.
    const rule = ruleForLine(line);
    if (!rule) {
      // Software/services with no rule are 0 by definition, not a mystery.
      if (!NON_HARDWARE_PRODUCT_TYPES.includes((line.productType || "").trim())) {
        unclassified.push({ name: line.name, qty: line.qty });
      }
      continue;
    }
    if (rule.needsReview) needsReview.push({ name: line.name, qty: line.qty, reason: rule.needsReview });
    if (rule.pointsPerUnit > 0) {
      const points = rule.pointsPerUnit * line.qty;
      hardware[line.name] = (hardware[line.name] ?? 0) + points;
      total += points;
    }
  }

  const declared = ORDER_POINT_CHANNELS.filter(c => channels.includes(c.id)).map(c => c.id);
  total += declared.length;

  return { orderPoints: { hardware, channels: declared, total }, needsReview, unclassified };
}

// ── Platform tier (derived, not chosen) ─────────────────────────────────────

// The largest recurring line on any quote, and a $433/mo swing across the
// boundary, so it follows the count rather than a rep's dropdown.
export const PLATFORM_TIER_BOUNDARY = 5; // 1–5 inclusive, then 6+

export const PLATFORM_TIER_PRODUCT_NAMES = {
  small: "AIO Platform (1 to 5 Order Points)",
  large: "AIO Platform (6 + Order Points)",
} as const;

// Same reason as ORDER_POINT_RULES: the id is the stable key, the name is only
// the fallback for a catalog record we haven't seen.
export const PLATFORM_TIER_PRODUCT_IDS: Record<string, string> = {
  [PLATFORM_TIER_PRODUCT_NAMES.small]: "217526517443",
  [PLATFORM_TIER_PRODUCT_NAMES.large]: "292286544587",
};

// Not order-point tiered — a food truck is priced flat. It's the food_truck
// quote type's platform line, derived like the tiers rather than picked: a rep
// picking it by hand next to a tiered quote is how you get two platform fees.
export const FOOD_TRUCK_PLATFORM_NAME = "AIO Platform - Food Truck";
export const FOOD_TRUCK_PLATFORM_ID = "247900575472";

export function isPlatformTierProduct(name: string): boolean {
  return name === PLATFORM_TIER_PRODUCT_NAMES.small || name === PLATFORM_TIER_PRODUCT_NAMES.large;
}

/** Any derived platform line — both order-point tiers and the flat food-truck one. */
export function isPlatformProduct(name: string, id?: string): boolean {
  const trimmed = name.trim();
  return (
    isPlatformTierProduct(trimmed) ||
    trimmed === FOOD_TRUCK_PLATFORM_NAME ||
    id === FOOD_TRUCK_PLATFORM_ID ||
    (!!id && Object.values(PLATFORM_TIER_PRODUCT_IDS).includes(id))
  );
}

/** Which tier product a given order-point total selects. Zero points selects nothing. */
export function platformTierNameFor(total: number): string | null {
  if (total <= 0) return null;
  return total <= PLATFORM_TIER_BOUNDARY ? PLATFORM_TIER_PRODUCT_NAMES.small : PLATFORM_TIER_PRODUCT_NAMES.large;
}

export type PlatformLineResult =
  /** The platform line to put on the quote. */
  | { status: "resolved"; line: QuoteLine; productName: string }
  /** Zero ordering points on a processing quote — no platform fee is due yet. */
  | { status: "none_needed"; line: null; productName: null }
  /** Marketing-only: AIO's platform isn't part of this quote at all. */
  | { status: "not_applicable"; line: null; productName: null }
  /** A platform line IS due but the catalog didn't yield it. Never quietly quote without it. */
  | { status: "unresolved"; line: null; productName: string };

/**
 * The platform-fee line the quote type and order-point count imply, snapshotted
 * from the catalog like any other line. Which product that is depends on the
 * type, not on what the rep happened to pick:
 *   full_pos       → the 1–5 or 6+ tier, by count
 *   food_truck     → the flat food-truck platform, regardless of count
 *   marketing_only → none
 *
 * Returns a status rather than a bare null because the "no line" cases are not
 * the same thing: three are correct, and the fourth — a line is owed but the
 * catalog didn't yield the product — is the largest recurring charge on the
 * quote going missing. That case must reach the rep and must block the save.
 */
export function resolvePlatformLine(
  quoteType: QuoteType,
  total: number,
  catalog: CatalogProduct[]
): PlatformLineResult {
  if (!isProcessingQuote(quoteType)) return { status: "not_applicable", line: null, productName: null };

  const [productName, productId] =
    quoteType === "food_truck"
      ? [FOOD_TRUCK_PLATFORM_NAME, FOOD_TRUCK_PLATFORM_ID]
      : [platformTierNameFor(total), null];

  if (!productName) return { status: "none_needed", line: null, productName: null };

  const id = productId ?? PLATFORM_TIER_PRODUCT_IDS[productName];
  const product =
    catalog.find(p => p.hubspotProductId === id) ?? catalog.find(p => p.name.trim() === productName);
  return product
    ? { status: "resolved", line: toQuoteLine(product, 1), productName }
    : { status: "unresolved", line: null, productName };
}

/**
 * Reopen a saved quote in the configurator: the picks that produced it.
 *
 * Derived lines are dropped, because they're re-derived on the way back out —
 * keeping them would send the platform fee and the three install services back
 * as picks, and the server refuses those (they aren't pickable) rather than
 * quoting them twice.
 */
export function picksFromQuoteLines(
  lines: QuoteLine[] | null | undefined
): Array<{ hubspotProductId: string; qty: number }> {
  return (lines ?? [])
    .filter(l => !isPlatformProduct(l.name, l.hubspotProductId) && !isIncludedServiceProduct(l.hubspotProductId, l.name))
    .map(l => ({ hubspotProductId: l.hubspotProductId, qty: l.qty }));
}

// ── Discounts and delayed billing starts ────────────────────────────────────

/**
 * The cap used when no admin policy row exists yet. Not 100: an unseeded
 * settings table must not silently authorize giving the whole quote away, and
 * a published quote can never be amended. An admin can
 * raise it (up to 100) at Admin → Margin policy.
 */
export const DEFAULT_MAX_DISCOUNT_PERCENT = 50;

/** yyyy-MM-dd, and a real date — `2026-02-31` parses as March 3 if you let it. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** HubSpot's own ceiling on `hs_billing_start_delay_days`; also just a sane upper bound. */
export const MAX_BILLING_DELAY_DAYS = 365;

/**
 * Put a rep's edits onto a derived line.
 *
 * `billingStart` is STRIPPED from a one-time line rather than rejected: a
 * one-time charge has no billing schedule, HubSpot would ignore the property,
 * and the rep is never offered the control in the first place — so a value
 * arriving here is a shape artifact (a rep delayed a line, then swapped it for
 * a one-time product), not a decision worth stalling a quote over. A bad
 * discount is the opposite and is reported by `adjustmentBlockers`.
 */
export function applyLineAdjustment(line: QuoteLine, adjustment: LineAdjustment | undefined): QuoteLine {
  if (!adjustment) return line;
  const next = { ...line };

  const pct = adjustment.discountPercent;
  if (pct !== undefined && pct !== null && pct > 0) next.discountPercent = pct;
  else delete next.discountPercent;

  const start = adjustment.billingStart;
  if (start && line.billingFrequency !== "one_time") next.billingStart = start;
  else delete next.billingStart;

  return next;
}

/**
 * Everything wrong with the rep's edits, in the language of the person who has
 * to fix it. Hard refusals, not warnings — these ride onto a document that
 * cannot be edited, deleted or voided once the merchant accepts it.
 */
export function adjustmentBlockers(lines: QuoteLine[], maxDiscountPercent: number): string[] {
  const blockers: string[] = [];
  const cap = Math.min(100, Math.max(0, maxDiscountPercent));

  for (const line of lines) {
    const pct = line.discountPercent;
    if (pct !== undefined && pct !== null) {
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        blockers.push(`"${line.name}" has a discount of ${pct}%, which isn't a percentage between 0 and 100.`);
      } else if (pct > cap) {
        blockers.push(
          `"${line.name}" is discounted ${pct}%, over the ${cap}% limit AIO allows on a quote. ` +
          `Lower it, or ask an admin to raise the limit in Admin → Margin policy.`
        );
      }
    }

    const start = line.billingStart;
    if (!start) continue;
    if (start.mode === "date" && !isCalendarDate(start.date)) {
      blockers.push(`"${line.name}" has a billing start date of "${start.date}", which isn't a real yyyy-MM-dd date.`);
    }
    if (start.mode === "days" && (!Number.isInteger(start.days) || start.days < 1 || start.days > MAX_BILLING_DELAY_DAYS)) {
      blockers.push(
        `"${line.name}" delays billing by ${start.days} days — it has to be a whole number of days between 1 and ${MAX_BILLING_DELAY_DAYS}.`
      );
    }
  }

  return blockers;
}

/**
 * Reopen a saved quote's edits in the configurator, the discount/delay twin of
 * `picksFromQuoteLines`.
 *
 * Unlike the picks, DERIVED lines are kept: the platform fee and the three
 * install services are re-derived on the way back out, so a comped install
 * would silently return to full price if its adjustment weren't carried over.
 */
export function adjustmentsFromQuoteLines(lines: QuoteLine[] | null | undefined): QuoteAdjustments {
  const out: QuoteAdjustments = {};
  for (const line of lines ?? []) {
    const adjustment: LineAdjustment = {};
    if (line.discountPercent) adjustment.discountPercent = line.discountPercent;
    if (line.billingStart) adjustment.billingStart = line.billingStart;
    if (Object.keys(adjustment).length) out[line.hubspotProductId] = adjustment;
  }
  return out;
}

/** A one-line, rep- and customer-readable rendering of a delayed start. */
export function describeBillingStart(start: BillingStart): string {
  return start.mode === "date"
    ? `Billing starts ${start.date}`
    : `Billing starts ${start.days} days after checkout`;
}

// ── The one derivation ──────────────────────────────────────────────────────

export type BuiltQuote = {
  /** Platform line, then the mandatory services, then what the rep picked. */
  quoteLines: QuoteLine[];
  orderPoints: OrderPoints;
  platform: PlatformLineResult;
  includedServices: IncludedServicesResult;
  breakdown: OrderPointsBreakdown;
  totals: QuoteTotals;
  /**
   * Reasons this quote must not be sent, in rep-readable prose. Empty means
   * sendable. The client disables submit on these and the server refuses on the
   * same list, so the two can't disagree about what's blocking.
   */
  blockers: string[];
};

/**
 * Picks + channels + quote type → the whole quote. The configurator's live
 * preview and the server's authoritative derivation both call this, so the
 * money math exists once: the browser was previously running its own copy of
 * these five steps next to the server's, which is how a preview and a saved
 * quote drift apart.
 *
 * The picked lines are passed in already resolved against the catalog (the
 * caller owns which catalog it trusts); everything derived from them is decided
 * here.
 */
export function buildQuote(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  channels: string[],
  catalog: CatalogProduct[],
  /**
   * Per-line discounts and delayed billing starts, keyed by product id. Applied
   * AFTER derivation so they can land on the derived platform and install lines
   * too — which is where most of AIO's discounting actually happens.
   */
  adjustments: QuoteAdjustments = {},
  /** The admin discount cap. Defaults low on purpose; see DEFAULT_MAX_DISCOUNT_PERCENT. */
  maxDiscountPercent: number = DEFAULT_MAX_DISCOUNT_PERCENT
): BuiltQuote {
  // Marketing-only quotes have no ordering points, so declared channels are
  // dropped rather than trusted: a rep who ticks "website / online ordering"
  // must not conjure a $99/wk platform tier onto a $49/wk marketing quote.
  const effectiveChannels = isProcessingQuote(quoteType) ? channels : [];

  const breakdown = deriveOrderPoints(pickedLines, effectiveChannels);
  const platform = resolvePlatformLine(quoteType, breakdown.orderPoints.total, catalog);
  const includedServices = resolveIncludedServices(quoteType, pickedLines, catalog);

  const quoteLines = [
    ...(platform.line ? [platform.line] : []),
    ...includedServices.lines,
    ...pickedLines,
  ].map(line => applyLineAdjustment(line, adjustments[line.hubspotProductId]));

  const blockers: string[] = [...adjustmentBlockers(quoteLines, maxDiscountPercent)];
  if (platform.status === "unresolved") {
    blockers.push(
      `This quote needs the "${platform.productName}" platform product, which isn't in the HubSpot ` +
      `catalog (renamed, archived, or the catalog didn't load). Sending it would quote no platform fee at all.`
    );
  }
  for (const name of includedServices.missing) {
    blockers.push(
      `"${name}" is included on every quote but isn't in the HubSpot catalog, so it can't be priced.`
    );
  }

  return {
    quoteLines,
    orderPoints: breakdown.orderPoints,
    platform,
    includedServices,
    breakdown,
    totals: quoteTotals(quoteLines),
    blockers,
  };
}
