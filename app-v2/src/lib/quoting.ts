// Quote-line arithmetic and the ordering-point pricing rule.
//
// Pure and dependency-free on purpose: no DB, no HubSpot, no pricing.ts. That
// keeps it unit-testable AND safe to import from a client component — nothing
// in here is an AIO internal (no margin, no cost, no floor). The catalog it
// operates on is read from HubSpot server-side and passed in.

import { monthlyEquivalent } from "@/lib/utils";
import { decomposePackages, isPackageProduct, type PackageDecomposition } from "@/lib/quotePackages";
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
    !isIncludedServiceProduct(product.hubspotProductId, product.name) &&
    // Package SKUs are derived from what the cart contains, never picked. A
    // rep who could add one by hand would put a package on the quote with
    // nothing discounted underneath it — the merchant pays for it twice.
    !isPackageProduct(product.hubspotProductId)
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

/**
 * Services AIO is currently giving away, quoted at MSRP and discounted to $0.
 *
 * Straight off the AE price sheet Steve issued, effective 2026-09-18, which is
 * the source of truth for what a merchant is charged: "Installation and
 * Training are currently being offered at no charge. They will still appear on
 * customer quotes at their listed MSRP, automatically discounted to $0 — this
 * is expected, not an error." Until this shipped, EasyOB put both on at full
 * price, so every quote it built was $1,498 too high.
 *
 * NOT the WiFi package. It is a third always-included service and it is not on
 * that sheet at all — the sheet prices the network as separate hardware (Unifi
 * Router, 8 Port Switch, Access Point, U-LTE Backup Pro), so comping the $999
 * package would be inventing a discount nobody authorized.
 *
 * TO END THE PROMOTION: empty this array. The lines keep appearing, at their
 * catalog price, and nothing else has to change.
 */
export const COMPED_SERVICE_PRODUCT_IDS: string[] = [
  "223452690133", // Onsite Installation — $999
  "223152695032", // System Onboarding and Training — $499
];

export function isCompedService(line: Pick<QuoteLine, "hubspotProductId">): boolean {
  return COMPED_SERVICE_PRODUCT_IDS.includes(line.hubspotProductId);
}

/**
 * Apply the standing comp to a line that carries one.
 *
 * A DEFAULT, not an override: a rep who deliberately types a discount on this
 * line keeps it. Silently turning their 50% into 100% would be the tool
 * disagreeing with the person using it, and there are reasons to charge — a
 * second location, a re-install — that the sheet doesn't have to anticipate.
 *
 * Applied at derivation AND again after `applyLineAdjustment`, because that
 * function clears `discountPercent` whenever an adjustment carries none. A rep
 * who only delayed the billing start on the install line would otherwise have
 * silently put $999 back onto the quote — which is precisely the class of
 * error this whole change exists to remove.
 */
export function applyServiceComp(line: QuoteLine, adjustment?: LineAdjustment): QuoteLine {
  if (!isCompedService(line)) return line;
  const repSet = adjustment?.discountPercent;
  if (repSet !== undefined && repSet !== null) return line;
  return { ...line, discountPercent: 100 };
}

/**
 * Hold a package-covered line at 100% off.
 *
 * Unconditional, unlike `applyServiceComp`: a comp is a discount AIO chooses
 * to give and a rep may overrule, whereas a covered line is hardware the
 * merchant has already paid for in the package price. Charging for it again
 * is double-billing, not a commercial decision.
 *
 * It has to run LAST for the same reason the service comp does:
 * `applyLineAdjustment` clears `discountPercent` whenever the adjustment
 * carries none, and adjustments are keyed by PRODUCT id — so a rep delaying
 * billing on a product that is half covered and half remainder would
 * otherwise silently put the covered half back onto the quote at full price.
 * The rep's own discount still reaches the remainder line, which is the half
 * the merchant is actually being charged for.
 */
export function applyPackageComp(line: QuoteLine): QuoteLine {
  if (!line.coveredByPackage) return line;
  return { ...line, discountPercent: 100 };
}

/**
 * Scope a rep's discount to part of a line: `discountQty` units discounted,
 * the rest at list. Returns one line when it applies to all of them, which is
 * the ordinary case.
 *
 * A split rather than a percentage across the whole line, because the
 * percentage doesn't divide: one of three $749 units is 33.3333%, and 33.33%
 * bills $1,498.07 instead of $1,498.00. The shape is the same one the package
 * decomposition already produces, so everything downstream — the quantity
 * merge in `picksFromQuoteLines`, the round-trip in
 * `adjustmentsFromQuoteLines`, HubSpot's happiness with the same product on a
 * quote twice — is machinery that already exists.
 *
 * A `discountQty` larger than the line is CLAMPED, not refused: it means the
 * rep set it and then reduced the quantity, and "as many as I said" caps out
 * at "all of them". A `discountQty` that isn't a whole positive number is a
 * different thing and `discountQtyBlockers` refuses it.
 *
 * Runs LAST, after the two comps, and deliberately ignores a package-covered
 * line: that line is wholly paid for by the package and has nothing to scope.
 */
export function splitPartialDiscount(line: QuoteLine, adjustment: LineAdjustment | undefined): QuoteLine[] {
  const want = adjustment?.discountQty;
  if (
    !want || !Number.isInteger(want) || want <= 0 ||
    want >= line.qty ||
    line.coveredByPackage ||
    !line.discountPercent
  ) return [line];

  const rest: QuoteLine = { ...line, qty: line.qty - want };
  delete rest.discountPercent;
  return [{ ...line, qty: want }, rest];
}

/**
 * What's wrong with the rep's discount quantities. Separate from
 * `adjustmentBlockers` because `discountQty` never lands on a QuoteLine — it
 * is consumed by the split — so the persisted lines the publish preconditions
 * re-check carry no trace of it and need none.
 */
export function discountQtyBlockers(adjustments: QuoteAdjustments, lines: QuoteLine[]): string[] {
  const blockers: string[] = [];
  for (const [productId, adjustment] of Object.entries(adjustments)) {
    const qty = adjustment.discountQty;
    if (qty === undefined || qty === null) continue;
    if (!Number.isInteger(qty) || qty <= 0) {
      const name = lines.find(l => l.hubspotProductId === productId)?.name ?? productId;
      blockers.push(
        `The discount on "${name}" is set to apply to ${qty} units — that has to be a whole ` +
        `number of at least 1, or left blank to discount the whole line.`
      );
    }
  }
  return blockers;
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
    if (product) lines.push(applyServiceComp(toQuoteLine(product, 1)));
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

/**
 * Ordering points one unit of this line is worth. The rules above are the
 * single source of truth for it, and `quotePackages.ts` takes this function
 * rather than importing the table — which is what keeps the package module
 * free of any dependency on this one.
 */
export function orderPointsPerUnit(line: { hubspotProductId: string; name: string }): number {
  return ruleForLine(line)?.pointsPerUnit ?? 0;
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
 * keeping them would send the platform fee, the three install services and any
 * package SKU back as picks, and the server refuses those (they aren't
 * pickable) rather than quoting them twice.
 *
 * Quantities are SUMMED per product, because a package splits one pick into a
 * covered line and a remainder line. Two picks of the same product would
 * otherwise reach the server, and the last one written wins — silently
 * dropping whichever half the package didn't cover.
 */
export function picksFromQuoteLines(
  lines: QuoteLine[] | null | undefined
): Array<{ hubspotProductId: string; qty: number }> {
  const merged = new Map<string, number>();
  for (const l of lines ?? []) {
    if (
      isPlatformProduct(l.name, l.hubspotProductId) ||
      isIncludedServiceProduct(l.hubspotProductId, l.name) ||
      isPackageProduct(l.hubspotProductId)
    ) continue;
    merged.set(l.hubspotProductId, (merged.get(l.hubspotProductId) ?? 0) + l.qty);
  }
  return [...merged].map(([hubspotProductId, qty]) => ({ hubspotProductId, qty }));
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
      } else if (pct > cap && !((isCompedService(line) || line.coveredByPackage) && pct === 100)) {
        // A comped service or a package-covered line sitting at exactly 100%
        // is exempt: both are AIO policy — off the price sheet, and out of the
        // package the merchant is already paying for — and the cap exists to
        // bound REP discretion. Without this every quote carrying either would
        // refuse to send, since the default cap is 50%. Any other figure on
        // those lines IS a rep's choice and is capped like anything else.
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
 * The arithmetic sanity checks: a quote nobody would knowingly send, as
 * distinct from a rep's edit being out of policy (`adjustmentBlockers`) or the
 * catalog being short a product (buildQuote's own).
 *
 * Worth asserting rather than assuming because two of the three are only
 * reachable through bad CATALOG data — a price or quantity nobody in this
 * codebase chose — and all of them ride onto a document that cannot be edited,
 * voided or deleted once the merchant accepts it. "Negative" is the one the
 * discount cap can't catch on its own: the cap bounds a percentage, and a
 * negative list price turns any percentage into money owed the wrong way.
 */
export function quoteSanityBlockers(lines: QuoteLine[], totals: QuoteTotals): string[] {
  const blockers: string[] = [];

  for (const line of lines) {
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      blockers.push(
        `"${line.name}" is priced ${line.unitPrice} in the HubSpot catalog — a quote can't carry a negative or unreadable price.`
      );
    }
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      blockers.push(`"${line.name}" has a quantity of ${line.qty}, which has to be a whole number of 1 or more.`);
    }
  }

  const negativeCycle = totals.recurring.some(r => r.amount < 0);
  if (totals.oneTime < 0 || negativeCycle || totals.monthlyEquivalent < 0) {
    blockers.push(
      "This quote totals a negative amount, which would bill the customer backwards. Check the prices and discounts above."
    );
  }

  // A quote with lines on it that bills nothing is a mistake every time — a
  // merchant who genuinely owes nothing gets a rate-only quote, which has no
  // lines and never reaches here.
  if (lines.length > 0 && totals.oneTime === 0 && totals.recurring.every(r => r.amount === 0)) {
    blockers.push(
      "Every line on this quote nets to $0, so it would charge the customer nothing at all. Remove a discount or a line."
    );
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
 *
 * Package-covered lines are the exception. Their 100% is policy, re-applied by
 * `applyPackageComp` on the way out, and reading it back as a REP adjustment
 * would pin it to the product id — so the remainder half of a split line would
 * come back free too, and would stay free even after the package stopped
 * applying.
 */
export function adjustmentsFromQuoteLines(lines: QuoteLine[] | null | undefined): QuoteAdjustments {
  // How many units of each product the merchant is actually being charged for,
  // so a discounted line smaller than that total is recognised as a SPLIT and
  // its quantity is carried back. Without this a "1 of 3 free" reopens as
  // "all 3 free" — the same silent giveaway the comped-service round-trip
  // exists to prevent, in the other direction.
  const chargeable = new Map<string, number>();
  for (const line of lines ?? []) {
    if (line.coveredByPackage) continue;
    chargeable.set(line.hubspotProductId, (chargeable.get(line.hubspotProductId) ?? 0) + line.qty);
  }

  const out: QuoteAdjustments = {};
  for (const line of lines ?? []) {
    if (line.coveredByPackage) continue;
    const adjustment: LineAdjustment = {};
    if (line.discountPercent) {
      adjustment.discountPercent = line.discountPercent;
      if (line.qty < (chargeable.get(line.hubspotProductId) ?? 0)) adjustment.discountQty = line.qty;
    }
    if (line.billingStart) adjustment.billingStart = line.billingStart;
    // The undiscounted half of a split carries nothing of its own, so it adds
    // no key and can't overwrite the half that does.
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
  /**
   * Platform line, then any package SKUs, then the mandatory services and what
   * the rep picked — the latter two rewritten by the package decomposition, so
   * a line a package absorbed sits here at 100% off carrying `coveredByPackage`.
   */
  quoteLines: QuoteLine[];
  orderPoints: OrderPoints;
  platform: PlatformLineResult;
  includedServices: IncludedServicesResult;
  breakdown: OrderPointsBreakdown;
  /** Which pre-made packages the cart broke down into, and what they absorbed. */
  packages: PackageDecomposition;
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

  // The pre-made packages, resolved against the mandatory services AND the
  // picks — the QSR Kit covers the WiFi package, which is a derived line, so
  // restricting this to the picks would leave $999 of it uncovered.
  //
  // The platform line is deliberately not offered: it is recurring, and a
  // package only ever absorbs one-time charges (see quotePackages.ts). The
  // frequency filter in there would drop it anyway; not passing it says why.
  //
  // Order-point counting runs BEFORE this and on the unsplit picks, which is
  // the same count either way — splitting a line preserves its total quantity.
  const packages = decomposePackages({
    lines: [...includedServices.lines, ...pickedLines],
    catalog,
    orderPointsPerUnit,
  });

  const quoteLines = [
    ...(platform.line ? [platform.line] : []),
    ...packages.packageLines,
    ...packages.lines,
  ].flatMap(line => {
    const adjustment = adjustments[line.hubspotProductId];
    // The comps come AFTER the rep's edits — an unrelated edit on the row must
    // not clear them. An explicit discount from the rep beats the service comp
    // (see applyServiceComp) but never the package one (see applyPackageComp),
    // because a covered line is hardware the package price already bought.
    const adjusted = applyPackageComp(applyServiceComp(applyLineAdjustment(line, adjustment), adjustment));
    // Last: scoping a discount to part of the quantity splits the line in two.
    return splitPartialDiscount(adjusted, adjustment);
  });

  const totals = quoteTotals(quoteLines);

  const blockers: string[] = [
    ...adjustmentBlockers(quoteLines, maxDiscountPercent),
    ...discountQtyBlockers(adjustments, quoteLines),
    ...quoteSanityBlockers(quoteLines, totals),
    ...packages.blockers,
  ];
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
    packages,
    totals,
    blockers,
  };
}
