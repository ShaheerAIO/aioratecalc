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
 * The most of each product one quote may carry, by HubSpot product id.
 *
 * ADMIN-EDITABLE at /admin/settings/quote-limits (`quote_limit_policy`). This
 * is what an unseeded policy row falls back to AND what the editor is seeded
 * from, so a cap nobody has touched is still a real cap rather than an absence.
 *
 * Two different reasons to be in here. The Website and the WiFi package are
 * ONE per restaurant as a matter of fact — a second $50/mo website line is a
 * billing error on a document that can't be amended once published. The rest
 * are "nobody fits this many in one restaurant", which is the whole point of
 * the cap: the quantity box takes a typed number now (so a rep can enter 25
 * without pressing + twenty-five times), and a box that accepts 25 also
 * accepts 250.
 *
 * Everything ABSENT is uncapped, and that stays the right default: the catalog
 * is maintained in HubSpot by non-engineers, and a product added there must
 * not arrive capped at some number nobody chose.
 */
export const DEFAULT_UNIT_CAPS: Record<string, number> = {
  "333275576048": 1,  // Website
  "281351401209": 1,  // AIO WiFi Network Package
  "217445755632": 10, // POS Unit
  "223452690130": 10, // POS Unit - With Customer Facing Display
  "318736467644": 10, // Customer Facing Display
  "223511653105": 20, // Payment Terminal - AMS1
  "260674226888": 6,  // Mega Kiosk
  "222497165009": 6,  // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666": 6,  // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
  "335279520447": 20, // AIO Tableside POS
  "223511653101": 10, // mPOS
  "223452690132": 10, // KDS (Kitchen Display System)
  "223511653104": 10, // Thermal Printer
  "250458906315": 10, // Epson Sticky Printer
  "222497165011": 10, // Cash Drawer
  "223511653103": 10, // Menu Board Computer
  "276751313619": 20, // Orders Hub Tablet
  "276754193118": 20, // Clock in Tablet
};

/** The most of this product a quote may carry, or null when there's no limit. */
export function maxQtyFor(
  hubspotProductId: string,
  caps: Record<string, number> = DEFAULT_UNIT_CAPS
): number | null {
  const cap = caps[hubspotProductId];
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/** Whether a set of picks or quote lines carries the Website add-on. */
export function carriesWebsite(items: Array<{ hubspotProductId: string }> | null | undefined): boolean {
  return (items ?? []).some(i => i.hubspotProductId === WEBSITE_PRODUCT_ID);
}

/**
 * Whether the Website on a marketing quote takes online orders. Optional
 * (Shaheer, 2026-10-08): a website can be just a website, and only one that
 * takes orders puts card payments through AIO. Off unless the rep turns it on.
 */
export function websiteTakesOrders(
  items: Array<{ hubspotProductId: string }> | null | undefined,
  adjustments: QuoteAdjustments | null | undefined
): boolean {
  return carriesWebsite(items) && adjustments?.[WEBSITE_PRODUCT_ID]?.onlineOrdering === true;
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
 * They came apart on 2026-10-06: a marketing merchant whose Website takes
 * online orders sells through it, so they process — but they still have
 * nothing on site to install, no ordering points to count and no POS hardware
 * to pick. Answering either question with the other's predicate is how a
 * website merchant ends up quoted a $999 onsite installation, or billed for
 * card processing with no Adyen account behind it.
 *
 * Two inputs, because callers hold one of two things. The configurator hosts
 * hold PICKS plus the rep's adjustments, where the online-ordering toggle
 * lives. Everything downstream holds SAVED lines, where the toggle has become
 * the card-rate disclosure line — present exactly when the Website takes
 * orders, and on every website quote saved before the toggle existed, which
 * is what keeps those rows processing.
 */
export function quoteHasProcessing(
  quoteType: QuoteType,
  items: Array<{ hubspotProductId: string }> | null | undefined,
  adjustments?: QuoteAdjustments | null
): boolean {
  if (isProcessingQuote(quoteType)) return true;
  if ((items ?? []).some(i => i.hubspotProductId === PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId)) return true;
  return websiteTakesOrders(items, adjustments);
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
// The Menu Board Computer IS here, and is an ordinary pick. The plan still
// includes three at no charge (MARKETING_INCLUDED_HARDWARE), but it stopped
// DERIVING them on 2026-10-09: not every marketing merchant wants three, some
// want none, and some want more and will pay for them. The rep sets the
// quantity and `applyPlanIncludedHardware` holds the first three at $0.
export const MARKETING_PRODUCTS = [
  { name: "Marketing Kit - Mega Kiosk", hubspotProductId: "332617109238" },
  { name: "Marketing Kit - 27\" Kiosk", hubspotProductId: "332793212658" },
  { name: "Website", hubspotProductId: "333275576048" },
  { name: "Menu Board Computer", hubspotProductId: "223511653103" },
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
 * Hardware both marketing plans include at no charge, as a CEILING on what is
 * free rather than a quantity that is derived.
 *
 * Three Menu Board Computers, straight off both plans' HubSpot descriptions
 * ("3 x Menu Board Computers (TVs are not provided or installed by AIO)").
 *
 * Until 2026-10-09 exactly three were derived onto every marketing quote and
 * the product was unpickable there, so a merchant who wanted none still got
 * three and a merchant who wanted five could not be sold the other two. Now
 * the rep picks the quantity like any other product and
 * `applyPlanIncludedHardware` holds the first `qty` of them at $0; anything
 * beyond that bills at the catalog price.
 *
 * The product is ordinary $99 hardware on a POS quote — these constants only
 * describe what a MARKETING plan hands over.
 */
export const MARKETING_INCLUDED_HARDWARE = [
  { name: "Menu Board Computer", hubspotProductId: "223511653103", qty: 3 },
] as const;

/**
 * Hold the units a marketing plan includes at $0, splitting the line when the
 * merchant bought more than the plan covers.
 *
 * The same expression as `applyPlanIncludedKiosk` and as a package-covered
 * line: covered units stay on the quote at MSRP discounted 100%, carrying
 * `coveredByPackage`, so the merchant can see what they were given and
 * `applyPackageComp` holds it there however the rep edits the row.
 */
export function applyPlanIncludedHardware(quoteType: QuoteType, lines: QuoteLine[]): QuoteLine[] {
  if (!isMarketingQuote(quoteType)) return lines;
  const planName = PLATFORM_PRODUCTS[quoteType].name;

  return lines.flatMap(line => {
    const included = MARKETING_INCLUDED_HARDWARE.find(
      h => h.hubspotProductId === line.hubspotProductId || h.name === line.name.trim()
    );
    if (!included || line.coveredByPackage || line.qty < 1) return [line];

    const free = Math.min(line.qty, included.qty);
    const covered: QuoteLine = { ...line, qty: free, coveredByPackage: planName };
    return line.qty > free ? [covered, { ...line, qty: line.qty - free }] : [covered];
  });
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

/**
 * Charged at the catalog price, at least one per POS unit. The rep picks it
 * like any other product and the configurator moves it with the POS stepper;
 * `resolveRequiredAms1` only tops up a quote that arrives with too few.
 */
export const AMS1_PRODUCT = {
  name: "Payment Terminal - AMS1",
  hubspotProductId: "223511653105",
} as const;

/**
 * Hardware that moves with a POS unit's quantity: add a POS and one of each
 * of these is added beside it, take the POS off and they come off again.
 * Product owner, 2026-10-09 — "CFD + cash drawer + adyen should automatically
 * add when adding in a POS".
 *
 * A CONVENIENCE, not a requirement, and only the terminal is otherwise.
 * `minimumTerminalsFor` is the real rule that one AMS1 ships with every POS
 * and it is enforced server-side; the display and the drawer are simply what
 * a POS is nearly always sold with, so a rep who doesn't want them can step
 * them straight back down. That is why the floor stays on the AMS1 alone.
 *
 * `withProductIds` is which POS pulls which companion, and the display is the
 * reason it exists: "POS Unit - With Customer Facing Display" has one in the
 * box, so adding a second would bill the merchant twice for the same screen.
 */
export const POS_COMPANIONS = [
  {
    name: AMS1_PRODUCT.name,
    hubspotProductId: AMS1_PRODUCT.hubspotProductId,
    withProductIds: POS_REQUIRING_TERMINAL_IDS,
  },
  {
    name: "Customer Facing Display",
    hubspotProductId: "318736467644",
    withProductIds: ["217445755632"] as readonly string[], // the plain POS Unit only
  },
  {
    name: "Cash Drawer",
    hubspotProductId: "222497165011",
    withProductIds: POS_REQUIRING_TERMINAL_IDS,
  },
] as const;

/**
 * The ordering kiosks. Nothing adds a terminal for these — two of the three
 * name an AMS1 in the SKU itself — but a rep selling one still often needs one
 * (product owner, 2026-10-09: "a reminder with Kiosk to add it, because they
 * could use the kiosk for marketing only but still need to remind them they
 * might need it"), so the terminal row says so rather than a quantity nobody
 * asked for appearing.
 *
 * The Mega Kiosk is the sharp end of it: unlike the other two it carries no
 * terminal at all (see PRODUCT_PARTS in quotePackages.ts), so a Mega sold for
 * ordering needs one bought beside it.
 */
export const KIOSK_PRODUCT_IDS: readonly string[] = [
  "260674226888", // Mega Kiosk — no terminal in the SKU
  "222497165009", // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666", // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
];

/** The companions a change to this product's quantity should carry with it. */
export function companionsFor(hubspotProductId: string): typeof POS_COMPANIONS[number][] {
  return POS_COMPANIONS.filter(c => (c.withProductIds as readonly string[]).includes(hubspotProductId));
}

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
  // Both tablets run an AIO app, so each one takes a license like any other
  // screen (Shaheer, 2026-10-08). They still count 0 ordering points.
  "276751313619", // Orders Hub Tablet
  "276754193118", // Clock in Tablet
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

export function isPosRequiringTerminal(line: { hubspotProductId: string }): boolean {
  return (POS_REQUIRING_TERMINAL_IDS as readonly string[]).includes(line.hubspotProductId);
}

/** The fewest AMS1 terminals these picks may carry: one per POS unit. */
export function minimumTerminalsFor(
  quoteType: QuoteType,
  picks: Array<{ hubspotProductId: string; qty: number }>
): number {
  if (!isProcessingQuote(quoteType)) return 0;
  return picks.reduce((n, p) => n + (isPosRequiringTerminal(p) ? p.qty : 0), 0);
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
 * The AMS1 terminals a quote is short of: one per POS unit, less the ones the
 * rep already picked. Picked terminals COUNT toward the minimum — they are not
 * extras on top of it — so a configurator that keeps the stepper at or above
 * the POS count never triggers this, and `qty` is 0. It exists for a payload
 * that arrives under the minimum (a stale tab, a hand-edited request): the
 * terminal has to ship with the POS, so it is added rather than refused.
 * Missing from the catalog is a blocker: a POS quote without the terminal it
 * has to ship with is incomplete.
 */
export function resolveRequiredAms1(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  catalog: CatalogProduct[]
): RequiredTerminalsResult {
  const required = minimumTerminalsFor(quoteType, pickedLines);
  const picked = pickedLines.reduce((n, l) => n + (isAms1Product(l.hubspotProductId, l.name) ? l.qty : 0), 0);
  const qty = Math.max(0, required - picked);
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
 * The rate-disclosure line, on a marketing quote whose website takes online
 * orders. A website without online ordering takes no payments, so it gets none.
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
  catalog: CatalogProduct[],
  adjustments: QuoteAdjustments = {}
): IncludedServicesResult {
  if (!isMarketingQuote(quoteType) || !websiteTakesOrders(pickedLines, adjustments)) return { lines: [], missing: [] };

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

/**
 * The plans whose subscription includes the Website. Preselected on them, and
 * held at $0.
 *
 * It has moved twice. Added for All-in-One on 2026-10-07; the 2026-10-09 notes
 * said "Website removed from All-in-one" and it was emptied; the product owner
 * corrected that the same day — "website is included in all in one package" —
 * and it is back. The written note is the one that was wrong.
 *
 * A list you can empty rather than a hardcoded plan check, for the same reason
 * `COMPED_SERVICE_PRODUCT_IDS` is: this has now changed three times in three
 * days, and each time it should be one word.
 */
export const PLANS_INCLUDING_WEBSITE: readonly QuoteType[] = ["all_in_one"];

export function planIncludesWebsite(quoteType: QuoteType): boolean {
  return PLANS_INCLUDING_WEBSITE.includes(quoteType);
}

/**
 * The Website the All-in-One plan includes, marked as covered by the plan so
 * `applyPackageComp` holds it at 100% off — the same expression as the
 * 2-year term's kiosk. The Website is single-instance, so the whole line is
 * the included one; a rep can still take it off the quote.
 */
export function applyPlanIncludedWebsite(quoteType: QuoteType, lines: QuoteLine[]): QuoteLine[] {
  if (!planIncludesWebsite(quoteType)) return lines;
  const planName = PLATFORM_PRODUCTS[quoteType].name;
  return lines.map(l => (l.hubspotProductId === WEBSITE_PRODUCT_ID ? { ...l, coveredByPackage: planName } : l));
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
    // Kits belong on the marketing plans. A processing quote that still carries
    // one (saved before they were taken off) must not send it back as a pick —
    // the server would refuse the whole save.
    (!isMarketingQuote(quoteType) && isMarketingKit(line.hubspotProductId, line.name))
  );
}

export function picksFromQuoteLines(
  lines: QuoteLine[] | null | undefined,
  /**
   * The plan the quote is on. Needed because one product group is sellable on
   * some plans and not others: the marketing kiosks belong to the marketing
   * plans, so a POS quote that still carries one (saved before they were taken
   * off) must not send it back as a pick — the server refuses the whole save.
   *
   * What the plan COMPS does come back as a pick, covered lines included: the
   * three free Menu Board Computers and the 2-year term's kiosk are ordinary
   * picks whose first N units a comp holds at $0, so reopening has to return
   * the quantity the rep chose and let the comp re-apply on the way out.
   */
  quoteType: QuoteType
): Array<{ hubspotProductId: string; qty: number }> {
  // The AMS1 comes back whole, like any pick: picked terminals count toward
  // the one-per-POS minimum, so the saved total is exactly what to reopen as.
  const merged = new Map<string, number>();
  for (const l of lines ?? []) {
    if (isDroppedOnReopen(l, quoteType)) continue;
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

/**
 * Whole days from today to a yyyy-MM-dd date, so a dated billing start can be
 * measured against the same ceiling a day count is. Both ends are read at UTC
 * midnight, which is what `isCalendarDate` already guarantees of the input; a
 * date in the past comes back 0 rather than negative, since it collects at
 * checkout and is nobody's idea of a long delay.
 */
function daysUntil(date: string): number {
  const then = new Date(`${date}T00:00:00Z`).getTime();
  const now = Date.now();
  return Math.max(0, Math.ceil((then - now) / 86_400_000));
}

/** One wording for "too long a delay", so the two modes can't disagree about the fix. */
function delayTooLong(name: string, what: string, capDays: number): string {
  return (
    `"${name}" ${what}, past the ${capDays}-day limit AIO allows without approval. ` +
    `Shorten it, or ask an admin to raise the limit in Admin → Quote limits.`
  );
}

/** yyyy-MM-dd, and a real date — `2026-02-31` parses as March 3 if you let it. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** HubSpot's own ceiling on `hs_billing_start_delay_days`; also just a sane upper bound. */
export const MAX_BILLING_DELAY_DAYS = 365;

/**
 * The longest billing delay a rep may set on their own, before an admin has to
 * raise it. 90 days, at the product owner's request (2026-10-09) — "require a
 * long delay such as 90 days+ to be approved".
 *
 * There is no approval QUEUE and deliberately so: the approval is an admin
 * raising the ceiling at Admin → Quote limits, exactly the way the discount cap
 * already works. A rep asks, an admin decides, and the change is visible in one
 * place rather than becoming a workflow nobody maintains.
 *
 * Distinct from MAX_BILLING_DELAY_DAYS above, which is HubSpot's hard limit and
 * is not anyone's to raise.
 */
export const DEFAULT_MAX_APPROVED_DELAY_DAYS = 90;

/**
 * The billing delay a plan starts with — 60 days on the two POS plans
 * (product owner, 2026-10-09: "automatically add in billing after 60 days for
 * all-in-one and order/pay only, then let them adjust if needed").
 *
 * A SEEDED DEFAULT, not a derived value, and the distinction is the whole
 * design. It is written into `adjustments` when a plan is chosen, so it is an
 * ordinary rep edit from that moment on: the rep can change it, or set the
 * line back to "At checkout" and have it stay there. Derived in `buildQuote`
 * instead, clearing it would delete the adjustment and the 60 days would
 * silently come back on the next render.
 */
export const PLAN_DEFAULT_BILLING_DELAY_DAYS = 60;

/** The billing start a newly chosen plan seeds onto its recurring lines, if any. */
export function planDefaultBillingStart(quoteType: QuoteType): BillingStart | null {
  return isProcessingQuote(quoteType)
    ? { mode: "days", days: PLAN_DEFAULT_BILLING_DELAY_DAYS }
    : null;
}

/**
 * The admin limits that aren't the discount cap: per-product quantity caps and
 * the longest billing delay a rep may set unaided. One row in
 * `quote_limit_policy`, read together, passed to `buildQuote` together.
 */
export type QuoteLimits = {
  unitCaps: Record<string, number>;
  maxBillingDelayDays: number;
};

export const DEFAULT_QUOTE_LIMITS: QuoteLimits = {
  unitCaps: DEFAULT_UNIT_CAPS,
  maxBillingDelayDays: DEFAULT_MAX_APPROVED_DELAY_DAYS,
};

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
export function adjustmentBlockers(
  lines: QuoteLine[],
  maxDiscountPercent: number,
  /**
   * The admin-set ceiling on a delayed billing start. Capped by HubSpot's own
   * limit, which no admin may raise past.
   */
  maxBillingDelayDays: number = DEFAULT_MAX_APPROVED_DELAY_DAYS
): string[] {
  const blockers: string[] = [];
  const cap = Math.min(100, Math.max(0, maxDiscountPercent));
  const delayCap = Math.min(MAX_BILLING_DELAY_DAYS, Math.max(1, maxBillingDelayDays));

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
    if (start.mode === "date") {
      if (!isCalendarDate(start.date)) {
        blockers.push(`"${line.name}" has a billing start date of "${start.date}", which isn't a real yyyy-MM-dd date.`);
      } else {
        // A date is checked against the SAME ceiling as a day count, or
        // "On a date" would be the way around it — a rep picking a day six
        // months out is making exactly the decision the ceiling exists to
        // put in front of an admin.
        const days = daysUntil(start.date);
        if (days > delayCap) {
          blockers.push(delayTooLong(line.name, `starts billing on ${start.date}, about ${days} days out`, delayCap));
        }
      }
    }
    if (start.mode === "days") {
      if (!Number.isInteger(start.days) || start.days < 1 || start.days > MAX_BILLING_DELAY_DAYS) {
        blockers.push(
          `"${line.name}" delays billing by ${start.days} days — it has to be a whole number of days between 1 and ${MAX_BILLING_DELAY_DAYS}.`
        );
      } else if (start.days > delayCap) {
        blockers.push(delayTooLong(line.name, `delays billing by ${start.days} days`, delayCap));
      }
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

  // The online-ordering toggle is saved as the disclosure line it produces.
  // Without this, reopening a website quote that takes orders turns it off.
  if ((lines ?? []).some(l => l.hubspotProductId === PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId)) {
    out[WEBSITE_PRODUCT_ID] = { ...out[WEBSITE_PRODUCT_ID], onlineOrdering: true };
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
  /** AMS1 terminals added to reach one per POS unit. Empty when the picks already carry enough. */
  requiredTerminals: RequiredTerminalsResult;
  /** Additional software licenses past the four screens the plan includes. */
  softwareLicense: SoftwareLicenseResult;
  /** The $0 card-rate disclosure, on a marketing quote whose website takes online orders. */
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
  maxDiscountPercent: number = DEFAULT_MAX_DISCOUNT_PERCENT,
  /**
   * The other two admin limits — per-product quantity caps and the longest
   * billing delay a rep may set without an admin raising it.
   *
   * Their own parameter rather than folded in beside `maxDiscountPercent`
   * because that one is positional in roughly a hundred existing call sites;
   * turning the pair into one options object would rewrite every one of them
   * to change nothing. They travel together here because they arrive together,
   * off the single `quote_limit_policy` row.
   */
  limits: QuoteLimits = DEFAULT_QUOTE_LIMITS
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
  const processingDisclosure = resolveProcessingDisclosure(quoteType, picks, catalog, adjustments);

  // Everything a PLAN hands over at no charge, taken out of what the rep
  // picked before anything else runs: the 2-year term's kiosk, the marketing
  // plans' three menu boards, and (when a plan is listed for it) the Website.
  // Each comp is a line SPLIT, so it has to happen while these are still the
  // picks; the covered halves then flow through the adjustment pass like a
  // package-covered line.
  const picksWithInclusions = applyPlanIncludedWebsite(
    quoteType,
    applyPlanIncludedHardware(
      quoteType,
      applyPlanIncludedKiosk(quoteType, withRequiredTerminals(picks, requiredTerminals))
    )
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
    ...adjustmentBlockers(quoteLines, maxDiscountPercent, limits.maxBillingDelayDays),
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
      `This quote's website takes online orders, so it has to state the card rates — but "${name}" ` +
      `isn't in the HubSpot catalog (renamed, archived, or the catalog didn't load). The merchant ` +
      `would be signed up for card processing with no rates written on the document.`
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
    const max = maxQtyFor(productId, limits.unitCaps);
    if (max != null && qty > max) {
      blockers.push(
        `This quote has ${qty} × "${name}" on it, over the limit of ${max}. Drop the extras, or ask ` +
        `an admin to raise it in Admin → Quote limits.`
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
