// The hardware kit that comes with an Order & Pay / All-in-One deal, and the
// cart → covered-lines decomposition that applies it.
//
// Pure and dependency-free for the same reasons quoting.ts is: no DB, no
// HubSpot, no pricing.ts, nothing that is an AIO internal. quoting.ts calls in;
// nothing here calls back, so the import only ever runs one way.
//
// ── HOW A KIT IS EXPRESSED ON THE QUOTE ────────────────────────────────────
//
// There is NO package line. Until 2026-10-08 a kit was a real HubSpot product
// ("QSR Kit") at a package price with the hardware it covered stacked on top;
// that is gone. The kit is free, so what it covers is simply the real hardware
// lines, still on the quote at their listed price, discounted 100% and carrying
// `QuoteLine.coveredByPackage`. That is the same expression the comped install
// and training lines use, and the shape Steve's AE price sheet tells merchants
// to expect: lines "will still appear on customer quotes at their listed MSRP,
// automatically discounted to $0".
//
// ── WHAT DECIDES WHETHER A LINE FITS A SLOT ────────────────────────────────
//
// Each slot is a SHEET ITEM (POS, KDS, printer …) and each sheet item has an
// MSRP. A cart line fits a slot two ways:
//
//   1. EXACT — the line is made of that very item. Always fits, at any price.
//   2. SWAP  — the line is made of a different but SWAPPABLE item that costs NO
//      MORE than the slot's MSRP (Shaheer, 2026-10-09). A cheaper item in an
//      open slot gives away less than the kit already promised, so there is no
//      lower bound: a tableside device can stand in for a POS, a printer for a
//      KDS. Among the slots it fits, an item takes the CHEAPEST, so it leaves
//      the dear slots for the dear items.
//   3. INTERCHANGE — the four screens in `INTERCHANGEABLE` fill each other's
//      slots in EITHER direction, whatever they cost (Shaheer, 2026-10-16).
//      This is the one place the MSRP ceiling is lifted, and the $400 "Free Kit
//      Replacement Item" that quoting.ts derives per swap is what pays for it.
//      The Mega Kiosk is deliberately not a member — $2,700 into the $735 KDS
//      slot is $1,965 that $400 does not come close to covering.
//
// EVERY swap is charged, not just the ones the ceiling used to refuse. See
// `PackageDecomposition.swaps`.
//
// Hardware that is NOT on the sheet (mPOS, the tablets, the label printer) can
// swap too, priced at its HubSpot list price since there is no sheet MSRP. It
// never fills a slot exactly, never counts as an ordering device, and only
// one-time "inventory" lines qualify — services and software are never kit
// hardware.
//
// Some items are LOCKED (`swappable: false`) and fit ONLY their own slot, in
// both directions: a locked item can't fill another slot, and a locked slot
// won't take another item. Without that, MSRP alone would let a $299 customer
// facing display into the $336 printer slot and a $350 terminal into it too.
//
// ── ONE HUBSPOT LINE CAN BE SEVERAL SHEET ITEMS ────────────────────────────
//
// "Kiosk 27" + Payment Terminal (AMS1) and Mount" is a kiosk AND a terminal;
// "POS Unit - With Customer Facing Display" is a POS AND a display. Those are
// expanded into their parts (PRODUCT_PARTS) and a unit is covered only if EVERY
// part finds a slot — a kiosk whose terminal has nowhere to go would otherwise
// be covered for part of its price, which is a partial discount on one line and
// the rounding problem `splitPartialDiscount` exists to avoid.
//
// ── V1 LIMITS ──────────────────────────────────────────────────────────────
//
// - ONE-TIME lines only. A weekly fee and a hardware price are different units
//   (see quoteTotals), and nothing in the kit is recurring.
// - WHOLE UNITS only. A swap dearer than the slot is not covered at all rather
//   than covered "up to the slot value", which would need a fractional discount on
//   one line. That is the next decision to make, not a gap in this one.
// - A kit APPLIES only when an ORDERING DEVICE (a POS, kiosk or tableside
//   device) was placed — in whatever slot it landed. A WiFi package and a
//   drawer on their own are not a system, and WiFi is added to any quote with
//   hardware on it, so without this a lone printer quote would get $999 of
//   WiFi for free.

import type { QuoteLine, QuoteType } from "@/types/merchant";

// ── The sheet ───────────────────────────────────────────────────────────────

/**
 * The items on the Hardware Master Pricing sheet that the kit can hold.
 * A key names a physical thing, not a HubSpot product — one product can be
 * several of these (see PRODUCT_PARTS).
 */
export type SheetKey =
  | "pos" | "cfd" | "terminal"
  | "kiosk27" | "kiosk156" | "mega" | "tableside"
  | "kds" | "printer" | "drawer" | "menuboard" | "wifi";

export type SheetItem = {
  /** For reading only. */
  label: string;
  /**
   * The HIGHEST selling price the sheet carries for this item, across its rep
   * floor / list / suggested MSRP / HubSpot / finalized columns and the Zia
   * tab. The sheet is not final and disagrees with itself, so the rule until
   * it settles is "take the highest" (Shaheer, 2026-10-08). Landed COST is
   * never a candidate. The source column is noted per row so a row can be
   * re-checked the day the sheet is finalized.
   */
  msrp: number;
  /** false = fits only its own slot, in both directions. See the header. */
  swappable: boolean;
  /** A device that takes orders. Placing one is what makes a kit apply. */
  orders?: true;
};

export const SHEET_ITEMS: Record<SheetKey, SheetItem> = {
  // list $949 / HubSpot $949 — suggested MSRP is only $855, finalized $900
  pos:       { label: "POS",                                  msrp: 949,  swappable: true, orders: true },
  // "POS Secondary" in the sheet; finalized $299 (suggested $267, list $170)
  cfd:       { label: "Customer Facing Display",              msrp: 299,  swappable: false },
  // Zia tab $350 (main tab: finalized $300, suggested $299, list $250)
  terminal:  { label: "Payment Terminal (AMS1)",              msrp: 350,  swappable: false },
  // list / HubSpot / finalized $999 (suggested $975, Zia tab $888.75)
  kiosk27:   { label: "Kiosk 27\"",                           msrp: 999,  swappable: true, orders: true },
  // list / HubSpot / finalized $799 (Zia tab $720; no suggested MSRP)
  kiosk156:  { label: "Kiosk 15.6\"",                         msrp: 799,  swappable: true, orders: true },
  // suggested MSRP $2,700 (list and HubSpot $2,459)
  mega:      { label: "Mega Kiosk",                           msrp: 2700, swappable: true, orders: true },
  // suggested MSRP $603 (finalized $399, list $330)
  tableside: { label: "AIO Tableside POS",                    msrp: 603,  swappable: true, orders: true },
  // suggested MSRP and Zia tab $735 (list $399, finalized $499)
  kds:       { label: "KDS",                                  msrp: 735,  swappable: true },
  // suggested MSRP and Zia tab $336 (list $199, finalized $249)
  printer:   { label: "Thermal Printer",                      msrp: 336,  swappable: true },
  // Zia tab $75 only — the main tab carries no suggested MSRP (list $70)
  drawer:    { label: "Cash Drawer",                          msrp: 75,   swappable: false },
  // suggested MSRP $108 (finalized $99, list $70)
  menuboard: { label: "Menu Board Computer",                  msrp: 108,  swappable: false },
  // list / HubSpot / finalized $999 (suggested $527, Zia tab $549)
  wifi:      { label: "AIO WiFi Network Package",             msrp: 999,  swappable: false },
};

/**
 * What each HubSpot product is made of, in sheet items. A product that is not
 * here can still SWAP into a slot at its HubSpot price if it is one-time
 * hardware (see `partsOf`), but never fills one exactly. Add the row when
 * someone adds the sheet value.
 *
 * Keyed by product id, like ORDER_POINT_RULES, so a rename in HubSpot can't
 * silently drop a product out of the kit.
 *
 * NOT MAPPED, on purpose: mPOS and the Orders Hub / Clock-in tablets (no sheet
 * row), the Epson Sticky Printer (a label printer — not the sheet's printer),
 * and the Marketing Kit kiosks (they belong to the marketing plans).
 */
export const PRODUCT_PARTS: Record<string, SheetKey[]> = {
  "217445755632": ["pos"],                // POS Unit
  "223452690130": ["pos", "cfd"],         // POS Unit - With Customer Facing Display
  "318736467644": ["cfd"],                // Customer Facing Display
  "223511653105": ["terminal"],           // Payment Terminal - AMS1
  "222497165009": ["kiosk27", "terminal"],  // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666": ["kiosk156", "terminal"], // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
  "260674226888": ["mega"],               // Mega Kiosk
  "335279520447": ["tableside"],          // AIO Tableside POS
  "223452690132": ["kds"],                // KDS (Kitchen Display System)
  "223511653104": ["printer"],            // Thermal Printer
  "222497165011": ["drawer"],             // Cash Drawer
  "223511653103": ["menuboard"],          // Menu Board Computer
  // AIO retired "AIO WiFi Network Package" (281351401209) 2026-10-13 and
  // replaced it with the Unifi variant quoting.ts now derives — see
  // WIFI_PRODUCT_ID / RETIRED_WIFI_PRODUCTS there. The sheet slot and its MSRP
  // are unchanged; only the id a cart line must carry to fill it moves.
  "338690209525": ["wifi"],               // AIO Wifi Network Package - Unifi
};

/** The MSRP of a whole HubSpot product — the sum of what it is made of — or null if unmapped. */
export function sheetMsrpOf(hubspotProductId: string): number | null {
  const parts = PRODUCT_PARTS[hubspotProductId];
  return parts ? parts.reduce((sum, k) => sum + SHEET_ITEMS[k].msrp, 0) : null;
}

/** Whether an item may swap into a slot: it costs no more than the slot's MSRP. */
export function fitsUnder(candidate: number, slot: number): boolean {
  // The epsilon is for list prices carried in cents: 949 vs 948.9999….
  return candidate <= slot + 1e-9;
}

/**
 * The screens that fill each other's slots in EITHER direction, whatever they
 * cost — the one exception to `fitsUnder` (Shaheer, 2026-10-16).
 *
 * A set of named members rather than a group tag on `SheetItem`, because the
 * MEGA KIOSK'S ABSENCE is the point: at $2,700 it would take the $735 KDS slot
 * and the $400 replacement charge would cover less than a quarter of it. Adding
 * a member here is a pricing decision, so it should read like one.
 *
 * All four are already `swappable: true`; this lifts the ceiling, never a lock.
 */
const INTERCHANGEABLE: ReadonlySet<SheetKey> = new Set<SheetKey>([
  "pos", "kds", "kiosk27", "kiosk156",
]);

/** Whether this part may take this slot's seat regardless of what either costs. */
function interchanges(part: SheetKey | null, slot: SheetKey): boolean {
  return part !== null && INTERCHANGEABLE.has(part) && INTERCHANGEABLE.has(slot);
}

/**
 * One physical part of a cart line. `key` is null for hardware the sheet
 * doesn't carry, which can only ever swap (see the header).
 */
type Part = { key: SheetKey | null; msrp: number; swappable: boolean; orders: boolean };

function partsOf(line: QuoteLine): Part[] | null {
  const keys = PRODUCT_PARTS[line.hubspotProductId];
  if (keys) {
    return keys.map(k => ({
      key: k, msrp: SHEET_ITEMS[k].msrp, swappable: SHEET_ITEMS[k].swappable, orders: !!SHEET_ITEMS[k].orders,
    }));
  }
  if (line.productType === "inventory" && Number.isFinite(line.unitPrice) && line.unitPrice > 0) {
    return [{ key: null, msrp: line.unitPrice, swappable: true, orders: false }];
  }
  return null;
}

// ── The kit ─────────────────────────────────────────────────────────────────

export type PackageSlot = {
  item: SheetKey;
  qty: number;
};

export type QuotePackage = {
  /** Stable internal id. Never shown; `name` is what a merchant reads. */
  id: string;
  /** Shown on the quote and stored on every covered line as `coveredByPackage`. */
  name: string;
  /** Off means the kit never applies and is never mentioned. */
  active: boolean;
  /** The quote types this kit comes with. */
  plans: QuoteType[];
  slots: PackageSlot[];
  /** How many of this kit one quote may carry. */
  maxPerQuote?: number;
};

/**
 * Code, not a DB table, for the same reason ORDER_POINT_RULES is: this decides
 * what a merchant is charged, it changes rarely, and a mis-typed slot would
 * silently change what every open quote decomposes to.
 *
 * Contents are the QSR kit as Shaheer specified it 2026-10-08: printer, POS,
 * kiosk, KDS, cash drawer, menu board, WiFi package and TWO Adyen terminals —
 * one for the POS, one inside the kiosk line item — plus the POS's customer
 * facing display, which the sheet's POS assembly carries.
 */
export const PACKAGES: QuotePackage[] = [
  {
    id: "qsr_kit",
    name: "QSR Kit",
    active: true,
    plans: ["order_pay_only", "all_in_one"],
    // ONE per quote until it is decided what a second location gets. Free
    // hardware times N is the largest number this module can move.
    maxPerQuote: 1,
    slots: [
      // Slot order is also the order the picker lists the kit in (see
      // `kitPicks`), which is why everything that MOVES WITH THE POS — the
      // display, the drawer, and the terminal the configurator splices in
      // beside them — comes first, directly under it. A row whose quantity
      // changes on its own has to be where the rep can see it change.
      //
      // The decomposition itself does not depend on this order: an exact fit
      // takes the only slot its item could, and a swap takes the cheapest slot
      // it fits, with the index only breaking a tie between two slots of the
      // SAME price. The one such pair is kiosk27 and wifi at $999, and wifi is
      // locked (`swappable: false`), so it is never a swap target at all.
      { item: "pos", qty: 1 },
      { item: "cfd", qty: 1 },
      { item: "drawer", qty: 1 },
      { item: "terminal", qty: 2 },
      { item: "kiosk27", qty: 1 },
      { item: "kds", qty: 1 },
      { item: "printer", qty: 1 },
      { item: "menuboard", qty: 1 },
      { item: "wifi", qty: 1 },
    ],
  },
];

// ── Wording ─────────────────────────────────────────────────────────────────

/**
 * "In the package" / "1 of 3 in the package" — the tag on a picker row.
 *
 * `onQuote` is how many units of the product are on the QUOTE, not how many the
 * rep picked. They can differ for a product that is also derived — an AMS1
 * topped up to one per POS (`resolveRequiredAms1`) sits on the quote while the
 * row's stepper doesn't count it, which once printed "1 of 0 in the package".
 * Callers pass the quote's figure; this also clamps, so a mismatch can never
 * print more than the whole.
 * Returns null when nothing is covered.
 */
export function coverageLabel(covered: number, onQuote: number, where: string): string | null {
  if (!(covered > 0)) return null;
  if (covered >= onQuote) return `In ${where}`;
  return `${covered} of ${onQuote} in ${where}`;
}

// ── Preselecting the kit ────────────────────────────────────────────────────

/**
 * The product a rep would pick for each slot, for preselecting the kit when a
 * plan is chosen.
 *
 * `terminal` and `wifi` are ABSENT on purpose. The kit's two terminals are the
 * POS's AMS1 — which the configurator adds alongside every POS it picks, kit or
 * not (`minimumTerminalsFor`) — and the one inside the kiosk SKU. Naming the
 * terminal here would add a second AMS1 for the kiosk that already has one.
 * The WiFi package is an always-included service, never a pick. The test file
 * asserts the preselect really does fill every slot, so changing the kit
 * without changing this fails loudly.
 */
export const KIT_DEFAULT_PRODUCTS: Partial<Record<SheetKey, string>> = {
  pos: "217445755632",       // POS Unit
  kiosk27: "222497165009",   // Kiosk 27" + Payment Terminal (AMS1) and Mount
  cfd: "318736467644",       // Customer Facing Display
  kds: "223452690132",       // KDS (Kitchen Display System)
  printer: "223511653104",   // Thermal Printer
  drawer: "222497165011",    // Cash Drawer
  menuboard: "223511653103", // Menu Board Computer
};

/** The active kit that comes with this plan, if any. */
export function kitFor(quoteType: QuoteType): QuotePackage | null {
  return PACKAGES.find(p => p.active && p.plans.includes(quoteType)) ?? null;
}

/** What to preselect so the quote opens with the whole kit on it. */
export function kitPicks(kit: QuotePackage): Array<{ hubspotProductId: string; qty: number }> {
  const qtyById = new Map<string, number>();
  for (const slot of kit.slots) {
    const id = KIT_DEFAULT_PRODUCTS[slot.item];
    if (id) qtyById.set(id, (qtyById.get(id) ?? 0) + slot.qty);
  }
  return [...qtyById].map(([hubspotProductId, qty]) => ({ hubspotProductId, qty }));
}

// ── Decomposition ───────────────────────────────────────────────────────────

export type AppliedPackage = {
  packageId: string;
  name: string;
  count: number;
  /** What the kit itself costs the merchant. Always 0 — it is free; kept so the panel can show it. */
  price: number;
};

/** One unit of one line landing in one slot. `swapped` is the fuzzy case. */
export type FilledSlot = {
  hubspotProductId: string;
  /** Null for hardware the sheet doesn't carry — always a swap. */
  part: SheetKey | null;
  slot: SheetKey;
  swapped: boolean;
};

export type PackageDecomposition = {
  /**
   * The input lines, rewritten. A line whose quantity was partly absorbed is
   * SPLIT: the covered part at 100% off carrying `coveredByPackage`, the rest
   * at MSRP. Input order is preserved, covered part first.
   */
  lines: QuoteLine[];
  applied: AppliedPackage[];
  /** Which item went in which slot — what to read to see WHY something was or wasn't covered. */
  filled: FilledSlot[];
  /**
   * How many UNITS landed in a slot that isn't their own — what the merchant is
   * charged a "Free Kit Replacement Item" for, one each (`resolveKitReplacementLine`).
   *
   * Counted per unit and NOT as `filled.filter(f => f.swapped).length`, because
   * one physical unit can be several sheet items: a "Kiosk 27" + AMS1" that
   * moved would otherwise be billed as two swaps.
   */
  swaps: number;
  /**
   * Terminals welded into a swapped-in kiosk that the kit had no seat left
   * for. quoting.ts charges the merchant one AMS1 each — see `placeUnit`.
   */
  extraTerminals: number;
  /** Listed price of everything the kits absorbed. */
  coveredListAmount: number;
  /** What the kits are worth to the merchant. The kit is free, so this IS `coveredListAmount`. */
  savings: number;
};

function none(lines: QuoteLine[]): PackageDecomposition {
  return { lines, applied: [], filled: [], swaps: 0, extraTerminals: 0, coveredListAmount: 0, savings: 0 };
}

/** A coverable line and how much of it is still unclaimed. */
type PoolEntry = { line: QuoteLine; parts: Part[]; left: number; msrp: number };

type Slot = { item: SheetKey; owner: number };

// A kit can't be applied more times than this, whatever a package says. A
// guard against a data-entry mistake, not a business rule.
const MAX_PACKAGE_INSTANCES = 10;

/** A placement: where each part of one unit sits, and what it couldn't seat. */
type Placement = {
  placed: Array<{ part: Part; slot: number }>;
  /**
   * Terminals this unit brought that the kit has no seat left for. Only ever
   * non-zero on an INTERCHANGE swap — see `placeUnit`.
   */
  extraTerminals: number;
};

/**
 * Where one unit of this entry would go. Returns the slot index per part, or
 * null if ANY part has nowhere to go — a unit is covered whole or not at all.
 *
 * Exact beats swap, per part. Among swaps the CHEAPEST slot the part fits
 * wins (lowest slot index on a tie), so the answer never depends on the order
 * lines arrived in.
 *
 * ONE EXCEPTION, and it is what makes a kiosk swappable at all: the kiosk SKUs
 * are a kiosk AND a terminal welded together, and the kit holds only two
 * terminal seats — one for the POS's loose AMS1, one for the kiosk that comes
 * in the kit. So a SECOND kiosk swapped into a screen slot always arrives with
 * a terminal that has nowhere to sit, and "covered whole or not at all" would
 * leave the entire $1,495 line charged over a $350 part of it. Instead the
 * terminal is seated nowhere and COUNTED, and quoting.ts charges the merchant
 * an AMS1 for each one (Shaheer, 2026-10-16) — which is the same money a
 * second POS already costs, whose loose AMS1 is charged for the same reason.
 *
 * It is allowed only when another part of the same unit got its seat by
 * INTERCHANGE, so an ordinary cart can never quietly lose a terminal: the
 * exact pass can't produce one (nothing interchanges with `allowSwap` false),
 * and nothing but a terminal is ever left unseated.
 */
function placeUnit(
  entry: PoolEntry,
  slots: Slot[],
  allowSwap: boolean
): Placement | null {
  const used = new Set<number>();
  const placed: Array<{ part: Part; slot: number }> = [];
  const unseated: Part[] = [];
  let interchanged = false;

  for (const part of entry.parts) {
    let pick = part.key === null
      ? -1
      : slots.findIndex((s, i) => s.owner < 0 && !used.has(i) && s.item === part.key);

    if (pick < 0 && allowSwap && part.swappable) {
      let best = Infinity;
      slots.forEach((s, i) => {
        if (s.owner >= 0 || used.has(i)) return;
        const target = SHEET_ITEMS[s.item];
        if (!target.swappable) return;
        if (!interchanges(part.key, s.item) && !fitsUnder(part.msrp, target.msrp)) return;
        if (target.msrp < best) { best = target.msrp; pick = i; }
      });
    }

    if (pick < 0) { unseated.push(part); continue; }
    if (interchanges(part.key, slots[pick].item) && part.key !== slots[pick].item) interchanged = true;
    used.add(pick);
    placed.push({ part, slot: pick });
  }

  if (unseated.length === 0) return { placed, extraTerminals: 0 };
  // Only a welded-on terminal, and only alongside an interchange. Anything
  // else unseated means this unit genuinely doesn't fit.
  if (!interchanged || unseated.some(p => p.key !== "terminal")) return null;
  return { placed, extraTerminals: unseated.length };
}

/**
 * How many open slots this entry's parts could land in right now — its
 * flexibility. A unit with ONE place to go has to be placed before one with
 * three, or the flexible one takes the only seat the other could use.
 */
function flexibility(entry: PoolEntry, slots: Slot[]): number {
  let n = 0;
  for (const part of entry.parts) {
    slots.forEach(s => {
      if (s.owner >= 0) return;
      const target = SHEET_ITEMS[s.item];
      const canSwap = part.swappable && target.swappable &&
        (interchanges(part.key, s.item) || fitsUnder(part.msrp, target.msrp));
      if (s.item === part.key || canSwap) n += 1;
    });
  }
  return n;
}

/**
 * Cover what the kits cover, out of the cart.
 *
 * Per kit instance: first every unit that fits EXACTLY, then the leftovers by
 * SWAP — the MOST CONSTRAINED unit first (fewest slots it could take), dearest
 * on a tie, into the cheapest slot it fits. Cheapest-first alone strands
 * coverage: a tableside device and a printer both fit the KDS slot, and the
 * one placed first would take the seat the other needed. This is a heuristic, not a matching solver —
 * it can still leave money on the table in a contrived cart, and it never
 * covers anything the rules above don't allow. An instance that places no
 * ordering device is thrown away and no further instances are tried.
 */
export function decomposePackages({
  lines,
  quoteType,
  packages = PACKAGES,
}: {
  lines: QuoteLine[];
  quoteType: QuoteType;
  packages?: QuotePackage[];
}): PackageDecomposition {
  const active = packages.filter(p => p.active && p.plans.includes(quoteType));
  if (active.length === 0 || lines.length === 0) return none(lines);

  // Only one-time lines are coverable, and only hardware (see `partsOf`).
  const pool: PoolEntry[] = [];
  const poolIndexOfLine = new Map<number, number>();
  lines.forEach((line, i) => {
    const parts = partsOf(line);
    if (
      !parts ||
      line.billingFrequency !== "one_time" ||
      !Number.isInteger(line.qty) ||
      line.qty <= 0 ||
      // Already paid for by something else — a plan, or a comp.
      line.coveredByPackage
    ) return;
    poolIndexOfLine.set(i, pool.length);
    pool.push({ line, parts, left: line.qty, msrp: parts.reduce((n, part) => n + part.msrp, 0) });
  });
  if (pool.length === 0) return none(lines);

  const taken = pool.map(() => 0);
  const by = pool.map(() => new Set<string>());
  const filled: FilledSlot[] = [];
  const applied: AppliedPackage[] = [];
  let swaps = 0;
  let extraTerminals = 0;

  for (const pkg of active) {
    const cap = Math.min(pkg.maxPerQuote ?? MAX_PACKAGE_INSTANCES, MAX_PACKAGE_INSTANCES);
    let count = 0;

    for (let n = 0; n < cap; n++) {
      const slots: Slot[] = pkg.slots.flatMap(s =>
        Array.from({ length: s.qty }, () => ({ item: s.item, owner: -1 }))
      );
      const left = pool.map(e => e.left);
      const placedUnits = pool.map(() => 0);
      const placements: FilledSlot[] = [];

      let placedOrderingDevice = false;
      // Per INSTANCE, because an instance that places no ordering device is
      // thrown away below — its swaps were never charged for anything.
      let instanceSwaps = 0;
      let instanceExtraTerminals = 0;
      const commit = (e: number, { placed, extraTerminals }: Placement) => {
        let movedThisUnit = false;
        instanceExtraTerminals += extraTerminals;
        for (const { part, slot } of placed) {
          slots[slot].owner = e;
          if (part.orders) placedOrderingDevice = true;
          const swapped = part.key !== slots[slot].item;
          if (swapped) movedThisUnit = true;
          placements.push({
            hubspotProductId: pool[e].line.hubspotProductId,
            part: part.key,
            slot: slots[slot].item,
            swapped,
          });
        }
        // One charge per UNIT, however many of its parts moved.
        if (movedThisUnit) instanceSwaps += 1;
        left[e] -= 1;
        placedUnits[e] += 1;
      };

      // Exact fits first, in input order. Nothing here competes: an exact fit
      // takes a slot only that item could have, give or take duplicates.
      pool.forEach((_, e) => {
        while (left[e] > 0) {
          const placed = placeUnit(pool[e], slots, false);
          if (!placed) break;
          commit(e, placed);
        }
      });

      // Then swaps, one unit at a time, re-ranking after each placement.
      for (;;) {
        let next: { e: number; flex: number; placed: Placement } | null = null;
        for (let e = 0; e < pool.length; e++) {
          if (left[e] <= 0) continue;
          const placed = placeUnit(pool[e], slots, true);
          if (!placed) continue;
          const flex = flexibility(pool[e], slots);
          if (!next || flex < next.flex || (flex === next.flex && pool[e].msrp > pool[next.e].msrp)) {
            next = { e, flex, placed };
          }
        }
        if (!next) break;
        commit(next.e, next.placed);
      }

      // No ordering device placed means no system here, whatever else fit.
      if (!placedOrderingDevice) break;

      pool.forEach((entry, e) => {
        if (!placedUnits[e]) return;
        entry.left -= placedUnits[e];
        taken[e] += placedUnits[e];
        by[e].add(pkg.name);
      });
      filled.push(...placements);
      swaps += instanceSwaps;
      extraTerminals += instanceExtraTerminals;
      count += 1;
    }

    if (count > 0) applied.push({ packageId: pkg.id, name: pkg.name, count, price: 0 });
  }

  if (applied.length === 0) return none(lines);

  const out: QuoteLine[] = [];
  let coveredListAmount = 0;
  lines.forEach((line, i) => {
    const poolIndex = poolIndexOfLine.get(i);
    const took = poolIndex === undefined ? 0 : taken[poolIndex];
    if (!took || poolIndex === undefined) {
      out.push(line);
      return;
    }
    coveredListAmount += took * line.unitPrice;
    out.push({
      ...line,
      qty: took,
      discountPercent: 100,
      coveredByPackage: [...by[poolIndex]].join(" + "),
    });
    if (line.qty - took > 0) out.push({ ...line, qty: line.qty - took });
  });
  coveredListAmount = Math.round(coveredListAmount * 100) / 100;

  return { lines: out, applied, filled, swaps, extraTerminals, coveredListAmount, savings: coveredListAmount };
}
