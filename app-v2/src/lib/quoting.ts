// Quote-line arithmetic and the ordering-point pricing rule.
//
// Pure and dependency-free on purpose: no DB, no HubSpot, no pricing.ts. That
// keeps it unit-testable AND safe to import from a client component — nothing
// in here is an AIO internal (no margin, no cost, no floor). The catalog it
// operates on is read from HubSpot server-side and passed in.

import { fmt$, monthlyEquivalent } from "@/lib/utils";
import { decomposePackages, kitFor, type PackageDecomposition } from "@/lib/quotePackages";
import type {
  BillingFrequency, BillingStart, CatalogProduct, LineAdjustment, OrderPoints,
  QuoteAdjustments, QuoteLine, QuoteRates, QuoteTotals, QuoteType, StoredQuoteType, UnitAdjustment,
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
// Order here is the picker's display order — nothing reads this array
// positionally. `quoteTypeOf` above matches on the id directly, and
// AccountsDashboard's QUOTE_TYPE_LABELS is a Map keyed by id, so both are
// order-independent; only ProductConfigurator's `planCards` renders `types`
// in array order. It has moved three times: swapped to lead with All-in-One
// on 10/6, back to lead with Order & Pay Only on 10/13, and back to leading
// with All-in-One again on 10/15 (product owner: "aio, order n pay, marketing
// should be the order of the packages") — this is that order: All-in-One,
// Order & Pay Only, then the ordering-without-a-POS plan and Marketing Only.
// The 2-year kiosk-loan plan was retired 2026-10-27 (see `quoteTypeOf`).
export const QUOTE_TYPES: Array<{ id: QuoteType; label: string; note: string }> = [
  {
    id: "all_in_one",
    label: "All-in-One",
    note: "The full platform. Hardware, software and a processing rate.",
  },
  {
    id: "order_pay_only",
    label: "Order & Pay Only",
    note: "Hardware, software and a processing rate.",
  },
  {
    id: "marketing_partial",
    label: "Marketing Partial Ordering",
    note: "Online and/or kiosk ordering, no POS. Marketing optional.",
  },
  {
    id: "marketing_only",
    label: "Marketing Only",
    note: "Marketing alone. Mega kiosk loaned or bought separately.",
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
 *
 * `marketing_term`, the $299 2-year plan that included one kiosk, was retired
 * 2026-10-27 (product owner): the kiosk is now the $100/mo Mega Kiosk Loaner
 * on top of Marketing Only, which is the same $299. A row on it reopens as
 * Marketing Only, and `picksFromQuoteLines` turns the kiosk the plan covered
 * into one Loaner, so the money doesn't move.
 */
export function quoteTypeOf(stored: StoredQuoteType | null | undefined): QuoteType {
  if (stored === "full_pos" || stored === "food_truck" || stored == null) return "all_in_one";
  if (stored === "marketing_term") return "marketing_only";
  return stored;
}

/**
 * True for Marketing Only, the one plan AIO doesn't process for. Marketing
 * Partial Ordering carries marketing too, but it takes orders and so payments,
 * which makes it a processing plan — see `includesMarketing` for the question
 * of whether a quote carries marketing at all.
 */
export function isMarketingQuote(quoteType: QuoteType): boolean {
  return quoteType === "marketing_only";
}

/** Marketing Partial Ordering: ordering without a POS (2026-10-27). */
export function isPartialOrderingQuote(quoteType: QuoteType): boolean {
  return quoteType === "marketing_partial";
}

/** True for the plans that carry a processing rate and an ordering-point count. */
export function isProcessingQuote(quoteType: QuoteType): boolean {
  return !isMarketingQuote(quoteType);
}

/**
 * The Website add-on, $50/mo on every plan. Since 2026-10-27 it is a website
 * and nothing more — it does not take orders (the scenario sheet: "Website
 * alone does not include online ordering"). Online ordering is its own line.
 */
export const WEBSITE_PRODUCT_ID = "333275576048";

/**
 * A product this code knows by id, falling back to its exact name — the shape
 * for a 2026-10-27 product whose HubSpot record didn't exist yet. An empty id
 * never equals a real one, so the lookup falls through to the name; once the
 * id is filled in the name only matters for a record renamed since.
 */
type NamedProduct = { name: string; hubspotProductId: string };

export function isNamedProduct(product: NamedProduct, line: { hubspotProductId: string; name?: string }): boolean {
  return (
    (product.hubspotProductId !== "" && line.hubspotProductId === product.hubspotProductId) ||
    (line.name ?? "").trim() === product.name
  );
}

/**
 * Online ordering, $0/mo — an ordering point on its own, website or not
 * (product owner, 2026-10-27: "maybe we can offer online ordering without a
 * website"). A line rather than a flag so the merchant reads it on the quote
 * and a reopened quote can tell it's there.
 */
export const ONLINE_ORDERING_PRODUCT: NamedProduct = { name: "Online Ordering", hubspotProductId: "343374665412" };

/**
 * Marketing on a Marketing Partial Ordering quote, $0/mo: the plan is $299
 * either way, and this line is what says the merchant took the marketing
 * half — and so the three free menu boards (product owner, 2026-10-27).
 * Not optional since 2026-10-30: every MPO quote carries it, forced in by
 * `buildQuote` (`resolvePartialOrderingMarketing`).
 */
export const MARKETING_ADDON_PRODUCT: NamedProduct = { name: "Marketing (Partial Ordering)", hubspotProductId: "343579168455" };

/** The Mega Kiosk on loan, $100/mo each, on any plan. Created 2026-10-27. */
export const MEGA_LOANER_PRODUCT_ID = "343373224660";

/** Whether this quote carries AIO's marketing, which is what brings the three menu boards. */
export function includesMarketing(
  quoteType: QuoteType,
  items: Array<{ hubspotProductId: string; name?: string }> | null | undefined
): boolean {
  if (isMarketingQuote(quoteType)) return true;
  return isPartialOrderingQuote(quoteType) && (items ?? []).some(i => isNamedProduct(MARKETING_ADDON_PRODUCT, i));
}

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
  "338690209525": 1,  // AIO Wifi Network Package - Unifi
  "217445755632": 10, // POS Unit
  "223452690130": 10, // POS Unit - With Customer Facing Display
  "318736467644": 10, // Customer Facing Display
  "223511653105": 20, // Payment Terminal - AMS1
  "260674226888": 6,  // Mega Kiosk (Marketing Only)
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
  // The marketing kits were the one uncapped family (Elizabeth Phillips,
  // 2026-10-12: "limit quantity if marketing products too"). Six, like the
  // ordering kiosks they are — the 2-year plan's own "one kiosk, Mega or 27\""
  // rule is a separate thing and is enforced in buildQuote, because it is
  // about what that plan includes rather than about how many fit in a room.
  "332617109238": 6,  // Marketing Kit - Mega Kiosk
  "332793212658": 6,  // Marketing Kit - 27" Kiosk
  "343373224660": 6,  // Mega Kiosk Loaner
  "343374665412": 1,  // Online Ordering — one per merchant, like the Website
  "343579168455": 1,  // Marketing (Partial Ordering) — a switch, not a quantity
};

/**
 * The two tablets, which an admin can take out of the picker altogether.
 *
 * Elizabeth Phillips, 2026-10-12: "Delete tablet options. I dont think we have
 * any reason to offer them unless we can think of a use case" — and she names
 * the use case in the same breath (marketing-only with online ordering), which
 * is why this is a switch rather than a deletion. Default OFF: nobody is
 * selling them today, and the one line that turns them back on is at
 * /admin/settings/quote-limits.
 *
 * VISIBILITY ONLY, and deliberately not enforced in `buildQuote` or in
 * `isAllowedForQuoteType` the way the picker exclusions are. Those say what
 * may never be SOLD; this says what is worth showing a rep this month. Making
 * it a refusal would mean a quote configured ten minutes before an admin
 * flipped the switch stops being saveable, with a blocker naming a setting the
 * rep can't reach. The configurator keeps showing a tablet already on a quote
 * for the same reason — see `selectable` in ProductConfigurator.
 */
export const TABLET_PRODUCT_IDS: readonly string[] = [
  "276751313619", // Orders Hub Tablet
  "276754193118", // Clock in Tablet
];

export function isTabletProduct(hubspotProductId: string): boolean {
  return TABLET_PRODUCT_IDS.includes(hubspotProductId);
}

export const DEFAULT_SHOW_TABLETS = false;

/**
 * Products no longer offered on NEW quotes (2026-10-27, product owner): the
 * 27" Marketing Kit ("remove the 27 inch kiosk from marketing entirely").
 * The $1,500 "Marketing Kit - Mega Kiosk" followed 2026-10-30: the product
 * owner confirmed "Mega Kiosk (Marketing Only)" (260674226888, $2,250) is the
 * Mega to sell, as a marketing display (see PLAN_HIDDEN_PICK_PRODUCT_IDS).
 *
 * VISIBILITY ONLY, for the same reason as the tablet switch: a draft that
 * already carries one must still save, so the configurator keeps showing a
 * retired product that is on the quote and simply stops offering it otherwise.
 */
export const RETIRED_PICK_PRODUCT_IDS: readonly string[] = [
  "332793212658", // Marketing Kit - 27" Kiosk
  "332617109238", // Marketing Kit - Mega Kiosk (retired 2026-10-30)
  // Kiosk Ordering ($100/mo). Hidden everywhere (2026-10-30): the product owner
  // says it will be deleted from HubSpot, and nothing else excluded it.
  "343579167454",
];

export function isRetiredPick(hubspotProductId: string): boolean {
  return RETIRED_PICK_PRODUCT_IDS.includes(hubspotProductId);
}

/**
 * Products not offered on a PARTICULAR plan's new quotes, the per-plan twin of
 * RETIRED_PICK_PRODUCT_IDS and visibility only in the same way: a draft that
 * already carries one still saves, and the row stays while it is on the quote.
 *
 * The Mega Kiosk Loaner is off the two POS plans (2026-10-29, product owner:
 * hide it on Order & Pay and All-in-One); Marketing Only and Marketing
 * Partial Ordering keep it.
 *
 * 2026-10-30 (product owner): "remove kiosk ordering and online ordering from
 * all in one and order and pay" (Online Ordering on both POS plans) and "hide
 * mega kiosk from O&P" (the Mega, "Mega Kiosk (Marketing Only)", on Order &
 * Pay; All-in-One, MPO and Marketing Only offer it). Online Ordering stays on
 * MPO, where its chip selects it.
 */
export const PLAN_HIDDEN_PICK_PRODUCT_IDS: Partial<Record<QuoteType, readonly string[]>> = {
  order_pay_only: [
    MEGA_LOANER_PRODUCT_ID,
    ONLINE_ORDERING_PRODUCT.hubspotProductId,
    "260674226888", // Mega Kiosk (Marketing Only)
  ],
  all_in_one: [MEGA_LOANER_PRODUCT_ID, ONLINE_ORDERING_PRODUCT.hubspotProductId],
};

/** Whether the picker should stop offering this product on this plan. */
export function isHiddenPick(hubspotProductId: string, quoteType: QuoteType): boolean {
  return isRetiredPick(hubspotProductId) || (PLAN_HIDDEN_PICK_PRODUCT_IDS[quoteType] ?? []).includes(hubspotProductId);
}

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
 * Does this quote carry a processing rate at all?
 *
 * Deliberately NOT the same question as `isProcessingQuote`, and the two are
 * not interchangeable. That one asks what KIND of deal this is — whether AIO
 * is putting a system in a restaurant, which decides the install services, the
 * ordering-point count and what the picker may offer. This one asks whether
 * AIO processes money for this merchant, which decides whether there is a rate
 * to quote, a statement worth reading, and an Adyen account to open.
 *
 * They came apart on 2026-10-06, when a Marketing Only Website could take
 * online orders. Since 2026-10-27 it can't — ordering means an ordering plan —
 * so on a NEW quote the two agree. They still differ on a SAVED one: a
 * marketing quote saved with the old toggle carries the card-rate disclosure
 * line, and that line is what keeps the row processing (an Adyen account, a
 * rate on the document) after the toggle itself is gone.
 */
export function quoteHasProcessing(
  quoteType: QuoteType,
  items: Array<{ hubspotProductId: string }> | null | undefined
): boolean {
  if (isProcessingQuote(quoteType)) return true;
  return (items ?? []).some(i => i.hubspotProductId === PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId);
}

/**
 * Every sale this merchant makes is card-not-present: they take orders online
 * and have nothing on site that a card is handed to. So there is no
 * card-present rate to quote, and showing one invites a rep to negotiate a
 * number that can never apply (product owner, 2026-10-14).
 *
 * Two plans can be this. Marketing Partial Ordering taking online orders and
 * no kiosk is the live case; a Marketing Only quote saved with the old
 * website-ordering toggle is the legacy one. Order & Pay and All-in-One put a
 * POS in a restaurant — the whole point of it is taking cards across a
 * counter — so they are card-present merchants by construction, whatever they
 * have or haven't picked yet.
 *
 * The question is NOT "is there online ordering": a kiosk takes a card in
 * person. So anything on the quote that a customer can tap a card against
 * disqualifies it — every ordering-point product except online ordering
 * itself, plus the AMS1, which is a card reader and deliberately counts zero
 * ordering points (see ORDER_POINT_RULES).
 *
 * The three surviving ORDER_POINT_CHANNELS (QR, third-party delivery,
 * phone-AI) are all card-not-present, so none of them is checked here.
 */
export function processesCardNotPresentOnly(
  quoteType: QuoteType,
  /**
   * Quote lines OR the rep's picks — `name` is optional because a
   * `ProductPick` carries only an id. That costs nothing: the product id is
   * the primary key for both lookups below, and the name is their fallback
   * for a product created after the rules were written.
   */
  items: Array<{ hubspotProductId: string; name?: string }> | null | undefined
): boolean {
  if (!isMarketingQuote(quoteType) && !isPartialOrderingQuote(quoteType)) return false;
  if (!quoteHasProcessing(quoteType, items)) return false;
  return !(items ?? []).some(item => {
    const line = { hubspotProductId: item.hubspotProductId, name: item.name ?? "" };
    return (
      isAms1Product(line.hubspotProductId, line.name) ||
      (!isNamedProduct(ONLINE_ORDERING_PRODUCT, line) && orderPointsPerUnit(line) > 0)
    );
  });
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
 * The individual network components (2026-10-21, product owner: "remove all
 * the individual unifi items — the package line item is supposed to just
 * represent all the individual items"). The single WiFi package line stands for
 * the whole network, so selling the pieces on top bills it twice. Matched by id
 * (the names are HubSpot's and drift). Includes the Pronto package, which is
 * deliberately not offered as a second network line beside the Unifi one.
 * Not derived and not pickable; a saved line carrying one is dropped on reopen.
 */
const NETWORK_COMPONENT_PRODUCT_IDS: readonly string[] = [
  "338693809894", // Unifi Router
  "338690930367", // Pronto Router + LTE Backup
  "338693090009", // Unifi 8 Port Switch
  "338690209526", // Pronto 8 Port Switch
  "338616220368", // Unifi Access Point
  "338615500489", // Unifi U-LTE Backup Pro
  "338691650250", // AIO Wifi Network Package - Pronto
];

function isNetworkComponent(id: string): boolean {
  return NETWORK_COMPONENT_PRODUCT_IDS.includes(id);
}

/**
 * Everything a rep can never pick by hand. Two reasons land here:
 *   - the exclusions above — things nobody sells as a line
 *   - DERIVED lines: all three platform products, the install and training
 *     services, and the additional software license (one per screen past the included
 *     three). They still land on the quote, just not by hand.
 */
export function isPickable(product: CatalogProduct): boolean {
  return (
    !PICKER_EXCLUDED_PRODUCT_NAMES.includes(product.name as (typeof PICKER_EXCLUDED_PRODUCT_NAMES)[number]) &&
    !isNetworkComponent(product.hubspotProductId) &&
    !isPlatformProduct(product.name, product.hubspotProductId) &&
    !isIncludedServiceProduct(product.hubspotProductId, product.name) &&
    !isPreAuthProduct(product.hubspotProductId, product.name) &&
    !isKitReplacementProduct(product.hubspotProductId, product.name) &&
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
//
// Both Marketing Kits stay listed so a draft carrying one still saves; they
// are no longer OFFERED (RETIRED_PICK_PRODUCT_IDS). The Mega sold since
// 2026-10-30 is "Mega Kiosk (Marketing Only)", a marketing display.
export const MARKETING_PRODUCTS = [
  { name: "Mega Kiosk (Marketing Only)", hubspotProductId: "260674226888" },
  { name: "Marketing Kit - Mega Kiosk", hubspotProductId: "332617109238" },
  { name: "Marketing Kit - 27\" Kiosk", hubspotProductId: "332793212658" },
  { name: "Mega Kiosk Loaner", hubspotProductId: MEGA_LOANER_PRODUCT_ID },
  { name: "Website", hubspotProductId: "333275576048" },
  { name: "Menu Board Computer", hubspotProductId: "223511653103" },
] as const;

/**
 * What a Marketing Partial Ordering quote may carry by hand: ordering without
 * a POS (2026-10-27). The tablet and the KDS or printer receive the orders,
 * the kiosks and online ordering take them, and the marketing products come
 * along with the marketing half, which every quote on it carries since
 * 2026-10-30. A POS of any kind is NOT
 * here — that is the line between this plan and Order & Pay, and
 * `partialOrderingPosBlockers` says so out loud for a payload that carries one.
 */
const PARTIAL_ORDERING_PRODUCT_IDS: readonly string[] = [
  "276751313619", // Orders Hub Tablet
  "223452690132", // KDS (Kitchen Display System)
  "223511653104", // Thermal Printer
  "250458906315", // Epson Sticky Printer
  "222497165009", // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666", // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
  "223511653105", // Payment Terminal - AMS1
  "338690209525", // AIO Wifi Network Package - Unifi
  "260674226888", // Mega Kiosk (Marketing Only)
  "332617109238", // Marketing Kit - Mega Kiosk (retired; drafts still save)
  MEGA_LOANER_PRODUCT_ID,
  WEBSITE_PRODUCT_ID,
  "223511653103", // Menu Board Computer
];

/**
 * Every device that makes a restaurant a POS merchant. None may go on a
 * Marketing Partial Ordering quote (product owner, 2026-10-27).
 */
const POS_DEVICE_PRODUCT_IDS: readonly string[] = [
  "217445755632", // POS Unit
  "223452690130", // POS Unit - With Customer Facing Display
  "339229355762", // POS (Dual Screen) + Payment Terminal
  "223511653101", // mPOS
  "335279520447", // AIO Tableside POS
];

/** A POS on a Marketing Partial Ordering quote. Reports, like the other ceilings. */
export function partialOrderingPosBlockers(
  quoteType: QuoteType,
  lines: Array<{ hubspotProductId: string; name: string; qty: number }>
): string[] {
  if (!isPartialOrderingQuote(quoteType)) return [];
  const pos = lines.filter(l => POS_DEVICE_PRODUCT_IDS.includes(l.hubspotProductId) && l.qty > 0);
  if (!pos.length) return [];
  const names = [...new Set(pos.map(l => `"${l.name.trim()}"`))].join(", ");
  return [
    `Marketing Partial Ordering is ordering without a POS, so it can't carry ${names}. ` +
    `Take it off, or quote this merchant on Order & Pay or All-in-One.`,
  ];
}

/**
 * Marketing Partial Ordering is sold for its ordering, so a quote on it has
 * to take orders somewhere: a kiosk or online ordering.
 */
export function partialOrderingPointBlockers(
  quoteType: QuoteType,
  lines: Array<{ hubspotProductId: string; name: string; qty: number }>
): string[] {
  if (!isPartialOrderingQuote(quoteType)) return [];
  if (lines.some(l => l.qty > 0 && orderPointsPerUnit(l) > 0)) return [];
  return [
    `Marketing Partial Ordering needs a way to take orders — add a kiosk or Online Ordering, ` +
    `or quote this merchant on Marketing Only.`,
  ];
}

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
  // Marketing Only always; Marketing Partial Ordering when its marketing line
  // is on the quote — always, since 2026-10-30, when `buildQuote` started
  // forcing it in (`resolvePartialOrderingMarketing`). Not All-in-One, whose
  // marketing comes with the kit's one.
  if (!includesMarketing(quoteType, lines)) return lines;
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

/** The two kiosk kits. Not the Website — that one is allowed on every quote. */
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
 * Marketing Only carries the marketing products. Marketing Partial Ordering
 * carries its own list (no POS), plus online ordering and its marketing
 * line. Order & Pay and All-in-One carry any other pickable product except the
 * 27" Marketing Kit; the Mega — bought or on loan — goes on any plan since
 * 2026-10-27, and so does online ordering. The marketing line is the partial
 * plan's alone: All-in-One already includes marketing and Order & Pay has none.
 */
export function isAllowedForQuoteType(product: CatalogProduct, quoteType: QuoteType): boolean {
  if (!isPickable(product)) return false;
  if (isNamedProduct(MARKETING_ADDON_PRODUCT, product)) return isPartialOrderingQuote(quoteType);
  if (isNamedProduct(ONLINE_ORDERING_PRODUCT, product)) return !isMarketingQuote(quoteType);
  if (isMarketingQuote(quoteType)) return isMarketingProduct(product.hubspotProductId, product.name);
  if (isPartialOrderingQuote(quoteType)) return PARTIAL_ORDERING_PRODUCT_IDS.includes(product.hubspotProductId);
  return product.hubspotProductId !== "332793212658"; // Marketing Kit - 27" Kiosk
}

// ── Mandatory install services (derived, not chosen) ────────────────────────

// Confirmed with Shaheer 2026-08-20: every quote that puts AIO's system in a
// restaurant includes an install and a training — qty 1 each.
//
// The WiFi package USED to be the third, derived onto every hardware quote.
// Since 2026-10-21 it is an ordinary pick, handled like the KDS (product
// owner: "Just add the network package as a regular item in the hardware
// picker just like a KDS or something"): the QSR Kit preselects it and covers
// it, and a rep who doesn't want it just un-picks it.
//
// Two exceptions, both meaning "nothing is being installed":
//   - a marketing-only quote
//   - a RATE-ONLY quote: a processing quote with no products picked at all.
//     The services attach to the products, so an empty picker means there's
//     nothing to install, no network to run and nothing to train on. Declared
//     ordering channels do NOT pull them in — a website-ordering merchant has
//     no on-site anything for a $999 install to cover.
// AIO deactivated the original "AIO WiFi Network Package" (281351401209,
// $999) on 2026-10-13 and replaced it with two vendor-specific variants:
// "AIO Wifi Network Package - Unifi" (338690209525, $698) and "... - Pronto"
// (338691650250, $490). Product owner: the WiFi line is the Unifi one; Pronto
// is deliberately unreachable from EasyOB for now. See RETIRED_WIFI_PRODUCTS
// for how the old line is still recognised.
export const WIFI_PRODUCT_ID = "338690209525";

export const INCLUDED_SERVICE_PRODUCTS = [
  { name: "Onsite Installation", hubspotProductId: "223452690133" },
  { name: "System Onboarding and Training", hubspotProductId: "223152695032" },
] as const;

/**
 * The retired WiFi package id/name. Deactivated in HubSpot 2026-10-13, so it
 * can never be resolved or written again — but six already-published quotes
 * and any saved draft still carry this line at $999. `picksFromQuoteLines`
 * recognises it and reopens it as a pick of the Unifi package, the product
 * that replaced it. Same pattern as `RETIRED_PLATFORM_PRODUCTS`.
 */
const RETIRED_WIFI_PRODUCTS = [
  { name: "AIO WiFi Network Package", hubspotProductId: "281351401209" },
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
 * NOT the Mega Kiosk (260674226888): since 2026-10-30 it is "Mega Kiosk
 * (Marketing Only)", a marketing display that takes no orders or payments.
 */
export const KIOSK_PRODUCT_IDS: readonly string[] = [
  "222497165009", // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666", // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
];

/** The companions a change to this product's quantity should carry with it. */
export function companionsFor(hubspotProductId: string): typeof POS_COMPANIONS[number][] {
  return POS_COMPANIONS.filter(c => (c.withProductIds as readonly string[]).includes(hubspotProductId));
}

/**
 * Screens that consume a software license: anything that runs an AIO app.
 * The first three are included in the platform fee — on EVERY plan since
 * 2026-10-27, Marketing Only included (it was processing plans only from
 * 2026-10-21). The Hardware heading in the quote builder reads this number.
 */
export const INCLUDED_SCREEN_COUNT = 3;

export const SCREEN_PRODUCT_IDS = [
  "217445755632", // POS Unit
  "223452690130", // POS Unit - With Customer Facing Display
  "223511653101", // mPOS
  "223452690132", // KDS (Kitchen Display System)
  "260674226888", // Mega Kiosk (Marketing Only)
  "222497165009", // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666", // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
  // A Mega is a screen however it got there — bought or on loan (the sheet:
  // "The Mega counts as one of the 3 licenses").
  "332617109238", // Marketing Kit - Mega Kiosk
  MEGA_LOANER_PRODUCT_ID,
  // NOT the Menu Board Computer: it drives a TV, it is not a screen anyone
  // works on, and it takes no license (product owner, 2026-10-18).
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

/**
 * Quantities that only mean anything against another product's quantity: a
 * display and a drawer belong to a POS, a terminal to a POS or a kiosk.
 * Elizabeth Phillips, 2026-10-12 — "Dont allow more Customer Facing
 * Displays/Cash drawer than POS units", "Dont allow more adyen's than POS
 * units/kiosks".
 *
 * A CEILING, and the counterpart to `minimumTerminalsFor`'s floor: one AMS1
 * ships with every POS, and now no more than one per thing that can take a
 * payment. The flat `unitCaps` can't express this — it caps each product at a
 * number an admin typed, which is a typo catcher, not "four drawers for two
 * tills".
 *
 * It REPORTS rather than clamps. `resolveRequiredAms1` tops a quote up to the
 * floor because a POS without a terminal cannot take a card; nothing here
 * takes a line off a quote a rep is reading out loud to a merchant.
 *
 * Counted against BOTH POS SKUs, including the one with a display in the box.
 * A merchant buying that SKU plus a loose display is more likely putting a
 * second screen on the counter than making a mistake, and this exists to catch
 * the mistake.
 */
export const RELATIVE_CEILINGS: Array<{
  hubspotProductId: string;
  perProductIds: readonly string[];
  /** How to name what it's counted against, so the blocker reads like English. */
  per: { one: string; many: string };
}> = [
  {
    hubspotProductId: "318736467644", // Customer Facing Display
    perProductIds: POS_REQUIRING_TERMINAL_IDS,
    per: { one: "POS unit", many: "POS units" },
  },
  {
    hubspotProductId: "222497165011", // Cash Drawer
    perProductIds: POS_REQUIRING_TERMINAL_IDS,
    per: { one: "POS unit", many: "POS units" },
  },
  {
    hubspotProductId: AMS1_PRODUCT.hubspotProductId,
    perProductIds: [...POS_REQUIRING_TERMINAL_IDS, ...KIOSK_PRODUCT_IDS],
    per: { one: "POS unit or kiosk", many: "POS units and kiosks" },
  },
];

/**
 * Reasons a quote carries more of something than there is anything to attach
 * it to. Summed per PRODUCT, like the unit caps and for the same reason: a
 * scoped discount splits one pick into two lines.
 */
export function relativeCeilingBlockers(
  lines: Array<{ hubspotProductId: string; name: string; qty: number }>
): string[] {
  const qtyOf = (ids: readonly string[]) =>
    lines.reduce((n, l) => n + (ids.includes(l.hubspotProductId) ? l.qty : 0), 0);

  const out: string[] = [];
  for (const rule of RELATIVE_CEILINGS) {
    const qty = qtyOf([rule.hubspotProductId]);
    if (qty < 1) continue;
    const ceiling = qtyOf(rule.perProductIds);
    if (qty <= ceiling) continue;
    const name = lines.find(l => l.hubspotProductId === rule.hubspotProductId)?.name.trim() ?? "";
    const have = ceiling === 0 ? `no ${rule.per.many}` : `${ceiling} ${ceiling === 1 ? rule.per.one : rule.per.many}`;
    out.push(
      `This quote has ${qty} × "${name}" on it but ${have} — one goes with each ${rule.per.one}. ` +
      `Drop the extras, or add what they belong to.`
    );
  }
  return out;
}

/** "Payroll - AIO Platform (Per Person)", $8 per employee per month. */
export const PAYROLL_PRODUCT_ID = "223152695998";

/**
 * The counter POS units — what payroll needs on the quote beside it (product
 * owner, 2026-10-18: "no payroll without point of sale"). Counter units ONLY:
 * an mPOS, a tableside device or a kiosk doesn't qualify on its own.
 * "POS (Dual Screen) + Payment Terminal" is here though no other rule knows it
 * yet — it is a counter POS, and leaving it out would refuse payroll to a
 * merchant who bought one.
 */
export const COUNTER_POS_PRODUCT_IDS = [
  ...POS_REQUIRING_TERMINAL_IDS,
  "339229355762", // POS (Dual Screen) + Payment Terminal
] as const;

/** Payroll on a quote with no counter POS unit. Reports, like the ceilings above. */
export function payrollBlockers(lines: Array<{ hubspotProductId: string; qty: number }>): string[] {
  const has = (ids: readonly string[]) => lines.some(l => ids.includes(l.hubspotProductId) && l.qty > 0);
  if (!has([PAYROLL_PRODUCT_ID]) || has(COUNTER_POS_PRODUCT_IDS)) return [];
  return ["Payroll needs a POS unit on the quote. Add one, or take payroll off."];
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
 * NOT the WiFi package (an always-included service then, an ordinary pick
 * since 2026-10-21). It is not on that sheet at all — the sheet prices the network as separate hardware (Unifi
 * Router, 8 Port Switch, Access Point, U-LTE Backup Pro), so comping the $999
 * package would be inventing a discount nobody authorized.
 *
 * TO END THE PROMOTION: empty this array. The lines keep appearing, at their
 * catalog price, and nothing else has to change.
 *
 * ENDED 2026-10-18 (product owner: "installation is priced and training,
 * included but priced. treat it like a regular line item"). Onsite
 * Installation ($999) and System Onboarding and Training ($499) are still
 * derived onto every hardware quote, but at list price, and a rep discounts or
 * delays them like any other line. The mechanism stays for the next promotion.
 *
 * BOTH COMPED AGAIN 2026-10-28 (product owner: "installation should be
 * automatically discounted to 100% off", then the same day extended to
 * System Onboarding and Training). Onsite Installation and System Onboarding
 * and Training are both on the list.
 */
export const COMPED_SERVICE_PRODUCT_IDS: string[] = ["223452690133", "223152695032"];

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
  // A rep who set EITHER lever deliberately keeps it — the comp is a default,
  // not an override (see this function's doc comment). A cash discount counts
  // as that decision exactly like a percentage does.
  const repSet = adjustment?.discountPercent ?? adjustment?.discountAmount;
  if (repSet !== undefined && repSet !== null) return line;
  // `discountAmount` is DROPPED, not left beside the 100% and not set to
  // null: the two levers are mutually exclusive and `lineNetAmount` reads the
  // cash one FIRST, so a leftover amount would quietly outrank the comp. A
  // deleted key rather than a null one so a comped line keeps the exact shape
  // it had before cash discounts existed.
  const comped = { ...line, discountPercent: 100 };
  delete comped.discountAmount;
  return comped;
}

/**
 * THE FIRST KIOSK IS OUT OF THE KIT (2026-10-29). On a plan that comes with a
 * kit (`kitFor`: All-in-One, Order & Pay, Marketing Partial Ordering), ONE
 * kiosk unit — a 27" or a 15.6", across both — is "the first kiosk". It went
 * on 100% off by default for a few hours that day; the product owner then
 * inverted it ("Make it charged normally, and then allow the discount to be
 * 100 without affecting commission"): it goes on at LIST like any line, and
 * what makes it the first kiosk is only that the rep may discount that one
 * unit as far as 100% past the cap (`adjustmentBlockers`) and that it earns a
 * flat commission floored at $0 (`lineHardwareCommission`).
 *
 * Which product it is, when the quote has both: the DEARER line (the 27" at
 * today's prices), the same "merchant gets the dearer one" the kit's slot
 * used to give. A tie goes to the order of this list.
 */
export const FIRST_KIOSK_PRODUCT_IDS: readonly string[] = [
  "222497165009", // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666", // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
];

/** The product carrying this quote's first kiosk, or null when it has none (or the plan has no kit). */
export function firstKioskProductId(quoteType: QuoteType, lines: QuoteLine[]): string | null {
  if (!kitFor(quoteType)) return null;
  let first: QuoteLine | null = null;
  for (const id of FIRST_KIOSK_PRODUCT_IDS) {
    const line = lines.find(l => l.hubspotProductId === id && l.qty > 0);
    if (line && (!first || line.unitPrice > first.unitPrice)) first = line;
  }
  return first?.hubspotProductId ?? null;
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
 *
 * Nothing a rep can do keeps hardware out of a kit. (The QSR kiosk's
 * "Charge for kiosk" did, 2026-10-28; the kiosk left the kit the next day —
 * see `FIRST_KIOSK_PRODUCT_IDS`.)
 */
export function applyPackageComp(line: QuoteLine): QuoteLine {
  if (!line.coveredByPackage) return line;
  // Same reason as `applyServiceComp`: drop the cash lever, which
  // `lineNetAmount` would otherwise read in preference to this 100%.
  const covered = { ...line, discountPercent: 100 };
  delete covered.discountAmount;
  return covered;
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
    !(line.discountPercent || line.discountAmount)
  ) return [line];

  const rest: QuoteLine = { ...line, qty: line.qty - want };
  delete rest.discountPercent;
  // The remainder is at list, so it carries NEITHER lever. A cash amount left
  // on it would take the rep's whole figure off twice — once on each half.
  delete rest.discountAmount;
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
 * Whether these picks include anything that physically arrives on site — the
 * discriminator `resolveIncludedServices` (and no one else) needs between "a
 * rep picked hardware" and "a rep picked a software-only product".
 *
 * `billingFrequency === "one_time"` is the signal: hardware is bought once,
 * while every software-only pick a rep can actually make (Website $50/mo,
 * Additional Software License $19/mo — though the license is filtered out of
 * `picks` before this ever sees it) bills on a cycle. Checked against the
 * catalog, 2026-10-13: the one-time products that are NOT physical (Onsite
 * Installation, System Onboarding and Training, the $0.50 pre-auth, the $0
 * processing-rate disclosure) are all DERIVED lines — none of them is ever a
 * product a rep can pick, so none of them can reach `pickedLines` and fool
 * this check. If a future catalog product is ever one-time and not physical
 * AND pickable, this needs an explicit exclusion, not a silent assumption.
 */
function hasPhysicalPick(pickedLines: QuoteLine[]): boolean {
  return pickedLines.some(l => l.billingFrequency === "one_time" && l.qty > 0);
}

/**
 * The install lines a quote carries. Resolved from the catalog like any other
 * line, so the price on the quote is the price HubSpot holds today and is
 * snapshotted from here on.
 *
 * Takes the picked lines because the services follow the products — but
 * specifically the PHYSICAL ones: no physical product means nothing to
 * install or train on. This used to fall out for free from "no
 * products picked == rate-only quote", back when a website merchant declared
 * it with a channel chip rather than a pick. Since 2026-10-13 the Website
 * product ($50/mo) IS the pick, so a website-only quote has a non-empty
 * `pickedLines` and the old `pickedLines.length === 0` gate stopped being
 * enough — it would attach a $698 WiFi package and a comped install/training
 * pair to a merchant with nothing on site. `hasPhysicalPick` is the fix:
 * software-only picks (Website, the derived software license) don't count.
 */
export function resolveIncludedServices(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  catalog: CatalogProduct[]
): IncludedServicesResult {
  if (!isProcessingQuote(quoteType) || !hasPhysicalPick(pickedLines)) return { lines: [], missing: [] };

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
 *
 * Does NOT need `hasPhysicalPick`'s "any pick means hardware" fix that
 * `resolveIncludedServices` needed: `minimumTerminalsFor` already counts
 * specific POS product ids (`POS_REQUIRING_TERMINAL_IDS`), not "picks exist
 * at all", so a website-only quote (no POS in its picks) already derives 0
 * required terminals here, unaffected by the Website product becoming a pick.
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
 * One Additional Software License per screen past the three the platform fee
 * includes, on every plan (2026-10-27: "Every plan … includes 3 licenses").
 * The license is derived, never picked, so a hand-added line can't double it.
 */
export function resolveSoftwareLicense(
  pickedLines: QuoteLine[],
  catalog: CatalogProduct[]
): SoftwareLicenseResult {
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
 * The marketing line every Marketing Partial Ordering quote carries — and with
 * it, through `includesMarketing`, the three free menu boards (2026-10-30,
 * product owner: "remove marketing button from MPO (autoselect it, cannot be
 * changed)"; "if someone wants kiosk and online ordering without marketing
 * they can select order and pay and just remove the POS, its still 299").
 *
 * FORCED IN rather than refused, the same posture as the AMS1 top-up: the
 * browser only sends picks, so a stale tab, a hand-edited payload or a quote
 * reopened from before this change arrives without it, and the plan carries
 * it whatever they say — a blocker would only send the rep looking for a
 * Marketing control that no longer exists. A pick that already carries it is
 * left alone (it is capped at one). Missing from the catalog is a blocker:
 * the plan can't be quoted without the line that says it includes marketing.
 */
export function resolvePartialOrderingMarketing(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  catalog: CatalogProduct[]
): IncludedServicesResult {
  if (!isPartialOrderingQuote(quoteType)) return { lines: [], missing: [] };
  if (pickedLines.some(l => l.qty > 0 && isNamedProduct(MARKETING_ADDON_PRODUCT, l))) return { lines: [], missing: [] };
  const product = catalog.find(p => isNamedProduct(MARKETING_ADDON_PRODUCT, p));
  return product
    ? { lines: [toQuoteLine(product, 1)], missing: [] }
    : { lines: [], missing: [MARKETING_ADDON_PRODUCT.name] };
}

/**
 * The $0.50 charge that lets a quote delay its billing.
 *
 * HubSpot won't publish a payment-enabled quote that collects under $0.50 at
 * checkout (see `MIN_CHECKOUT_AMOUNT`), and a delayed recurring line collects
 * nothing at checkout — so a quote whose hardware is comped and whose plan
 * starts billing in 45 days has NOTHING due, and can't be sent at all. This
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
 * The $400 charge a kit swap used to carry (2026-10-16 to 2026-10-27). Swaps
 * are gone — the scenario sheet: "Swap fee eliminated" — so nothing derives it
 * any more. Kept so it stays out of the picker and so a saved quote that
 * carries the line drops it on reopen rather than reading it back as a pick.
 */
export const KIT_REPLACEMENT_PRODUCT = {
  name: "Free Kit Replacement Item",
  hubspotProductId: "339236587251",
} as const;

export function isKitReplacementProduct(id: string, name: string): boolean {
  return (
    id === KIT_REPLACEMENT_PRODUCT.hubspotProductId ||
    name.trim() === KIT_REPLACEMENT_PRODUCT.name
  );
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
 * The incident fees AIO discloses alongside the card rates. Transcribed from
 * the HubSpot product's own description, which is the only place they have
 * ever been written down — nothing in EasyOB prices them, and no quote varies
 * them. Shown on the HubSpot line AND the merchant's quote preview, from here.
 */
export const CHARGEBACK_FEE = 25;
export const RETRIEVAL_FEE = 15;
const DISCLOSURE_INCIDENT_FEES = `Chargeback $${CHARGEBACK_FEE} · Retrieval $${RETRIEVAL_FEE}`;

/**
 * The rate-disclosure line's text, as the merchant reads it on their quote.
 *
 * This exists because the HubSpot product's own description is STATIC: it
 * states 2.49% / 3.50% and a separate AMEX pair to every merchant alike,
 * regardless of what the rep quoted, and the AMEX split was retired on
 * 2026-10-13. So the line item carries its own description instead (see
 * `toLineItemProperties`), composed here from the quote's real rates.
 *
 * `cardNotPresentOnly` drops the card-present row rather than printing a rate
 * that can never apply — the same rule the rep's own rate boxes follow. See
 * `processesCardNotPresentOnly`.
 */
export function processingDisclosureText(
  rates: QuoteRates,
  cardNotPresentOnly: boolean = false
): string {
  const pct = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;
  const fee = `$${rates.perTransactionFee.toFixed(2)} per transaction`;
  const rows = [
    ...(cardNotPresentOnly ? [] : [`Card Present — ${pct(rates.cardPresentRate)} + ${fee}`]),
    `Card Not Present — ${pct(rates.cardNotPresentRate)} + ${fee}`,
  ];
  return [...rows, "", DISCLOSURE_INCIDENT_FEES].join("\n");
}

/**
 * The rate-disclosure line: EVERY quote AIO processes money for now carries
 * it (product owner, 2026-10-14). It used to go on marketing quotes with
 * online ordering ONLY, on the reasoning that a POS merchant obviously knows
 * they're buying payments — which left the rates written nowhere at all on
 * the document a POS merchant signs.
 *
 * `hasChargedLines` is what keeps a RATE-ONLY quote rate-only, and it is not
 * optional. A processing plan with nothing picked derives no lines at all;
 * put a $0 line on it and three things break at once — `quoteSanityBlockers`
 * refuses it ("every line nets to $0"), `publishBillingQuote`'s
 * `lines.length === 0` short-circuit stops firing, and `resolvePreAuthLine`
 * adds fifty cents to a quote that was never meant to charge anything. So
 * this is resolved AFTER the charged lines exist, not alongside them.
 *
 * Derived rather than picked — the product is in `PICKER_EXCLUDED_PRODUCT_NAMES`
 * and stays there, so no rep can put it on a quote by hand. It is $0, so it
 * changes no total; the rates themselves are written onto the HubSpot line
 * item's description at publish (see publishBillingQuote.ts), because the
 * product's own description in the portal is static text that knows nothing
 * about this merchant.
 */
export function resolveProcessingDisclosure(
  quoteType: QuoteType,
  pickedLines: QuoteLine[],
  catalog: CatalogProduct[],
  hasChargedLines: boolean = true
): IncludedServicesResult {
  if (!hasChargedLines) return { lines: [], missing: [] };
  if (!quoteHasProcessing(quoteType, pickedLines)) return { lines: [], missing: [] };

  const product =
    catalog.find(p => p.hubspotProductId === PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId) ??
    catalog.find(p => p.name.trim() === PROCESSING_DISCLOSURE_PRODUCT.name);
  return product
    ? { lines: [toQuoteLine(product, 1)], missing: [] }
    : { lines: [], missing: [PROCESSING_DISCLOSURE_PRODUCT.name] };
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
 *
 * Emptied on 2026-10-27 on the scenario sheet's "Website is $50 a month
 * additional on any plan", and put back the same day — Elizabeth Phillips:
 * "All in one does include website for free". Every other plan pays $50.
 */
export const PLANS_INCLUDING_WEBSITE: readonly QuoteType[] = ["all_in_one"];

export function planIncludesWebsite(quoteType: QuoteType): boolean {
  return PLANS_INCLUDING_WEBSITE.includes(quoteType);
}

/**
 * The Website a plan includes, marked as covered by the plan so
 * `applyPackageComp` holds it at 100% off — the same expression as the
 * marketing plan's menu boards. The Website is single-instance, so the whole line is
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

/**
 * Snapshot a catalog product onto the quote. Price and frequency are frozen
 * here — and so, as of 2026-10-13, are the hardware-commission inputs
 * (`costToRep`/`repCommissionBps`/`rsmCommissionBps`), for the same reason:
 * a saved quote must keep paying the same commission even if the catalog's
 * rates change later. See the fields' own doc comments on `QuoteLine`.
 */
export function toQuoteLine(product: CatalogProduct, qty: number): QuoteLine {
  return {
    hubspotProductId: product.hubspotProductId,
    name: product.name,
    qty,
    unitPrice: product.price,
    billingFrequency: product.billingFrequency,
    productType: product.productType,
    costToRep: product.costToRep ?? null,
    repCommissionBps: product.repCommissionBps ?? null,
    rsmCommissionBps: product.rsmCommissionBps ?? null,
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
  const list = lineListAmount(line);
  // A cash discount is the line total the rep typed, so it subtracts exactly
  // — no percentage, no rounding, nothing to disagree with HubSpot about.
  // CLAMPED at zero: a stale amount larger than the line (the rep lowered the
  // quantity after setting it) must not bill backwards. `adjustmentBlockers`
  // refuses that case separately, so this is the arithmetic's own floor, not
  // the place it gets reported.
  const amount = line.discountAmount ?? 0;
  if (amount > 0) return Math.max(0, Math.round((list - amount) * 100) / 100);

  const pct = line.discountPercent ?? 0;
  if (!pct) return list;
  return Math.round(list * (1 - pct / 100) * 100) / 100;
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
 * Whether a line is billed on the one-time INVOICE rather than the quote
 * (2026-10-22, product owner). Every one-time line moves to the invoice
 * except the two the quote itself needs: the pre-auth, which exists to make
 * the quote's own checkout reach $0.50, and the processing disclosure, which
 * is the rate the merchant signs for. `app.quoteLines` still holds every line
 * — only where each one publishes changes.
 */
export function isInvoicedLine(line: QuoteLine): boolean {
  return (
    line.billingFrequency === "one_time" &&
    line.hubspotProductId !== PRE_AUTH_PRODUCT.hubspotProductId &&
    line.hubspotProductId !== PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId
  );
}

/** The saved lines split by where they publish, each side in its original order. */
export function splitQuoteLines(lines: QuoteLine[]): { quoteLines: QuoteLine[]; invoiceLines: QuoteLine[] } {
  const quoteLines: QuoteLine[] = [];
  const invoiceLines: QuoteLine[] = [];
  for (const line of lines) (isInvoicedLine(line) ? invoiceLines : quoteLines).push(line);
  return { quoteLines, invoiceLines };
}

/** The net total of the invoiced lines: what the one-time invoice bills. */
export function amountInvoiced(lines: QuoteLine[]): number {
  let total = 0;
  for (const line of lines) if (isInvoicedLine(line)) total += lineNetAmount(line);
  return Math.round(total * 100) / 100;
}

/**
 * What the merchant is charged at the moment they check out: the FIRST payment
 * of each recurring line that has no delayed start, plus the one-time lines
 * that stay on the quote (the pre-auth). A recurring line with a
 * `billingStart` takes nothing at checkout — HubSpot reported
 * `totalAmount: 0.00` for a quote whose only charge was a $299/mo plan delayed
 * 45 days, with its hardware comped by the plan. Invoiced lines
 * (`isInvoicedLine`) are billed after acceptance and take nothing here either.
 *
 * Distinct from `quoteTotals`, which is what the quote is WORTH. A quote can be
 * worth $299/mo and still owe $0 today.
 */
export function amountDueAtCheckout(lines: QuoteLine[]): number {
  let due = 0;
  for (const line of lines) {
    if (isInvoicedLine(line)) continue;
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
  "Kiosk 27\" + Payment Terminal (AMS1) and Mount": { pointsPerUnit: 1, hubspotProductId: "222497165009" },
  "Kiosk Mini 15.6\" + Payment Terminal (AMS1) and Mount": { pointsPerUnit: 1, hubspotProductId: "223519571666" },
  // Steve's list counts a "Tableside AI Device"; this is that product.
  "AIO Tableside POS": { pointsPerUnit: 1, hubspotProductId: "335279520447" },
  // Resolved by Shaheer 2026-08-20: the bundle contains exactly one POS, so it
  // counts one point like a bare POS Unit. Was 0-with-needsReview while the
  // contents were unknown.
  "QSR POS Hardware Bundle": { pointsPerUnit: 1, hubspotProductId: "252941875920" },
  // Online ordering is the ordering point, not the Website (2026-10-27). It
  // was the Website from 2026-10-13, when the "website / online ordering"
  // CHANNEL chip was folded into the $50/mo line; the scenario sheet then
  // split them ("Website alone does not include online ordering").
  "Online Ordering": { pointsPerUnit: 1, hubspotProductId: ONLINE_ORDERING_PRODUCT.hubspotProductId },

  // Explicitly does not count
  // Both tablets were 0-with-needsReview until Shaheer settled them
  // 2026-09-17: neither is an ordering point. They stay 0, but WITHOUT the
  // review flag, which was refusing the billing publish on every quote that
  // carried one (billing/preconditions.ts rule 6) with no way for a rep to
  // clear it short of dropping the line.
  // A website, not an ordering point, since 2026-10-27 (see Online Ordering
  // above). Explicit, so it never reads as unclassified hardware.
  "Website": { pointsPerUnit: 0, hubspotProductId: "333275576048" },
  // HubSpot carries no product type on it, so without this rule it would be
  // reported as unclassified hardware on every quote that takes marketing.
  "Marketing (Partial Ordering)": { pointsPerUnit: 0, hubspotProductId: MARKETING_ADDON_PRODUCT.hubspotProductId },
  "Orders Hub Tablet": { pointsPerUnit: 0, hubspotProductId: "276751313619" },
  "Clock in Tablet": { pointsPerUnit: 0, hubspotProductId: "276754193118" },
  "Payment Terminal - AMS1": { pointsPerUnit: 0, hubspotProductId: "223511653105" },
  "Customer Facing Display": { pointsPerUnit: 0, hubspotProductId: "318736467644" },
  "KDS (Kitchen Display System)": { pointsPerUnit: 0, hubspotProductId: "223452690132" },
  // Marketing hardware. Named for kiosks but not ordering kiosks — settled by
  // Shaheer 2026-10-05. Typed `inventory`, so without an explicit 0 they'd
  // show the rep an "unclassified hardware" warning on every marketing quote.
  "Marketing Kit - Mega Kiosk": { pointsPerUnit: 0, hubspotProductId: "332617109238" },
  // Was "Mega Kiosk" at 1 point; a marketing display since 2026-10-30
  // (product owner), renamed in HubSpot to match.
  "Mega Kiosk (Marketing Only)": { pointsPerUnit: 0, hubspotProductId: "260674226888" },
  "Marketing Kit - 27\" Kiosk": { pointsPerUnit: 0, hubspotProductId: "332793212658" },
  // Display only — the loaned Mega can't take an order or a payment.
  "Mega Kiosk Loaner": { pointsPerUnit: 0, hubspotProductId: MEGA_LOANER_PRODUCT_ID },
  "Menu Board Computer": { pointsPerUnit: 0, hubspotProductId: "223511653103" },
  "Thermal Printer": { pointsPerUnit: 0, hubspotProductId: "223511653104" },
  "Epson Sticky Printer": { pointsPerUnit: 0, hubspotProductId: "250458906315" },
  "Cash Drawer": { pointsPerUnit: 0, hubspotProductId: "222497165011" },
  "AIO Wifi Network Package - Unifi": { pointsPerUnit: 0, hubspotProductId: "338690209525" },
  // Retired 2026-10-13 (deactivated in HubSpot, replaced by the Unifi
  // variant above). A saved quote may still carry this line; keep counting
  // it at 0 rather than flag it unclassified.
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
export const NON_HARDWARE_PRODUCT_TYPES = ["Software", "Service"];

// Ordering points that will never appear in an inventory system or on a
// hardware line. A website USED to be declared here too, but moved to being
// counted on the Website PRODUCT itself (2026-10-13, product owner) — the
// chip was redundant with the $50/mo line already on the quote. See
// ORDER_POINT_RULES["Website"] for the other half of that move.
export const ORDER_POINT_CHANNELS: Array<{ id: string; label: string; note?: string }> = [
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
 * channels argument, which is inert since 2026-10-30 (the "Ordering channels"
 * picker was removed; declared channels contribute 0 points). (The DEPLOYED count is a
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

  // Channels are inert (2026-10-30, product owner: hide AND ignore): they add
  // no points. `channels` stays in the signature so callers compile.
  void channels;

  return { orderPoints: { hardware, channels: [], total }, needsReview, unclassified };
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
  marketing_partial: { name: "AIO Marketing Partial Ordering", hubspotProductId: "343582047937" },
};

/** The name `marketing_term`'s covered kiosk line carries, which is how reopening recognises it. */
const MARKETING_TERM_PLAN_NAME = "AIO Marketing Platform (2-year term)";

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
  // Both $299 2-year records — the plan `marketing_term` quoted (renamed
  // "… - BAY AREA" in HubSpot) and its narrower twin. The plan was retired
  // 2026-10-27; these stay so a quote that carries one reopens without
  // offering it back as a pickable product.
  { name: MARKETING_TERM_PLAN_NAME, hubspotProductId: "332927902454" },
  { name: MARKETING_TERM_PLAN_NAME, hubspotProductId: "334139877086" },
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
  /** A rate-only quote: nothing picked, so no plan is being sold yet. */
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
  // there's no plan to charge for. Declared channels no longer count
  // (2026-10-30, product owner: ignored), so only picks keep a quote off this.
  //
  // Only a PROCESSING quote can be rate-only. A marketing plan has no rate, so
  // an empty one isn't a rate quote — it's a subscription with nothing added
  // to it yet, and it still charges.
  if (isProcessingQuote(quoteType) && pickedLines.length === 0) {
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
    // The one derived line on a product a rep can also pick by hand, so it
    // carries a flag instead of being known by its id. See `QuoteLine.derived`.
    line.derived === true ||
    isPlatformProduct(line.name, line.hubspotProductId) ||
    isIncludedServiceProduct(line.hubspotProductId, line.name) ||
    isNetworkComponent(line.hubspotProductId) ||
    line.hubspotProductId === PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId ||
    isPreAuthProduct(line.hubspotProductId, line.name) ||
    // Derived from the decomposition, and one-time `inventory` at a positive
    // price — so a line that came back as a PICK would re-enter the coverage
    // pool as off-sheet hardware and could be comped into a kit slot at 100%
    // off, which is the swap charge paying for itself.
    isKitReplacementProduct(line.hubspotProductId, line.name) ||
    isSoftwareLicenseProduct(line.hubspotProductId, line.name) ||
    isHardwareBundle(line.hubspotProductId, line.name) ||
    // The 27" Marketing Kit belongs on Marketing Only. A quote on any other
    // plan that still carries one (saved before it was taken off) must not
    // send it back as a pick — the server would refuse the whole save. The
    // Mega Kit goes on any plan since 2026-10-27, so it comes back.
    (!isMarketingQuote(quoteType) && line.hubspotProductId === "332793212658")
  );
}

export function picksFromQuoteLines(
  lines: QuoteLine[] | null | undefined,
  /**
   * The plan the quote is on. Needed because one product is sellable on some
   * plans and not others: the 27" Marketing Kit belongs to Marketing Only, so
   * a quote on another plan that still carries one (saved before it was taken
   * off) must not send it back as a pick — the server refuses the whole save.
   *
   * What the plan COMPS does come back as a pick, covered lines included: the
   * three free Menu Board Computers are ordinary picks whose first N units a
   * comp holds at $0, so reopening has to return the quantity the rep chose
   * and let the comp re-apply on the way out.
   */
  quoteType: QuoteType
): Array<{ hubspotProductId: string; qty: number }> {
  // The AMS1 comes back whole, like any pick: picked terminals count toward
  // the one-per-POS minimum, so the saved total is exactly what to reopen as.
  const merged = new Map<string, number>();
  for (const l of lines ?? []) {
    if (isDroppedOnReopen(l, quoteType)) continue;
    // The WiFi package is a pick since 2026-10-21, so a saved quote's WiFi
    // line (derived onto it before then) reopens as one. The RETIRED $999 id
    // can't be resolved in HubSpot any more, so it comes back as one of the
    // Unifi package that replaced it — dropping it would quietly take the
    // network off a quote the merchant was shown with one.
    if (isRetiredWifiLine(l)) {
      merged.set(WIFI_PRODUCT_ID, Math.max(merged.get(WIFI_PRODUCT_ID) ?? 0, 1));
      continue;
    }
    // The kiosk the retired 2-year plan covered comes back as what replaced
    // it: one Mega Kiosk Loaner, $100/mo on the $199 plan — the same $299.
    // Any further kiosk on that row was bought, and comes back as bought.
    if (l.coveredByPackage === MARKETING_TERM_PLAN_NAME && isMarketingKit(l.hubspotProductId, l.name)) {
      merged.set(MEGA_LOANER_PRODUCT_ID, (merged.get(MEGA_LOANER_PRODUCT_ID) ?? 0) + l.qty);
      continue;
    }
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
 * The billing delay a plan starts with — 45 days on the two POS plans
 * (45 since 2026-10-29, product owner: "45 day default billing delay"; it was 60 when
 * the product owner asked for it, 2026-10-09: "automatically add in billing after 60 days for
 * all-in-one and order/pay only, then let them adjust if needed").
 *
 * A SEEDED DEFAULT, not a derived value, and the distinction is the whole
 * design. It is written into `adjustments` when a plan is chosen, so it is an
 * ordinary rep edit from that moment on: the rep can change it, or set the
 * line back to "At checkout" and have it stay there. Derived in `buildQuote`
 * instead, clearing it would delete the adjustment and the default would
 * silently come back on the next render.
 */
export const PLAN_DEFAULT_BILLING_DELAY_DAYS = 45;

/** The billing start a newly chosen plan seeds onto its recurring lines, if any. */
export function planDefaultBillingStart(quoteType: QuoteType): BillingStart | null {
  return isProcessingQuote(quoteType)
    ? { mode: "days", days: PLAN_DEFAULT_BILLING_DELAY_DAYS }
    : null;
}

/**
 * Who a quote's note is written for — the name the rep-facing copy says it
 * goes to, so a required box says who is going to read it.
 *
 * Elizabeth Phillips, 2026-10-12 — "if they make the delayed billing longer
 * than 60 days, force them to leave a note explaining why and tagging me
 * automatically".
 *
 * The "tagging" half is GONE as of 2026-10-14: the note moved off a HubSpot
 * note engagement and onto the deal's `billing_notes` property, which renders
 * as the "Billing Notes" card on the deal record and notifies nobody. So this
 * is now a NAME and nothing else — her owner id (161690499) went with the
 * @mention markup that needed it. An alert, if it's wanted back, is a
 * HubSpot-side workflow on "Billing Notes has changed"; see
 * `setDealBillingNotes`.
 *
 * Here rather than in `adapters/hubspot.ts` because the rep-facing copy has to
 * name who it goes to, and that file is server-only.
 */
export const QUOTE_NOTE_WATCHER = {
  name: "Elizabeth Phillips",
} as const;

/**
 * The shortest note that counts as an explanation. A required box a rep can
 * satisfy with "x" only slows them down.
 */
export const MIN_QUOTE_NOTE_LENGTH = 10;

/** How far out a line's first charge sits. 0 for "at checkout", and for a date already past. */
export function billingStartDelayDays(start: BillingStart | null | undefined): number {
  if (!start) return 0;
  return start.mode === "days" ? Math.max(0, Math.floor(start.days)) : daysUntil(start.date);
}

/** The longest first-charge delay anywhere on the quote. */
export function longestBillingDelayDays(lines: Array<{ billingStart?: BillingStart | null }>): number {
  return lines.reduce((n, l) => Math.max(n, billingStartDelayDays(l.billingStart)), 0);
}

/**
 * The one billing delay this plan's quotes carry silently: its own default.
 * 45 days on the two POS plans, "at checkout" on the marketing plans.
 */
export function planDefaultBillingDelayDays(quoteType: QuoteType): number {
  return billingStartDelayDays(planDefaultBillingStart(quoteType));
}

/**
 * Why this quote doesn't bill when the plan says it bills.
 *
 * A note is required whenever the first charge sits anywhere OTHER than the
 * plan's own default — product owner, 2026-10-15: "if billing delay is not 60
 * days that should force rep to put note as well". That REVERSES the
 * "anything longer than 60" rule this started as (Elizabeth Phillips,
 * 2026-10-12): pulling the first charge FORWARD is a decision about AIO's own
 * cash as much as pushing it back is, and it was the one direction nobody had
 * to explain.
 *
 * Still distinct from the delay CEILING (`maxBillingDelayDays`), which REFUSES
 * and is raised by an admin. This one doesn't refuse the delay, it refuses the
 * silence.
 *
 * Three things are load-bearing about how it's measured:
 *
 *  - **It compares against the PLAN's default, not against 45.** A marketing
 *    quote has no 45-day default — `planDefaultBillingStart` returns null for
 *    one — so a flat "must be 45" would have demanded a note on every
 *    marketing quote ever sent, for billing exactly when its plan says to.
 *  - **It reads the LONGEST delay, the same scalar the rep-facing control and
 *    the HubSpot preamble read**, rather than asking each line separately. A
 *    rep who seeds the plan's 45 days and then adds a monthly line that bills
 *    at checkout has a quote whose longest delay is still 45 — and the global
 *    "Billing starts" control, which is how a rep sets this, moves every
 *    recurring line together anyway.
 *  - **A quote with no RECURRING line is exempt.** A one-time line can't carry
 *    a billing start at all (HubSpot refuses to publish one that does — see
 *    `applyLineAdjustment`), so its delay is structurally 0; without this a
 *    rate-only quote, which has no lines whatsoever, would read as "bills at
 *    checkout, not 45 days" and demand a note about billing it never does.
 */
export function quoteNoteBlockers(
  lines: Array<{ billingFrequency?: BillingFrequency; billingStart?: BillingStart | null }>,
  note: string | null | undefined,
  quoteType: QuoteType
): string[] {
  const recurring = lines.filter(l => l.billingFrequency !== "one_time");
  if (!recurring.length) return [];

  const days = longestBillingDelayDays(recurring);
  const expected = planDefaultBillingDelayDays(quoteType);
  if (days === expected) return [];
  if ((note ?? "").trim().length >= MIN_QUOTE_NOTE_LENGTH) return [];

  return [
    `${describeDelayDeviation(days, expected)} — write a note saying why. ` +
    `It goes onto the HubSpot deal's Billing Notes for ${QUOTE_NOTE_WATCHER.name}.`,
  ];
}

/**
 * How the deviation is said, in one sentence — shared by the rep-facing
 * blocker above and the HubSpot Billing Notes preamble
 * (`mirrorQuoteNote`, actions/prospects.ts), so the reason a rep is asked for
 * is phrased the same way as the record it lands in.
 */
export function describeDelayDeviation(days: number, expected: number): string {
  const plan = expected > 0 ? `the plan's ${expected}-day default` : "the plan's start at checkout";
  return days === 0
    ? `This quote takes its first charge at checkout rather than on ${plan}`
    : `This quote holds a first charge for ${days} days rather than on ${plan}`;
}

/**
 * The admin limits that aren't the discount cap: per-product quantity caps and
 * the longest billing delay a rep may set unaided. One row in
 * `quote_limit_policy`, read together, passed to `buildQuote` together.
 */
export type QuoteLimits = {
  unitCaps: Record<string, number>;
  /**
   * productId → the most that line may be discounted, as a whole percent. A
   * product absent from the map falls back to the global
   * `maxDiscountPercent` — see `discountCapFor`. Added 2026-10-15.
   */
  discountCaps: Record<string, number>;
  maxBillingDelayDays: number;
  /** Whether the picker offers the two tablets at all. See TABLET_PRODUCT_IDS. */
  showTablets: boolean;
};

export const DEFAULT_QUOTE_LIMITS: QuoteLimits = {
  unitCaps: DEFAULT_UNIT_CAPS,
  discountCaps: {},
  maxBillingDelayDays: DEFAULT_MAX_APPROVED_DELAY_DAYS,
  showTablets: DEFAULT_SHOW_TABLETS,
};

/**
 * Put a rep's edits onto a derived line.
 *
 * `billingStart` is STRIPPED from a one-time line rather than rejected, and
 * that strip is LOAD-BEARING — it is not merely tidying up a no-op. HubSpot
 * REFUSES to publish a payment-enabled quote carrying a dated one-time line:
 * `400 NON_RECURRING_FUTURE_BILLED_LI_NOT_ALLOWED`, "Line items with one-time
 * frequency must start billing at payment". Proven live 2026-10-12, after a
 * build that allowed it was reverted the same day; see the CLAUDE.md entry.
 * Letting one through here would make the quote unpublishable at the one point
 * where there is a merchant waiting.
 *
 * Stripped rather than reported because the rep is never offered the control,
 * so a value arriving here is a shape artifact (a rep delayed a line, then
 * swapped it for a one-time product), not a decision worth stalling a quote
 * over. A bad discount is the opposite and is reported by
 * `adjustmentBlockers`.
 */
export function applyLineAdjustment(line: QuoteLine, adjustment: LineAdjustment | undefined): QuoteLine {
  if (!adjustment) return line;
  const next = { ...line };

  // The two discount levers are MUTUALLY EXCLUSIVE and both are cleared
  // first, so an adjustment that switched from one to the other can never
  // leave the old one behind on the line — a line carrying both would bill
  // one figure and display the other.
  delete next.discountPercent;
  delete next.discountAmount;

  const amount = adjustment.discountAmount;
  const pct = adjustment.discountPercent;
  if (amount !== undefined && amount !== null && amount > 0) next.discountAmount = amount;
  else if (pct !== undefined && pct !== null && pct > 0) next.discountPercent = pct;

  const start = adjustment.billingStart;
  if (start && line.billingFrequency !== "one_time") next.billingStart = start;
  else delete next.billingStart;

  return next;
}

/**
 * The discount ceiling for ONE line: a PRODUCT-SPECIFIC cap when an admin set
 * one, the global cap otherwise.
 *
 * Added 2026-10-15 (product owner: "make max discounts per line item instead
 * of a global"). The global (`margin_policy.maxDiscountPercent`) did NOT go
 * away — it is the FALLBACK here, and stays the standing approval lever
 * ("raising it is how a discount over 50% gets approved"): a product absent
 * from the per-product map still has to be capped by something. Same
 * jsonb-map-over-column reasoning as `DEFAULT_UNIT_CAPS`: the catalog is an
 * open set maintained in HubSpot by non-engineers, so a new product must be
 * cappable without a deploy, and an uncapped one falls through to the global.
 */
function discountCapFor(
  hubspotProductId: string,
  discountCaps: Record<string, number>,
  globalCap: number
): { cap: number; isSpecific: boolean } {
  const specific = discountCaps[hubspotProductId];
  return Number.isFinite(specific)
    ? { cap: Math.min(100, Math.max(0, specific)), isSpecific: true }
    : { cap: globalCap, isSpecific: false };
}

/**
 * Products a rep may never discount (product owner, 2026-10-30: "the mega
 * loaner should not be able to be discounted", "website cannot be
 * discounted"). `adjustmentBlockers` refuses any rep discount on them; a
 * `coveredByPackage` line is exempt, since the All-in-One free Website is
 * AIO's own 100% comp, not a rep's choice.
 */
export const NEVER_DISCOUNTED_PRODUCT_IDS: readonly string[] = [MEGA_LOANER_PRODUCT_ID, WEBSITE_PRODUCT_ID];

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
  maxBillingDelayDays: number = DEFAULT_MAX_APPROVED_DELAY_DAYS,
  /** Per-product discount ceilings. See `discountCapFor`. */
  discountCaps: Record<string, number> = {},
  /**
   * The quote's OWN plan/platform line, when it has one — the id
   * `resolvePlatformLine` resolved THIS BUILD, not "any platform product
   * including retired ones". A rep may never discount the plan line at all
   * (product owner, 2026-10-15: "you cannot discount the plan"), but a saved
   * quote's old, now-retired platform line is dropped and re-derived under a
   * DIFFERENT product id on reopen (see `isDroppedOnReopen`) — so scoping to
   * the id resolved now, rather than to `isPlatformProduct`, is what keeps a
   * legacy row with a discounted retired platform line from becoming
   * permanently unsavable the moment it's reopened.
   */
  planProductId: string | null = null
): string[] {
  const blockers: string[] = [];
  const cap = Math.min(100, Math.max(0, maxDiscountPercent));
  const delayCap = Math.min(MAX_BILLING_DELAY_DAYS, Math.max(1, maxBillingDelayDays));

  for (const line of lines) {
    const isPlanLine = planProductId !== null && line.hubspotProductId === planProductId;
    const hasDiscount =
      (line.discountPercent !== undefined && line.discountPercent !== null) ||
      (line.discountAmount !== undefined && line.discountAmount !== null);

    // The plan's own subscription line can't be discounted AT ALL — not
    // capped lower, refused outright, whatever lever the rep used. (A scoped
    // `discountQty` give-away can't surface separately here: the plan line is
    // always qty 1, so `splitPartialDiscount` can never split it, and any
    // discount a rep set still lands on this one line.) This is NOT a
    // derived comp: `COMPED_SERVICE_PRODUCT_IDS` and the package/plan-
    // inclusion comps never touch the platform line, so nothing here can
    // mistake AIO's own derivation for a rep's discount.
    if (NEVER_DISCOUNTED_PRODUCT_IDS.includes(line.hubspotProductId) && hasDiscount && !line.coveredByPackage) {
      blockers.push(`"${line.name}" can't be discounted. Remove the discount.`);
    } else if (isPlanLine && hasDiscount) {
      blockers.push(
        `"${line.name}" is the plan's own subscription line, and the plan price can't be discounted. ` +
        `Remove the discount, or discount a different line.`
      );
    } else {
      const { cap: lineCap, isSpecific } = discountCapFor(line.hubspotProductId, discountCaps, cap);
      const firstKioskUnit = line.firstKiosk === true && line.qty === 1;

      const pct = line.discountPercent;
      if (pct !== undefined && pct !== null) {
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          blockers.push(`"${line.name}" has a discount of ${pct}%, which isn't a percentage between 0 and 100.`);
        } else if (
          pct > lineCap &&
          !((isCompedService(line) || line.coveredByPackage) && pct === 100) &&
          !firstKioskUnit
        ) {
          // A comped service or a package-covered line sitting at exactly 100%
          // is exempt: both are AIO policy — off the price sheet, and out of the
          // package the merchant is already paying for — and the cap exists to
          // bound REP discretion. Without this every quote carrying either would
          // refuse to send, since the default cap is 50%. Any other figure on
          // those lines IS a rep's choice and is capped like anything else.
          // The single first-kiosk unit is exempt at ANY figure (2026-10-29,
          // "allow the discount to be 100"): a rep allowed to give it away
          // can't sensibly be refused 30% off it. Several kiosks on the marked
          // line are capped as usual — only the first one is AIO's to give.
          blockers.push(
            isSpecific
              ? `"${line.name}" is discounted ${pct}%, over the ${lineCap}% limit admin set for this product. ` +
                `Lower it, or ask an admin to raise it in Admin → Quote limits.`
              : `"${line.name}" is discounted ${pct}%, over the ${lineCap}% limit AIO allows on a quote. ` +
                `Lower it, or ask an admin to set a cap for this product in Admin → Quote limits.`
          );
        }
      }

      // A CASH discount is held to the same ceiling, converted. Without this
      // the dollar box would be a way straight around the admin's limit: "$700
      // off a $749 line" is 93%, and nothing above would have looked at it.
      // Expressed against the LIST amount, which is what the percentage lever
      // is a percentage of, so the two controls bound the same thing.
      const amount = line.discountAmount;
      if (amount !== undefined && amount !== null) {
        const list = lineListAmount(line);
        if (!Number.isFinite(amount) || amount < 0) {
          blockers.push(`"${line.name}" has a discount of ${fmt$(amount)}, which isn't an amount of money off.`);
        } else if (amount > list) {
          // Refused rather than clamped, unlike `discountQty`. A quantity past
          // the line means "all of them" and there is nothing else it could
          // mean; a discount bigger than the line is either a typo or a line
          // the rep shrank afterwards, and silently making it "free" is a
          // decision worth more than $0.
          blockers.push(
            `"${line.name}" is discounted ${fmt$(amount)}, which is more than the line's ${fmt$(list)}. ` +
            `A discount can't exceed the price.`
          );
        } else if (list > 0 && (amount / list) * 100 > lineCap && !firstKioskUnit) {
          const asPct = Math.round((amount / list) * 1000) / 10;
          blockers.push(
            isSpecific
              ? `"${line.name}" is discounted ${fmt$(amount)} of ${fmt$(list)} — ${asPct}%, over the ` +
                `${lineCap}% limit admin set for this product. Lower it, or ask an admin to raise it in ` +
                `Admin → Quote limits.`
              : `"${line.name}" is discounted ${fmt$(amount)} of ${fmt$(list)} — ${asPct}%, over the ${lineCap}% ` +
                `limit AIO allows on a quote. Lower it, or ask an admin to raise the limit in ` +
                `Admin → Quote limits.`
          );
        }
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
    // A cash discount counts as a distinct discount for shape purposes, so a
    // line split between a cash figure and list still reopens correctly.
    // Negated so it can never collide with a percentage of the same number —
    // "$50 off" and "50% off" are different edits.
    s.discounts.add(line.discountAmount ? -line.discountAmount : (line.discountPercent || 0));
    if (line.discountPercent || line.discountAmount) s.discounted += 1;
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
    if (line.discountAmount) {
      adjustment.discountAmount = line.discountAmount;
      if (line.qty < (chargeable.get(line.hubspotProductId) ?? 0)) adjustment.discountQty = line.qty;
    } else if (line.discountPercent) {
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

function isRetiredWifiLine(line: { hubspotProductId: string; name: string }): boolean {
  const trimmed = line.name.trim();
  return RETIRED_WIFI_PRODUCTS.some(p => p.hubspotProductId === line.hubspotProductId || p.name === trimmed);
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
  /** Additional software licenses past the three screens the plan includes. */
  softwareLicense: SoftwareLicenseResult;
  /** The $0 card-rate disclosure, on every quote AIO processes for that charges something. */
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
  const licensedPicks = pickedLines.filter(l => !isSoftwareLicenseProduct(l.hubspotProductId, l.name));
  // Marketing Partial Ordering's marketing line is on whatever the picks say
  // (2026-10-30). Joined to the picks BEFORE anything is derived from them, so
  // the quote comes out exactly as if the rep had picked it — the menu boards
  // it makes free included.
  const partialMarketing = resolvePartialOrderingMarketing(quoteType, licensedPicks, catalog);
  const picks = [...licensedPicks, ...partialMarketing.lines];

  const breakdown = deriveOrderPoints(picks, effectiveChannels);
  const platform = resolvePlatformLine(quoteType, picks, effectiveChannels, catalog);
  const includedServices = resolveIncludedServices(quoteType, picks, catalog);
  const requiredTerminals = resolveRequiredAms1(quoteType, picks, catalog);
  const softwareLicense = resolveSoftwareLicense(picks, catalog);

  // Everything a PLAN hands over at no charge, taken out of what the rep
  // picked before anything else runs: marketing's three menu boards, and
  // (when a plan is listed for it) the Website.
  // Each comp is a line SPLIT, so it has to happen while these are still the
  // picks; the covered halves then flow through the adjustment pass like a
  // package-covered line.
  const picksWithInclusions = applyPlanIncludedWebsite(
    quoteType,
    applyPlanIncludedHardware(quoteType, withRequiredTerminals(picks, requiredTerminals))
  );

  // The hardware kit, resolved against the mandatory services AND the picks —
  // it covers the AMS1 each POS ships with, a derived top-up, so restricting
  // this to the picks would leave it uncovered. (The WiFi package it also
  // covers has been an ordinary pick since 2026-10-21.)
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

  // The first kiosk is never in the kit (2026-10-29): an ordinary line,
  // marked below.
  const firstKiosk = firstKioskProductId(quoteType, picks);

  const unitCursor = new Map<string, number>();
  const adjustedLines = [
    ...(platform.line ? [platform.line] : []),
    ...softwareLicense.lines,
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

  // Marked on ONE line of the product — the cheapest per unit, the first
  // among equals — so the cap exemption and the commission rate land on the
  // unit the rep discounted: "1 of 2 at 100%" splits into a 1-unit line at
  // 100% and one at list, and the marker goes on the 100% one wherever the
  // split (or "adjust each unit") put it. Read back off the saved lines, which
  // are all the publish re-check has.
  const kioskLines = adjustedLines.filter(l => l.hubspotProductId === firstKiosk);
  const kioskLine = kioskLines.reduce<QuoteLine | null>(
    (best, l) => (!best || lineNetAmount(l) / l.qty < lineNetAmount(best) / best.qty ? l : best),
    null
  );
  const chargedLines = adjustedLines.map(line =>
    line === kioskLine ? { ...line, firstKiosk: true as const } : line
  );

  // The rate disclosure and the pre-authorization both come LAST and past
  // every adjustment, for the same two reasons: neither is the rep's to edit,
  // and neither may count toward `quoteSanityBlockers`. The disclosure is $0,
  // so counting it would make "every line nets to $0" fire on a quote that
  // charges nothing BECAUSE it's rate-only; the pre-auth is fifty cents, so
  // counting it would rescue a quote that genuinely nets to $0.
  //
  // The disclosure is judged on whether anything is being CHARGED, and the
  // pre-auth on what would be collected once it's there.
  const processingDisclosure = resolveProcessingDisclosure(
    quoteType, picks, catalog, chargedLines.length > 0
  );
  const withDisclosure = [...chargedLines, ...processingDisclosure.lines];
  const preAuth = resolvePreAuthLine(withDisclosure, catalog);
  const quoteLines = [...withDisclosure, ...preAuth.lines];

  const totals = quoteTotals(quoteLines);

  const blockers: string[] = [
    ...adjustmentBlockers(
      quoteLines, maxDiscountPercent, limits.maxBillingDelayDays, limits.discountCaps,
      platform.status === "resolved" ? platform.line.hubspotProductId : null
    ),
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
      `AIO processes card payments for this merchant, so the quote has to state their rates — but ` +
      `"${name}" isn't in the HubSpot catalog (renamed, archived, or the catalog didn't load). The ` +
      `merchant would be signed up for card processing with no rates written on the document.`
    );
  }
  for (const name of partialMarketing.missing) {
    blockers.push(
      `Marketing Partial Ordering always includes marketing, so the quote needs the "${name}" line — ` +
      `but it isn't in the HubSpot catalog (renamed, archived, or the catalog didn't load).`
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
  // …and nothing is on it in a quantity that has nothing to attach to.
  blockers.push(...relativeCeilingBlockers(quoteLines));
  blockers.push(...payrollBlockers(quoteLines));
  blockers.push(...partialOrderingPosBlockers(quoteType, quoteLines));
  blockers.push(...partialOrderingPointBlockers(quoteType, quoteLines));

  for (const [productId, { name, qty }] of qtyByProduct) {
    const max = maxQtyFor(productId, limits.unitCaps);
    if (max != null && qty > max) {
      blockers.push(
        `This quote has ${qty} × "${name}" on it, over the limit of ${max}. Drop the extras, or ask ` +
        `an admin to raise it in Admin → Quote limits.`
      );
    }
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
