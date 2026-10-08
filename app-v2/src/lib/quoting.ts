// Quote-line arithmetic and the ordering-point pricing rule.
//
// Pure and dependency-free on purpose: no DB, no HubSpot, no pricing.ts. That
// keeps it unit-testable AND safe to import from a client component — nothing
// in here is an AIO internal (no margin, no cost, no floor). The catalog it
// operates on is read from HubSpot server-side and passed in.

import { monthlyEquivalent } from "@/lib/utils";
import { decomposePackages, type PackageDecomposition } from "@/lib/quotePackages";
import type {
  BillingFrequency, BillingStart, CatalogProduct, LineAdjustment, OrderPoints,
  QuoteAdjustments, QuoteLine, QuoteTotals, QuoteType, StoredQuoteType, UnitAdjustment,
} from "@/types/merchant";

// ── Quote types ─────────────────────────────────────────────────────────────

// The type is picked FIRST and everything else follows from it. It has to be,
// not inferred from what's on the quote: the mandatory install lines and the
// platform line are added to an EMPTY quote, so there's nothing to infer from
// at the moment the decision is needed.
//
// Since 2026-10-05 the type IS the plan: one quote type, one monthly platform
// product, no tiering. See PLATFORM_PRODUCTS.
// NO PRICES IN THE NOTES. The configurator reads each plan's price off the
// live catalog entry for its PLATFORM_PRODUCTS id, so the card says what
// HubSpot currently charges rather than what someone typed here once. Writing
// "$399/mo" into one of these strings reintroduces a number that goes stale
// silently — which is what they all did until 2026-10-06.
export const QUOTE_TYPES: Array<{ id: QuoteType; label: string; note: string }> = [
  {
    id: "order_pay_only",
    label: "Order & Pay Only",
    note: "Hardware, software and a processing rate.",
  },
  {
    id: "all_in_one",
    label: "All-in-One",
    note: "The full platform. Hardware, software and a processing rate.",
  },
  {
    id: "marketing_only",
    label: "Marketing Only",
    note: "Marketing alone. Kiosk bought separately.",
  },
  {
    id: "marketing_term",
    label: "Marketing — 2-Year",
    note: "2-year commitment. Mega or 27\" kiosk included.",
  },
];

/**
 * Read a persisted quote type as one of today's plans.
 *
 * The two retired values are MAPPED rather than preserved, because their
 * platform products are deactivated in HubSpot: a row left as `full_pos` can't
 * resolve a platform line at all and would simply refuse to save. "All-in-One"
 * is the successor to both — it is the full plan, and the food-truck SKU it
 * also absorbs has no replacement of its own. That re-prices an unpublished
 * legacy row ($99/wk ≈ $429/mo, or $75/wk ≈ $325/mo, both → $399/mo), which is
 * unavoidable: the old price is no longer purchasable. A PUBLISHED row is
 * untouched — `publishBillingQuote` sends `quoteLines` verbatim and never
 * re-derives.
 *
 * Rows written before quote types existed at all are null, and are full-POS
 * deals, so they map the same way.
 */
export function quoteTypeOf(stored: StoredQuoteType | null | undefined): QuoteType {
  if (stored === "full_pos" || stored === "food_truck" || stored == null) return "all_in_one";
  return stored;
}

/**
 * True for the two marketing plans. They differ only in price, term and
 * whether the kiosk is included — every selection rule treats them alike, so
 * asking this rather than naming one of them is what keeps the $299 plan from
 * quietly inheriting POS behaviour.
 */
export function isMarketingQuote(quoteType: QuoteType): boolean {
  return quoteType === "marketing_only" || quoteType === "marketing_term";
}

/** True for the plans that carry a processing rate and an ordering-point count. */
export function isProcessingQuote(quoteType: QuoteType): boolean {
  return !isMarketingQuote(quoteType);
}

/**
 * The Website add-on, $50/mo. On a marketing quote it is the one product that
 * changes what AIO is to this merchant: a website takes orders, orders take
 * card payments, and those payments run through AIO.
 */
export const WEBSITE_PRODUCT_ID = "333275576048";

/**
 * Products a merchant can only have one of, however many times a rep presses
 * "+". A restaurant has one website; two $50/mo lines for it is a billing
 * error on a document that can't be amended once published.
 *
 * A list rather than a flag on the Website alone, because the picker and the
 * server both need the answer and the next single-instance product shouldn't
 * need a second mechanism. Everything absent from it is uncapped, which is
 * the right default — most of this catalog is hardware a merchant buys
 * several of.
 */
export const SINGLE_INSTANCE_PRODUCT_IDS = [WEBSITE_PRODUCT_ID];

/** The most of this product a quote may carry, or null when there's no limit. */
export function maxQtyFor(hubspotProductId: string): number | null {
  return SINGLE_INSTANCE_PRODUCT_IDS.includes(hubspotProductId) ? 1 : null;
}

/** Whether a set of picks or quote lines carries the Website add-on. */
export function carriesWebsite(items: Array<{ hubspotProductId: string }> | null | undefined): boolean {
  return (items ?? []).some(i => i.hubspotProductId === WEBSITE_PRODUCT_ID);
}

/**
 * Does this quote carry a processing rate at all?
 *
 * Deliberately NOT the same question as `isProcessingQuote`, and the two are
 * not interchangeable. That one asks what KIND of deal this is — whether AIO
 * is putting a system in a restaurant, which decides the install services, the
 * ordering-point count and what the picker may offer. This one asks whether
 * AIO processes money for this merchant, which decides whether there is a rate
 * to quote, a statement worth reading, and an Adyen account to open.
 *
 * They came apart on 2026-10-06: a marketing merchant who buys the Website
 * sells through it, so they process — but they still have nothing on site to
 * install, no ordering points to count and no POS hardware to pick. Answering
 * either question with the other's predicate is how a website merchant ends up
 * quoted a $999 onsite installation, or billed for card processing with no
 * Adyen account behind it.
 */
export function quoteHasProcessing(
  quoteType: QuoteType,
  items: Array<{ hubspotProductId: string }> | null | undefined
): boolean {
  return isProcessingQuote(quoteType) || carriesWebsite(items);
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
//   - "AIO Pre Auth" ($0.50/Service) is DERIVED (see PRE_AUTH_PRODUCT): it goes
//     on a quote that would otherwise collect nothing at checkout, and never by hand
export const PICKER_EXCLUDED_PRODUCT_NAMES = [
  "AIO Processing Two Tiered Rate",
  "AIO Tier Processing",
  "CAMP Invoice",
  "AIO Pre Auth",
  // A pre-built POS kit. The cart is quoted as the individual products, and
  // the AMS1 that has to ship with each POS is derived — a bundle line on top
  // of that would bill the same hardware twice.
  "QSR POS Hardware Bundle",
  // The $0 package SKU. The kit is now the individual products at 100% off
  // (quotePackages.ts); this record is what that design replaced.
  "QSR Kit",
] as const;

/**
 * Everything a rep can never pick by hand. Two reasons land here:
 *   - the exclusions above — things nobody sells as a line
 *   - DERIVED lines: all three platform products, the three install services,
 *     and the additional software license (one per screen past the included
 *     four). They still land on the quote, just not by hand.
 */
export function isPickable(product: CatalogProduct): boolean {
  return (
    !PICKER_EXCLUDED_PRODUCT_NAMES.includes(product.name as (typeof PICKER_EXCLUDED_PRODUCT_NAMES)[number]) &&
    !isPlatformProduct(product.name, product.hubspotProductId) &&
    !isIncludedServiceProduct(product.hubspotProductId, product.name) &&
    !isPreAuthProduct(product.hubspotProductId, product.name) &&
    !isSoftwareLicenseProduct(product.hubspotProductId, product.name)
  );
}

// ── Selection rules per quote type ──────────────────────────────────────────

// The products a marketing quote may carry BY HAND. Confirmed with Shaheer
// 2026-10-05, replacing the 2026-08-20 pair ($49/wk Marketing Platform and
// $99/mo Add Spend) — both of those are deactivated in HubSpot.
//
// NEITHER marketing platform product is here. Both are derived platform lines
// (see PLATFORM_PRODUCTS), so like every other derived line they are never
// pickable. The 2-year term SKU was pickable until 2026-10-06, when it became
// a plan of its own.
//
// The Menu Board Computers are not here either: all three are derived onto
// every marketing quote at no charge (MARKETING_INCLUDED_HARDWARE).
export const MARKETING_PRODUCTS = [
  { name: "Marketing Kit - Mega Kiosk", hubspotProductId: "332617109238" },
  { name: "Marketing Kit - 27\" Kiosk", hubspotProductId: "332793212658" },
  { name: "Website", hubspotProductId: "333275576048" },
] as const;

/**
 * The kiosk the 2-year term includes, as the two products it may be.
 *
 * The rep picks one — the plan's HubSpot description is literally "1 x Mega
 * Kiosk or 27\" Kiosk" — and ONE unit of it is held at $0 by
 * `applyPlanIncludedKiosk`. Anything beyond the first bills at the Marketing
 * Kit price, which is why the inclusion is a line SPLIT and not a flag on the
 * product.
 *
 * Order matters only as a tiebreak: a quote carrying both gets the comp on the
 * dearer one, since the plan says "either" and the merchant should not lose by
 * also buying the other.
 */
export const MARKETING_TERM_KIOSK_IDS = [
  "332617109238", // Marketing Kit - Mega Kiosk — $1,500
  "332793212658", // Marketing Kit - 27" Kiosk — $999
];

/**
 * Hardware both marketing plans include at no charge, derived onto the quote
 * rather than picked.
 *
 * Three Menu Board Computers, straight off both plans' HubSpot descriptions
 * ("3 x Menu Board Computers (TVs are not provided or installed by AIO)").
 * They appear at MSRP discounted to $0, the same way a packaged line does, so
 * the merchant can see what they were given.
 *
 * The product stays rep-pickable on a POS quote, where it is ordinary
 * hardware at $99 — these constants only describe what a MARKETING plan
 * includes, which is why `picksFromQuoteLines` needs the quote type to know
 * whether a line of it was derived or chosen.
 */
export const MARKETING_INCLUDED_HARDWARE = [
  { name: "Menu Board Computer", hubspotProductId: "223511653103", qty: 3 },
] as const;

function isMarketingIncludedHardware(id: string, name: string): boolean {
  return MARKETING_INCLUDED_HARDWARE.some(h => h.hubspotProductId === id || h.name === name.trim());
}

function isMarketingProduct(id: string, name: string): boolean {
  return MARKETING_PRODUCTS.some(m => m.hubspotProductId === id || m.name === name.trim());
}

/** The two kiosk kits. Not the Website — that one is allowed on a POS quote. */
function isMarketingKit(id: string, name: string): boolean {
  const trimmed = name.trim();
  return MARKETING_PRODUCTS.some(
    m => m.name.startsWith("Marketing Kit") && (m.hubspotProductId === id || m.name === trimmed)
  );
}

/**
 * Whether a rep may put this product on a quote of this type. Applied to the
 * picker AND re-applied server-side, because "the rep can't see it" is not the
 * same as "it can't be sent".
 *
 * Marketing plans only carry the marketing products. Processing plans carry
 * any other pickable product except the marketing kits — those kiosks belong
 * to the marketing plans, and a POS quote sells its own hardware.
 */
export function isAllowedForQuoteType(product: CatalogProduct, quoteType: QuoteType): boolean {
  if (!isPickable(product)) return false;
  if (!isMarketingQuote(quoteType)) {
    return !isMarketingKit(product.hubspotProductId, product.name);
  }
  return isMarketingProduct(product.hubspotProductId, product.name);
}

// ── Mandatory install services (derived, not chosen) ────────────────────────

// Confirmed with Shaheer 2026-08-20: every quote that puts AIO's system in a
// restaurant includes a network, an install and a training — qty 1 each.
// Install and training stay mandatory. The WiFi package is still added by
// default, and a rep can take it off (LineAdjustment.removed) after confirming.
//
// Two exceptions, both meaning "nothing is being installed":
//   - a marketing-only quote
//   - a RATE-ONLY quote: a processing quote with no products picked at all.
//     The services attach to the products, so an empty picker means there's
//     nothing to install, no network to run and nothing to train on. Declared
//     ordering channels do NOT pull them in — a website-ordering merchant has
//     no on-site anything for a $999 install or a $999 WiFi package to cover.
export const WIFI_PRODUCT_ID = "281351401209";

export const INCLUDED_SERVICE_PRODUCTS = [
  { name: "AIO WiFi Network Package", hubspotProductId: WIFI_PRODUCT_ID },
  { name: "Onsite Installation", hubspotProductId: "223452690133" },
  { name: "System Onboarding and Training", hubspotProductId: "223152695032" },
] as const;

/**
 * POS units that ship with their own payment terminal. The kiosk SKUs already
 * name an AMS1 in the product, so they don't get a second one.
 */
export const POS_REQUIRING_TERMINAL_IDS = [
  "217445755632", // POS Unit
  "223452690130", // POS Unit - With Customer Facing Display
] as const;

/** Charged at the catalog price, one per POS unit, on top of any the rep adds. */
export const AMS1_PRODUCT = {
  name: "Payment Terminal - AMS1",
  hubspotProductId: "223511653105",
} as const;

/**
 * Screens that consume a software license: anything that runs an AIO app.
 * The first four on a processing quote are included in the platform fee.
 */
export const INCLUDED_SCREEN_COUNT = 4;

export const SCREEN_PRODUCT_IDS = [
  "217445755632", // POS Unit
  "223452690130", // POS Unit - With Customer Facing Display
  "223511653101", // mPOS
  "223452690132", // KDS (Kitchen Display System)
  "260674226888", // Mega Kiosk
  "222497165009", // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666", // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
  "223511653103", // Menu Board Computer
] as const;

/** $19/mo in the catalog, derived at one per screen past INCLUDED_SCREEN_COUNT. */
export const SOFTWARE_LICENSE_PRODUCT = {
  name: "Additional Software License",
  hubspotProductId: "335280960199",
} as const;

// Pre-built bundles that exist as HubSpot PRODUCTS. Both are retired as lines:
// a kit is now expressed by `quotePackages.ts` as the individual products at
// 100% off, so putting a bundle line on top would bill the same hardware twice.
// "QSR Kit" is the $0 record created for the package-SKU design that
// quotePackages.ts replaced (2026-10-08).
const HARDWARE_BUNDLES = [
  { id: "252941875920", name: "QSR POS Hardware Bundle" },
  { id: "333450361558", name: "QSR Kit" },
] as const;

function isIncludedServiceProduct(id: string, name: string): boolean {
  return INCLUDED_SERVICE_PRODUCTS.some(s => s.hubspotProductId === id || s.name === name.trim());
}

function isAms1Product(id: string, name: string): boolean {
  return id === AMS1_PRODUCT.hubspotProductId || name.trim() === AMS1_PRODUCT.name;
}

function isPosRequiringTerminal(line: { hubspotProductId: string }): boolean {
  return (POS_REQUIRING_TERMINAL_IDS as readonly string[]).includes(line.hubspotProductId);
}

function isSoftwareLicenseProduct(id: string, name: string): boolean {
  return id === SOFTWARE_LICENSE_PRODUCT.hubspotProductId || name.trim() === SOFTWARE_LICENSE_PRODUCT.name;
}

function isHardwareBundle(id: string, name: string): boolean {
  return HARDWARE_BUNDLES.some(b => b.id === id || b.name === name.trim());
}

/** How many app screens the picks add up to. Package-covered units still count. */
export function screenCount(lines: Array<{ hubspotProductId: string; qty: number }>): number {
  return lines.reduce(
    (n, l) => n + ((SCREEN_PRODUCT_IDS as readonly string[]).includes(l.hubspotProductId) ? l.qty : 0),
    0
  );
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

/** Whether a line is in "adjust each unit" mode. Defensive: this arrives from the browser. */
export function hasUnitAdjustments(adjustment: LineAdjustment | undefined): adjustment is LineAdjustment & { units: UnitAdjustment[] } {
  return Array.isArray(adjustment?.units);
}

/** A stable identity for a billing start, so identical units can be regrouped. */
function startSignature(start: BillingStart | null | undefined): string {
  if (!start) return "now";
  return start.mode === "date" ? `date:${start.date}` : `days:${start.days}`;
}

/**
 * Per-unit edits → lines. Unit `offset + i` of the product is the i-th unit of
 * THIS line, because a product can be on the quote as more than one line (a
 * package leaves a remainder) and the rep's units are numbered across the
 * chargeable ones.
 *
 * Each unit gets the same treatment a whole line would — the rep's edit, then
 * the service comp — and units that come out identical are folded back into one
 * line. A quantity of three with one free unit is a 1-unit line at 100% and a
 * 2-unit line at list, not three lines and not 33.3333% across all of them, for
 * the reason `splitPartialDiscount` gives: the percentage doesn't divide.
 *
 * Never called on a package-covered line; `applyPackageComp` owns those.
 */
export function splitByUnits(line: QuoteLine, adjustment: LineAdjustment & { units: UnitAdjustment[] }, offset: number): QuoteLine[] {
  const out: QuoteLine[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < line.qty; i++) {
    const raw = adjustment.units[offset + i];
    const unit: LineAdjustment = raw && typeof raw === "object"
      ? { discountPercent: raw.discountPercent, billingStart: raw.billingStart }
      : {};
    const one = applyServiceComp(applyLineAdjustment(line, unit), unit);
    const key = `${one.discountPercent ?? 0}|${startSignature(one.billingStart)}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push({ ...one, qty: 1 });
    } else {
      out[at] = { ...out[at], qty: out[at].qty + 1 };
    }
  }
  return out;
}

/**
 * The chargeable units of one product, read back off the quote's lines — one
 * entry per unit, in line order. This is what "adjust each unit" is seeded
 * with, and what `adjustmentsFromQuoteLines` reopens a mixed quote as.
 */
export function unitsFromQuoteLines(lines: QuoteLine[] | null | undefined, productId: string): UnitAdjustment[] {
  const out: UnitAdjustment[] = [];
  for (const line of lines ?? []) {
    if (line.hubspotProductId !== productId || line.coveredByPackage) continue;
    const unit: UnitAdjustment = {};
    if (line.discountPercent) unit.discountPercent = line.discountPercent;
    if (line.billingStart) unit.billingStart = line.billingStart;
    for (let i = 0; i < line.qty; i++) out.push({ ...unit });
  }
  return out;
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
  catalog: CatalogProduct[],
  /**
   * Product ids to leave off without reporting them missing. The WiFi package
   * uses this when a rep has removed it — absence is then a decision, not a
   * catalog hole. Install and training are never passed here.
   */
  omitIds: readonly string[] = []
): IncludedServicesResult {
  if (!isProcessingQuote(quoteType) || pickedLines.length === 0) return { lines: [], missing: [] };

  const lines: QuoteLine[] = [];
  const missing: string[] = [];
  for (const service of INCLUDED_SERVICE_PRODUCTS) {
    if (omitIds.includes(service.hubspotProductId)) continue;
    const product =
      catalog.find(p => p.hubspotProductId === service.hubspotProductId) ??
      catalog.find(p => p.name.trim() === service.name);
    if (product) lines.push(applyServiceComp(toQuoteLine(product, 1)));
    else missing.push(service.name);
  }
  return { lines, missing };
}

export type RequiredTerminalsResult = IncludedServicesResult & { qty: number };

/**
 * One AMS1 per POS unit, charged at the catalog price. Added on top of any
 * terminals the rep picked — those are extras. Missing from the catalog is a
 * blocker: a POS quote without the terminal it has to ship with is incomplete.
 */
export function resolveRequiredAms1(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  catalog: CatalogProduct[]
): RequiredTerminalsResult {
  if (!isProcessingQuote(quoteType)) return { lines: [], missing: [], qty: 0 };
  const qty = pickedLines.reduce((n, l) => n + (isPosRequiringTerminal(l) ? l.qty : 0), 0);
  if (qty === 0) return { lines: [], missing: [], qty: 0 };

  const product =
    catalog.find(p => p.hubspotProductId === AMS1_PRODUCT.hubspotProductId) ??
    catalog.find(p => p.name.trim() === AMS1_PRODUCT.name);
  return product
    ? { lines: [toQuoteLine(product, qty)], missing: [], qty }
    : { lines: [], missing: [AMS1_PRODUCT.name], qty };
}

export type SoftwareLicenseResult = IncludedServicesResult & { screens: number };

/**
 * One Additional Software License per screen past the four the platform fee
 * includes. Marketing plans don't get one — their screens are a different offer.
 * The license is derived, never picked, so a hand-added line can't double it.
 */
export function resolveSoftwareLicense(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  catalog: CatalogProduct[]
): SoftwareLicenseResult {
  if (!isProcessingQuote(quoteType)) return { lines: [], missing: [], screens: 0 };
  const screens = screenCount(pickedLines);
  const extra = Math.max(0, screens - INCLUDED_SCREEN_COUNT);
  if (extra === 0) return { lines: [], missing: [], screens };

  const product =
    catalog.find(p => p.hubspotProductId === SOFTWARE_LICENSE_PRODUCT.hubspotProductId) ??
    catalog.find(p => p.name.trim() === SOFTWARE_LICENSE_PRODUCT.name);
  return product
    ? { lines: [toQuoteLine(product, extra)], missing: [], screens }
    : { lines: [], missing: [SOFTWARE_LICENSE_PRODUCT.name], screens };
}

/** Fold the derived AMS1 quantity into the picks so the quote carries one line. */
function withRequiredTerminals(picks: QuoteLine[], required: RequiredTerminalsResult): QuoteLine[] {
  const extra = required.lines[0];
  if (!extra) return picks;
  const idx = picks.findIndex(l => l.hubspotProductId === extra.hubspotProductId);
  if (idx < 0) return [...picks, extra];
  return picks.map((l, i) => (i === idx ? { ...l, qty: l.qty + extra.qty } : l));
}

/**
 * The hardware a marketing plan hands over at no charge — three Menu Board
 * Computers on both plans today.
 *
 * Derived, not picked, and marked `coveredByPackage` with the plan's name, so
 * the $0 is unconditional policy for exactly the reasons a package-covered
 * line's is: the subscription already paid for it, and `applyPackageComp`
 * holds it there even after a rep edits something else on the row.
 *
 * Missing products are reported rather than skipped, same posture as the
 * install services: quoting a plan while silently omitting what it includes
 * is how a merchant finds out at delivery.
 */
export function resolveMarketingHardware(
  quoteType: QuoteType,
  catalog: CatalogProduct[]
): IncludedServicesResult {
  if (!isMarketingQuote(quoteType)) return { lines: [], missing: [] };

  const planName = PLATFORM_PRODUCTS[quoteType].name;
  const lines: QuoteLine[] = [];
  const missing: string[] = [];
  for (const included of MARKETING_INCLUDED_HARDWARE) {
    const product =
      catalog.find(p => p.hubspotProductId === included.hubspotProductId) ??
      catalog.find(p => p.name.trim() === included.name);
    // Comped here AND again in buildQuote, same as the included services: the
    // 100% has to be on the line the moment it exists, or a caller reading
    // this result on its own prices hardware the plan gives away.
    if (product) {
      lines.push(applyPackageComp({ ...toQuoteLine(product, included.qty), coveredByPackage: planName }));
    } else missing.push(included.name);
  }
  return { lines, missing };
}

/**
 * The $0.50 charge that lets a quote delay its billing.
 *
 * HubSpot won't publish a payment-enabled quote that collects under $0.50 at
 * checkout (see `MIN_CHECKOUT_AMOUNT`), and a delayed recurring line collects
 * nothing at checkout — so a quote whose hardware is comped and whose plan
 * starts billing in 60 days has NOTHING due, and can't be sent at all. This
 * product is what makes that quote sendable: a real $0.50 charge at checkout,
 * which also proves the merchant's bank details work before the first real bill.
 *
 * Already in the HubSpot catalog (`AIO Pre Auth`, $0.50, one-time). It used to
 * be listed under the picker exclusions as a per-transaction fee that made no
 * sense as a quote line; this is the one use of it that does.
 *
 * DERIVED AND UNTOUCHABLE, deliberately. A rep can't pick it, discount it,
 * delay it or change its quantity: `buildQuote` appends it AFTER every
 * adjustment has been applied, so there is no path by which an adjustment
 * reaches it. A rep who could remove it could build a quote that can't publish;
 * one who could discount it would do the same by another route.
 */
export const PRE_AUTH_PRODUCT = {
  name: "AIO Pre Auth",
  hubspotProductId: "281354281678",
} as const;

export function isPreAuthProduct(id: string, name: string): boolean {
  return id === PRE_AUTH_PRODUCT.hubspotProductId || name.trim() === PRE_AUTH_PRODUCT.name;
}

/**
 * The pre-authorization line, when — and only when — the quote needs one.
 *
 * Judged on the lines AS ADJUSTED, so it appears the moment a rep delays the
 * last recurring charge and disappears the moment they undo it. A quote that
 * already collects something at checkout is left exactly as it was: adding a
 * charge to every quote would rewrite documents AIO sends today for no reason.
 *
 * An empty quote (rate-only) never gets one — it builds no HubSpot document at
 * all, so there is no checkout to satisfy.
 */
export function resolvePreAuthLine(
  lines: QuoteLine[],
  catalog: CatalogProduct[]
): IncludedServicesResult {
  if (lines.length === 0 || amountDueAtCheckout(lines) >= MIN_CHECKOUT_AMOUNT) {
    return { lines: [], missing: [] };
  }
  const product =
    catalog.find(p => p.hubspotProductId === PRE_AUTH_PRODUCT.hubspotProductId) ??
    catalog.find(p => p.name.trim() === PRE_AUTH_PRODUCT.name);
  return product
    ? { lines: [toQuoteLine(product, 1)], missing: [] }
    : { lines: [], missing: [PRE_AUTH_PRODUCT.name] };
}

/**
 * The $0 product that states the merchant's card rates on the quote.
 *
 * HubSpot's description on it carries the actual numbers ("V/M/D Card Present
 * — 2.49% + $0.15", and so on), which is the whole point: it bills nothing and
 * exists so the rates are written on the document the merchant signs.
 */
export const PROCESSING_DISCLOSURE_PRODUCT = {
  name: "AIO Processing Two Tiered Rate",
  hubspotProductId: "260559288040",
} as const;

/**
 * The rate-disclosure line, on a marketing quote that sells through a website.
 *
 * ONLY there. A POS quote processes too and has never carried this line, and
 * adding it would rewrite the line items on every quote AIO sends — onto
 * documents that can't be amended once published. The marketing case is
 * different because nothing else on that quote says AIO touches their money:
 * a POS merchant is obviously buying payments, a marketing merchant who added
 * a $50 website is not.
 *
 * Derived rather than picked — the product is in `PICKER_EXCLUDED_PRODUCT_NAMES`
 * and stays there, so no rep can put it on a quote by hand.
 */
export function resolveProcessingDisclosure(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  catalog: CatalogProduct[]
): IncludedServicesResult {
  if (!isMarketingQuote(quoteType) || !carriesWebsite(pickedLines)) return { lines: [], missing: [] };

  const product =
    catalog.find(p => p.hubspotProductId === PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId) ??
    catalog.find(p => p.name.trim() === PROCESSING_DISCLOSURE_PRODUCT.name);
  return product
    ? { lines: [toQuoteLine(product, 1)], missing: [] }
    : { lines: [], missing: [PROCESSING_DISCLOSURE_PRODUCT.name] };
}

/**
 * Hold the ONE kiosk the 2-year term includes at $0, splitting the line when
 * the merchant bought more than one.
 *
 * The same expression as a package: the covered unit stays on the quote at
 * MSRP discounted to 100%, carrying `coveredByPackage`, and the remainder
 * bills at the Marketing Kit price. A flag on the product would have made
 * every kiosk free; a blended percentage across the line would round.
 *
 * The comp lands on the DEAREST eligible line, because the plan says "a Mega
 * or a 27\"" and a merchant who buys both should not be worse off for it.
 */
export function applyPlanIncludedKiosk(quoteType: QuoteType, lines: QuoteLine[]): QuoteLine[] {
  if (quoteType !== "marketing_term") return lines;

  let best = -1;
  lines.forEach((line, i) => {
    if (!MARKETING_TERM_KIOSK_IDS.includes(line.hubspotProductId) || line.qty < 1) return;
    if (best < 0 || line.unitPrice > lines[best].unitPrice) best = i;
  });
  if (best < 0) return lines;

  const planName = PLATFORM_PRODUCTS[quoteType].name;
  const line = lines[best];
  const covered: QuoteLine = { ...line, qty: 1, coveredByPackage: planName };
  const rest: QuoteLine[] = line.qty > 1 ? [{ ...line, qty: line.qty - 1 }] : [];
  return [...lines.slice(0, best), covered, ...rest, ...lines.slice(best + 1)];
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

/**
 * HubSpot refuses to publish a payment-enabled quote whose checkout total is
 * under this (`MIN_TOTAL_NOT_REACHED`, ACH threshold $0.50 — observed live
 * 2026-10-07). It is HubSpot's number, not ours; restated so the refusal can
 * happen BEFORE a merchant is standing at the door.
 */
export const MIN_CHECKOUT_AMOUNT = 0.5;

/**
 * What the merchant is charged at the moment they check out: every one-time
 * line, plus the FIRST payment of each recurring line that has no delayed
 * start. A recurring line with a `billingStart` takes nothing at checkout —
 * HubSpot reported `totalAmount: 0.00` for a quote whose only charge was a
 * $299/mo plan delayed 60 days, with its hardware comped by the plan.
 *
 * Distinct from `quoteTotals`, which is what the quote is WORTH. A quote can be
 * worth $299/mo and still owe $0 today.
 */
export function amountDueAtCheckout(lines: QuoteLine[]): number {
  let due = 0;
  for (const line of lines) {
    if (line.billingFrequency !== "one_time" && line.billingStart) continue;
    due += lineNetAmount(line);
  }
  return Math.round(due * 100) / 100;
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
  "Kiosk 27\" + Payment Terminal (AMS1) and Mount": { pointsPerUnit: 1, hubspotProductId: "222497165009" },
  "Kiosk Mini 15.6\" + Payment Terminal (AMS1) and Mount": { pointsPerUnit: 1, hubspotProductId: "223519571666" },
  // Steve's list counts a "Tableside AI Device"; this is that product.
  "AIO Tableside POS": { pointsPerUnit: 1, hubspotProductId: "335279520447" },
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
  "KDS (Kitchen Display System)": { pointsPerUnit: 0, hubspotProductId: "223452690132" },
  // Marketing hardware. Named for kiosks but not ordering kiosks — settled by
  // Shaheer 2026-10-05. Typed `inventory`, so without an explicit 0 they'd
  // show the rep an "unclassified hardware" warning on every marketing quote.
  "Marketing Kit - Mega Kiosk": { pointsPerUnit: 0, hubspotProductId: "332617109238" },
  "Marketing Kit - 27\" Kiosk": { pointsPerUnit: 0, hubspotProductId: "332793212658" },
  // The "website / online ordering" CHANNEL is the ordering point, declared on
  // the deal. This is the $50/mo product that builds the site; counting it too
  // would double it.
  "Website": { pointsPerUnit: 0, hubspotProductId: "333275576048" },
  "Menu Board Computer": { pointsPerUnit: 0, hubspotProductId: "223511653103" },
  "Thermal Printer": { pointsPerUnit: 0, hubspotProductId: "223511653104" },
  "Epson Sticky Printer": { pointsPerUnit: 0, hubspotProductId: "250458906315" },
  "Cash Drawer": { pointsPerUnit: 0, hubspotProductId: "222497165011" },
  "AIO WiFi Network Package": { pointsPerUnit: 0, hubspotProductId: "281351401209" },
  // Deactivated in HubSpot 2026-10, so a rep can't pick these any more. The
  // rules stay: a saved quote that already carries one must keep counting it
  // at 0 rather than start reporting it as unclassified hardware.
  "Kitchen Display for Customer": { pointsPerUnit: 0, hubspotProductId: "265825703641" },
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
 * single source of truth for it. (The hardware kit used to read this to decide
 * what could fill an ordering-point slot; it now goes by sheet MSRP instead.)
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

// ── The platform line (derived, not chosen) ─────────────────────────────────

/**
 * One plan, one platform product. The quote type IS the choice, so the largest
 * recurring line on the quote follows it rather than a rep's dropdown.
 *
 * Replaced the order-point tiers on 2026-10-05, when AIO deactivated all three
 * weekly platform SKUs in HubSpot. The count no longer prices anything (see
 * ORDER_POINT_RULES, which is now reporting only) — the plan does.
 *
 * As with ORDER_POINT_RULES, the id is the key and the name is only the
 * fallback for a catalog record renamed since this was written.
 */
export const PLATFORM_PRODUCTS: Record<QuoteType, { name: string; hubspotProductId: string }> = {
  order_pay_only: { name: "All-in-One (Order & Pay only)", hubspotProductId: "335279520445" },
  all_in_one: { name: "All-in-One Platform", hubspotProductId: "335283119838" },
  marketing_only: { name: "AIO Marketing Platform", hubspotProductId: "332609247965" },
  marketing_term: { name: "AIO Marketing Platform (2-year term)", hubspotProductId: "332927902454" },
};

/**
 * Platform products AIO no longer sells. They are deactivated in HubSpot, so
 * nothing can be quoted on one again — but saved quotes still carry their
 * lines, and `isPlatformProduct` is what keeps those out of the picks a quote
 * is reopened as. Drop one from here and reopening a 2026-era quote offers its
 * platform fee back as a rep-pickable product, next to the new plan's.
 */
const RETIRED_PLATFORM_PRODUCTS = [
  { name: "AIO Platform (1 to 5 Order Points)", hubspotProductId: "217526517443" },
  { name: "AIO Platform (6 + Order Points)", hubspotProductId: "292286544587" },
  { name: "AIO Platform - Food Truck", hubspotProductId: "247900575472" },
  // The $49/wk marketing platform. Same NAME as its $199/mo replacement, which
  // is harmless here: both are platform lines either way.
  { name: "AIO Marketing Platform", hubspotProductId: "223152695997" },
  // The SECOND $299 2-year record. HubSpot carries two, and they are NOT
  // duplicates: this one's description includes a 27" kiosk only, where
  // 332927902454 — the one `marketing_term` quotes — includes "1 x Mega Kiosk
  // or 27\" Kiosk". The choice is the offer, so this narrower twin is retired
  // and listed here so a quote that already carries it reopens without
  // offering it back as a pickable product. Deactivating it is a HubSpot-side
  // cleanup; this entry stays either way, for the rows that have it.
  { name: "AIO Marketing Platform (2-year term)", hubspotProductId: "334139877086" },
];

/** Any derived platform line, on today's plans or a retired one. */
export function isPlatformProduct(name: string, id?: string): boolean {
  const trimmed = name.trim();
  return [...Object.values(PLATFORM_PRODUCTS), ...RETIRED_PLATFORM_PRODUCTS].some(
    p => p.name === trimmed || (!!id && p.hubspotProductId === id)
  );
}

export type PlatformLineResult =
  /** The platform line to put on the quote. */
  | { status: "resolved"; line: QuoteLine; productName: string }
  /** A rate-only quote: nothing picked and no channel declared, so no plan is being sold yet. */
  | { status: "none_needed"; line: null; productName: null }
  /** A platform line IS due but the catalog didn't yield it. Never quietly quote without it. */
  | { status: "unresolved"; line: null; productName: string };

/**
 * The platform-fee line the plan implies, snapshotted from the catalog like any
 * other line. Which product that is depends on the quote type alone, not on
 * what the rep happened to pick or how many ordering points they counted.
 *
 * Returns a status rather than a bare null because the "no line" cases are not
 * the same thing: two are correct, and the third — a line is owed but the
 * catalog didn't yield the product — is the largest recurring charge on the
 * quote going missing. That case must reach the rep and must block the save.
 */
export function resolvePlatformLine(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  channels: string[],
  catalog: CatalogProduct[]
): PlatformLineResult {
  // A RATE-ONLY quote — we're quoting a processing rate and nothing else, so
  // there's no plan to charge for. Channels count here (unlike the install
  // services, which need something physical on site): a website-ordering
  // merchant with no hardware is still on the platform.
  //
  // Only a PROCESSING quote can be rate-only. A marketing plan has no rate, so
  // an empty one isn't a rate quote — it's a subscription with nothing added
  // to it yet, and it still charges.
  if (isProcessingQuote(quoteType) && pickedLines.length === 0 && channels.length === 0) {
    return { status: "none_needed", line: null, productName: null };
  }

  const { name, hubspotProductId } = PLATFORM_PRODUCTS[quoteType];
  const product =
    catalog.find(p => p.hubspotProductId === hubspotProductId) ??
    catalog.find(p => p.name.trim() === name);
  return product
    ? { status: "resolved", line: toQuoteLine(product, 1), productName: name }
    : { status: "unresolved", line: null, productName: name };
}

/**
 * Reopen a saved quote in the configurator: the picks that produced it.
 *
 * Derived lines are dropped, because they're re-derived on the way back out —
 * keeping them would send the platform fee and the three install services
 * back as picks, and the server refuses those (they aren't pickable) rather
 * than quoting them twice.
 *
 * Quantities are SUMMED per product, because a package splits one pick into a
 * covered line and a remainder line. Two picks of the same product would
 * otherwise reach the server, and the last one written wins — silently
 * dropping whichever half the package didn't cover.
 */
/** Lines that are re-derived on the way back out, so they must not come back as picks. */
function isDroppedOnReopen(line: QuoteLine, quoteType: QuoteType): boolean {
  return (
    isPlatformProduct(line.name, line.hubspotProductId) ||
    isIncludedServiceProduct(line.hubspotProductId, line.name) ||
    line.hubspotProductId === PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId ||
    isPreAuthProduct(line.hubspotProductId, line.name) ||
    isSoftwareLicenseProduct(line.hubspotProductId, line.name) ||
    isHardwareBundle(line.hubspotProductId, line.name) ||
    (isMarketingQuote(quoteType) && isMarketingIncludedHardware(line.hubspotProductId, line.name)) ||
    // Kits belong on the marketing plans. A processing quote that still carries
    // one (saved before they were taken off) must not send it back as a pick —
    // the server would refuse the whole save.
    (!isMarketingQuote(quoteType) && isMarketingKit(line.hubspotProductId, line.name))
  );
}

export function picksFromQuoteLines(
  lines: QuoteLine[] | null | undefined,
  /**
   * The plan the quote is on. Needed because one product is derived on some
   * plans and picked on others: the Menu Board Computer is hardware a rep adds
   * at $99 on a POS quote, and something a marketing plan hands over. Without
   * this, reopening a marketing quote would return its three included ones as
   * picks — which the server then refuses outright, since they aren't
   * pickable on a marketing quote.
   */
  quoteType: QuoteType
): Array<{ hubspotProductId: string; qty: number }> {
  const processing = isProcessingQuote(quoteType);
  let posQty = 0;
  let ams1Qty = 0;
  const merged = new Map<string, number>();
  for (const l of lines ?? []) {
    // Counted before the drop, because the derived AMS1 is itself dropped and
    // only the extras — quantity above one per POS — go back as a pick.
    if (processing && isPosRequiringTerminal(l)) posQty += l.qty;
    if (isAms1Product(l.hubspotProductId, l.name)) ams1Qty += l.qty;
    if (isDroppedOnReopen(l, quoteType) || isAms1Product(l.hubspotProductId, l.name)) continue;
    merged.set(l.hubspotProductId, (merged.get(l.hubspotProductId) ?? 0) + l.qty);
  }
  if (processing) {
    const extra = ams1Qty - posQty;
    if (extra > 0) merged.set(AMS1_PRODUCT.hubspotProductId, extra);
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
 * Whether the quote collects enough at checkout for HubSpot to publish it.
 *
 * Kept apart from `quoteSanityBlockers`, which is judged on the quote WITHOUT
 * its pre-authorization line: that line exists to satisfy this check, so
 * counting it in the sanity pass would let a quote that nets to $0 through
 * every real line sail past "every line nets to $0" on the strength of fifty
 * cents. This one is judged on the final lines.
 *
 * Reachable on a freshly built quote only if the pre-auth product is missing
 * from the catalog or has been repriced under the threshold — otherwise the
 * line is added and this is silent. It is the whole story for a quote saved
 * BEFORE the pre-auth existed, which `canPublishBillingQuote` re-checks.
 */
export function checkoutAmountBlockers(lines: QuoteLine[]): string[] {
  if (lines.length === 0 || amountDueAtCheckout(lines) >= MIN_CHECKOUT_AMOUNT) return [];
  return [
    "Nothing is due at checkout — every charge is either free or has a delayed billing start — and " +
    "HubSpot can't publish a quote that collects less than $0.50 up front."
  ];
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
export function adjustmentsFromQuoteLines(
  lines: QuoteLine[] | null | undefined,
  /**
   * The plan, when the caller has it. A processing quote that already has its
   * install lines but no WiFi line was saved with the package removed, and
   * reopening has to keep it removed — otherwise the derivation puts it back.
   * A channel-only quote has a platform line and no install lines, so it does
   * not count: WiFi was never applicable there.
   */
  quoteType?: QuoteType
): QuoteAdjustments {
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

  // Products whose lines disagree about WHEN billing starts, or carry more than
  // one distinct discount, can't be expressed as one line-level edit plus a
  // `discountQty` — that shape has room for a single discount and a single
  // start. They reopen in "adjust each unit" mode instead. Everything the old
  // shape could say still reopens the old way, so existing quotes are untouched.
  const shape = new Map<string, { starts: Set<string>; discounts: Set<number>; discounted: number }>();
  for (const line of lines ?? []) {
    if (line.coveredByPackage) continue;
    const s = shape.get(line.hubspotProductId) ?? { starts: new Set(), discounts: new Set(), discounted: 0 };
    s.starts.add(startSignature(line.billingStart));
    s.discounts.add(line.discountPercent || 0);
    if (line.discountPercent) s.discounted += 1;
    shape.set(line.hubspotProductId, s);
  }
  const perUnit = new Set(
    [...shape].filter(([, s]) => s.starts.size > 1 || s.discounted > 1 || s.discounts.size > 2).map(([id]) => id)
  );

  const out: QuoteAdjustments = {};
  for (const id of perUnit) out[id] = { units: unitsFromQuoteLines(lines, id) };
  for (const line of lines ?? []) {
    if (line.coveredByPackage || perUnit.has(line.hubspotProductId)) continue;
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

  if (quoteType && isProcessingQuote(quoteType)) {
    const rows = lines ?? [];
    const hasInstall =
      rows.some(l => isIncludedServiceProduct(l.hubspotProductId, l.name) && !isWifiLine(l));
    const hasWifi = rows.some(isWifiLine);
    if (hasInstall && !hasWifi) {
      out[WIFI_PRODUCT_ID] = { ...out[WIFI_PRODUCT_ID], removed: true };
    }
  }
  return out;
}

function isWifiLine(line: { hubspotProductId: string; name: string }): boolean {
  return line.hubspotProductId === WIFI_PRODUCT_ID || line.name.trim() === "AIO WiFi Network Package";
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
   * Platform line, then the mandatory services and what the rep picked — the
   * latter two rewritten by the package decomposition, so a line a package
   * absorbed sits here at 100% off carrying `coveredByPackage`. There is no
   * line for the package itself: it is free.
   */
  quoteLines: QuoteLine[];
  orderPoints: OrderPoints;
  platform: PlatformLineResult;
  includedServices: IncludedServicesResult;
  /** Hardware the marketing plans hand over at no charge. Empty on a processing quote. */
  planHardware: IncludedServicesResult;
  /** One charged AMS1 per POS unit. Empty when the quote has no POS. */
  requiredTerminals: RequiredTerminalsResult;
  /** Additional software licenses past the four screens the plan includes. */
  softwareLicense: SoftwareLicenseResult;
  /** The $0 card-rate disclosure, on a marketing quote that sells through a website. */
  processingDisclosure: IncludedServicesResult;
  /** The $0.50 checkout charge, present only when nothing else is due at checkout. Never editable. */
  preAuth: IncludedServicesResult;
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
  // Marketing-only quotes have no ordering points at all, so declared channels
  // are dropped rather than trusted: ticking "website / online ordering" on a
  // marketing quote would report an ordering point for a merchant who isn't
  // taking orders through AIO.
  const effectiveChannels = isProcessingQuote(quoteType) ? channels : [];

  // The license is derived from the screen count. A line of it arriving as a
  // pick (a stale tab, a hand-edited payload) would bill it a second time.
  const picks = pickedLines.filter(l => !isSoftwareLicenseProduct(l.hubspotProductId, l.name));

  const breakdown = deriveOrderPoints(picks, effectiveChannels);
  const platform = resolvePlatformLine(quoteType, picks, effectiveChannels, catalog);
  // Removed WiFi is a decision, not a missing product. Install and training
  // are not optional and are never omitted this way.
  const wifiRemoved = isProcessingQuote(quoteType) && adjustments[WIFI_PRODUCT_ID]?.removed === true;
  const includedServices = resolveIncludedServices(
    quoteType, picks, catalog, wifiRemoved ? [WIFI_PRODUCT_ID] : []
  );
  const requiredTerminals = resolveRequiredAms1(quoteType, picks, catalog);
  const softwareLicense = resolveSoftwareLicense(quoteType, picks, catalog);
  const planHardware = resolveMarketingHardware(quoteType, catalog);
  const processingDisclosure = resolveProcessingDisclosure(quoteType, picks, catalog);

  // The 2-year term's included kiosk, taken out of what the rep picked before
  // anything else runs: the comp is a line SPLIT, so it has to happen while
  // these are still the picks, and the covered half then flows through the
  // adjustment pass like a package-covered line.
  const picksWithInclusions = applyPlanIncludedKiosk(
    quoteType,
    withRequiredTerminals(picks, requiredTerminals)
  );

  // The hardware kit, resolved against the mandatory services AND the picks —
  // it covers the WiFi package and the AMS1 each POS ships with, both derived
  // lines, so restricting this to the picks would leave them uncovered.
  //
  // The platform line is deliberately not offered: it is recurring, and a
  // package only ever absorbs one-time charges (see quotePackages.ts). The
  // frequency filter in there would drop it anyway; not passing it says why.
  //
  // Order-point counting runs BEFORE this and on the unsplit picks, which is
  // the same count either way — splitting a line preserves its total quantity.
  const packages = decomposePackages({
    lines: [...includedServices.lines, ...picksWithInclusions],
    quoteType,
  });

  const unitCursor = new Map<string, number>();
  const chargedLines = [
    ...(platform.line ? [platform.line] : []),
    ...softwareLicense.lines,
    ...processingDisclosure.lines,
    ...planHardware.lines,
    ...packages.lines,
  ].flatMap(line => {
    const adjustment = adjustments[line.hubspotProductId];
    // "Adjust each unit" mode: the units are numbered across every chargeable
    // line of the product, so the cursor carries on from where the last one
    // stopped. Covered lines are skipped here and fall through to the package
    // comp below — they are already wholly paid for and own no units.
    if (hasUnitAdjustments(adjustment) && !line.coveredByPackage) {
      const offset = unitCursor.get(line.hubspotProductId) ?? 0;
      unitCursor.set(line.hubspotProductId, offset + line.qty);
      return splitByUnits(line, adjustment, offset);
    }
    // The comps come AFTER the rep's edits — an unrelated edit on the row must
    // not clear them. An explicit discount from the rep beats the service comp
    // (see applyServiceComp) but never the package one (see applyPackageComp),
    // because a covered line is hardware the package price already bought.
    const adjusted = applyPackageComp(applyServiceComp(applyLineAdjustment(line, adjustment), adjustment));
    // Last: scoping a discount to part of the quantity splits the line in two.
    return splitPartialDiscount(adjusted, adjustment);
  });

  // The pre-authorization comes LAST and past every adjustment on purpose: it is
  // judged on what the quote would collect after the rep's discounts and
  // delays, and nothing the rep does can reach it. See PRE_AUTH_PRODUCT.
  const preAuth = resolvePreAuthLine(chargedLines, catalog);
  const quoteLines = [...chargedLines, ...preAuth.lines];

  const totals = quoteTotals(quoteLines);

  const blockers: string[] = [
    ...adjustmentBlockers(quoteLines, maxDiscountPercent),
    ...discountQtyBlockers(adjustments, quoteLines),
    // The real lines only: fifty cents must not rescue a quote that nets to $0.
    ...quoteSanityBlockers(chargedLines, quoteTotals(chargedLines)),
    // When the product is missing, its own message below says what to fix.
    ...(preAuth.missing.length ? [] : checkoutAmountBlockers(quoteLines)),
  ];
  for (const name of preAuth.missing) {
    blockers.push(
      `This quote delays or waives every charge, so it needs the "${name}" product to collect $0.50 at ` +
      `checkout — but it isn't in the HubSpot catalog (renamed, archived, or the catalog didn't load).`
    );
  }
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
  for (const name of processingDisclosure.missing) {
    blockers.push(
      `This quote sells through a website, so it has to state the card rates — but "${name}" ` +
      `isn't in the HubSpot catalog (renamed, archived, or the catalog didn't load). The merchant ` +
      `would be signed up for card processing with no rates written on the document.`
    );
  }
  for (const name of planHardware.missing) {
    blockers.push(
      `This plan includes "${name}", which isn't in the HubSpot catalog (renamed, archived, or ` +
      `the catalog didn't load) — so it can't be put on the quote at the $0 the merchant was promised.`
    );
  }
  for (const name of requiredTerminals.missing) {
    blockers.push(
      `Every POS unit needs a "${name}", which isn't in the HubSpot catalog (renamed, archived, or ` +
      `the catalog didn't load) — so this quote can't include the terminal that has to ship with it.`
    );
  }
  for (const name of softwareLicense.missing) {
    blockers.push(
      `This quote has more than ${INCLUDED_SCREEN_COUNT} screens, so it needs an "${name}" for each ` +
      `one past that — but it isn't in the HubSpot catalog (renamed, archived, or the catalog didn't load).`
    );
  }
  // Nothing on the quote exceeds its own limit. Summed per PRODUCT rather
  // than checked per line, because a scoped discount splits one pick into two
  // lines — two Websites of qty 1 each would otherwise pass a per-line check.
  const qtyByProduct = new Map<string, { name: string; qty: number }>();
  for (const line of quoteLines) {
    const prev = qtyByProduct.get(line.hubspotProductId);
    qtyByProduct.set(line.hubspotProductId, {
      name: line.name,
      qty: (prev?.qty ?? 0) + line.qty,
    });
  }
  for (const [productId, { name, qty }] of qtyByProduct) {
    const max = maxQtyFor(productId);
    if (max != null && qty > max) {
      blockers.push(
        `This quote has ${qty} × "${name}" on it. A merchant can only have ${max} — drop the extras.`
      );
    }
  }

  // The kiosk is part of what $299/mo buys, so a 2-year quote without one is
  // incomplete rather than cheap: the merchant pays the committed price and
  // the hardware they were promised never appears on the document.
  if (
    quoteType === "marketing_term" &&
    !quoteLines.some(l => MARKETING_TERM_KIOSK_IDS.includes(l.hubspotProductId))
  ) {
    blockers.push(
      `The 2-year marketing plan includes one kiosk at no cost — add a Marketing Kit (Mega Kiosk ` +
      `or 27") so the merchant gets the hardware they're paying for.`
    );
  }

  return {
    quoteLines,
    orderPoints: breakdown.orderPoints,
    platform,
    includedServices,
    planHardware,
    requiredTerminals,
    softwareLicense,
    processingDisclosure,
    preAuth,
    breakdown,
    packages,
    totals,
    blockers,
  };
}
