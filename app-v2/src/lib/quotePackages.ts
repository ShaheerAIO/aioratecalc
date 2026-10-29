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
// Each slot is a SHEET ITEM (POS, KDS, printer …), and a cart line fits it only
// when the line is made of that item — or of one the slot names as its
// alternative (`PackageSlot.or`: the partial-ordering kit's "KDS or printer").
// Anything else is added to the quote normally, at its price.
//
// SWAPS ARE GONE (2026-10-27, the scenario sheet: "Swap fee eliminated").
// From 2026-10-16 the POS, the KDS and the kiosks could fill each other's
// slots for a $400 "Free Kit Replacement Item" each; what replaced that is the
// free first kiosk. From 2026-10-27 it was an optional kit slot; since
// 2026-10-29 it is OUT of the kit altogether (product owner: "Make the first
// free kiosk fully out of the package. It needs to feel like a discount to
// the customer"): an ordinary line at 100% off, a discount the rep can change
// — see `applyFirstKioskComp` in quoting.ts. The kits still go WITH a kiosk
// (`QuotePackage.appliesWith`).
//
// ── ONE HUBSPOT LINE CAN BE SEVERAL SHEET ITEMS ────────────────────────────
//
// "POS Unit - With Customer Facing Display" is a POS AND a display. It is
// expanded into its parts (PRODUCT_PARTS) and a unit is covered only if EVERY
// part finds a slot — otherwise it would be covered for part of its price,
// which is a partial discount on one line and the rounding problem
// `splitPartialDiscount` exists to avoid.
//
// ── V1 LIMITS ──────────────────────────────────────────────────────────────
//
// - ONE-TIME lines only. A monthly fee and a hardware price are different units
//   (see quoteTotals), and nothing in a kit is recurring.
// - A kit APPLIES only when an ORDERING DEVICE (a POS, tableside device, or
//   the partial-ordering kit's order tablet) was placed, or a kiosk is on the
//   quote (`QuotePackage.appliesWith`). A WiFi package and
//   a drawer on their own are not a system, so without this a quote of just a
//   printer and the WiFi package would get the network for free.

import type { QuoteLine, QuoteType } from "@/types/merchant";

// ── The sheet ───────────────────────────────────────────────────────────────

/**
 * The items on the Hardware Master Pricing sheet that the kit can hold.
 * A key names a physical thing, not a HubSpot product — one product can be
 * several of these (see PRODUCT_PARTS).
 */
export type SheetKey =
  | "pos" | "cfd" | "terminal"
  | "kiosk27" | "kiosk156" | "mega" | "tableside" | "tablet"
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
  /** A device that takes orders. Placing one is what makes a kit apply. */
  orders?: true;
};

export const SHEET_ITEMS: Record<SheetKey, SheetItem> = {
  // list $949 / HubSpot $949 — suggested MSRP is only $855, finalized $900
  pos:       { label: "POS",                                  msrp: 949, orders: true },
  // "POS Secondary" in the sheet; finalized $299 (suggested $267, list $170)
  cfd:       { label: "Customer Facing Display",              msrp: 299 },
  // Zia tab $350 (main tab: finalized $300, suggested $299, list $250)
  terminal:  { label: "Payment Terminal (AMS1)",              msrp: 350 },
  // list / HubSpot / finalized $999 (suggested $975, Zia tab $888.75)
  kiosk27:   { label: "Kiosk 27\"",                           msrp: 999, orders: true },
  // list / HubSpot / finalized $799 (Zia tab $720; no suggested MSRP)
  kiosk156:  { label: "Kiosk 15.6\"",                         msrp: 799, orders: true },
  // suggested MSRP $2,700 (list and HubSpot $2,459)
  mega:      { label: "Mega Kiosk",                           msrp: 2700, orders: true },
  // suggested MSRP $603 (finalized $399, list $330)
  tableside: { label: "AIO Tableside POS",                    msrp: 603, orders: true },
  // HubSpot $199. Not on the sheet. It is the partial-ordering plan's order
  // tablet — the scenario sheet's "Samsung tablet" — and the device that
  // makes that kit a system, so it counts as ordering here.
  tablet:    { label: "Orders Hub Tablet",                    msrp: 199, orders: true },
  // suggested MSRP and Zia tab $735 (list $399, finalized $499)
  kds:       { label: "KDS",                                  msrp: 735 },
  // suggested MSRP and Zia tab $336 (list $199, finalized $249)
  printer:   { label: "Thermal Printer",                      msrp: 336 },
  // Zia tab $75 only — the main tab carries no suggested MSRP (list $70)
  drawer:    { label: "Cash Drawer",                          msrp: 75 },
  // suggested MSRP $108 (finalized $99, list $70)
  menuboard: { label: "Menu Board Computer",                  msrp: 108 },
  // list / HubSpot / finalized $999 (suggested $527, Zia tab $549)
  wifi:      { label: "AIO WiFi Network Package",             msrp: 999 },
};

/**
 * What each HubSpot product is made of, in sheet items. A product that is not
 * here is never covered by the kit — it is added to the quote at its price.
 * Add the row when someone adds the sheet value.
 *
 * Keyed by product id, like ORDER_POINT_RULES, so a rename in HubSpot can't
 * silently drop a product out of the kit.
 *
 * NOT MAPPED, on purpose: mPOS and the Clock-in tablet (no sheet row), the
 * Epson Sticky Printer (a label printer — not the sheet's printer), and the
 * Marketing Kit kiosks (displays, not part of any kit).
 */
export const PRODUCT_PARTS: Record<string, SheetKey[]> = {
  "217445755632": ["pos"],                // POS Unit
  "223452690130": ["pos", "cfd"],         // POS Unit - With Customer Facing Display
  "318736467644": ["cfd"],                // Customer Facing Display
  "223511653105": ["terminal"],           // Payment Terminal - AMS1
  // The kiosk SKUs carry an AMS1 inside them, but as ONE part since
  // 2026-10-27: with its terminal as a separate part the kit had to hold a
  // terminal seat for it — which a loose AMS1 took for free whenever no kiosk
  // was added. (No kit holds a kiosk since 2026-10-29; the parts still say
  // what makes a kit apply, see `QuotePackage.appliesWith`.)
  "222497165009": ["kiosk27"],            // Kiosk 27" + Payment Terminal (AMS1) and Mount
  "223519571666": ["kiosk156"],           // Kiosk Mini 15.6" + Payment Terminal (AMS1) and Mount
  "260674226888": ["mega"],               // Mega Kiosk
  "335279520447": ["tableside"],          // AIO Tableside POS
  "223452690132": ["kds"],                // KDS (Kitchen Display System)
  "223511653104": ["printer"],            // Thermal Printer
  "222497165011": ["drawer"],             // Cash Drawer
  "223511653103": ["menuboard"],          // Menu Board Computer
  "276751313619": ["tablet"],             // Orders Hub Tablet
  // AIO retired "AIO WiFi Network Package" (281351401209) 2026-10-13 and
  // replaced it with the Unifi variant, a rep pick since 2026-10-21 — see
  // WIFI_PRODUCT_ID / RETIRED_WIFI_PRODUCTS there. The sheet slot and its MSRP
  // are unchanged; only the id a cart line must carry to fill it moves.
  "338690209525": ["wifi"],               // AIO Wifi Network Package - Unifi
};

/** The MSRP of a whole HubSpot product — the sum of what it is made of — or null if unmapped. */
export function sheetMsrpOf(hubspotProductId: string): number | null {
  const parts = PRODUCT_PARTS[hubspotProductId];
  return parts ? parts.reduce((sum, k) => sum + SHEET_ITEMS[k].msrp, 0) : null;
}

/** One physical part of a cart line. */
type Part = { key: SheetKey; msrp: number; orders: boolean };

function partsOf(line: QuoteLine): Part[] | null {
  const keys = PRODUCT_PARTS[line.hubspotProductId];
  if (!keys) return null;
  return keys.map(k => ({ key: k, msrp: SHEET_ITEMS[k].msrp, orders: !!SHEET_ITEMS[k].orders }));
}

// ── The kit ─────────────────────────────────────────────────────────────────

export type PackageSlot = {
  item: SheetKey;
  qty: number;
  /** Other items that fill this slot as well as `item` does — "a KDS or a printer". */
  or?: SheetKey[];
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
  /**
   * Ordering devices the kit goes WITH without holding a slot for them: one on
   * the quote makes the FIRST instance a system exactly as a placed POS does.
   * The kiosks, since 2026-10-29 — the first one is a discounted line of its
   * own now, not a kit slot, and without this a kiosk-only quote would lose
   * the KDS, printer and the rest of the kit along with the kiosk's slot.
   */
  appliesWith?: SheetKey[];
  /** How many of this kit one quote may carry. */
  maxPerQuote?: number;
};

/**
 * Code, not a DB table, for the same reason ORDER_POINT_RULES is: this decides
 * what a merchant is charged, it changes rarely, and a mis-typed slot would
 * silently change what every open quote decomposes to.
 *
 * Contents are the QSR kit as Shaheer specified it 2026-10-08: printer, POS,
 * kiosk, KDS, cash drawer, menu board, WiFi package and the POS's AMS1, plus
 * the POS's customer facing display, which the sheet's POS assembly carries.
 * The kiosk LEFT the kit 2026-10-29: the first one is free as a discount on
 * its own line (`applyFirstKioskComp`), and the kit only goes with it
 * (`appliesWith`). It goes on Order & Pay and All-in-One alike.
 *
 * The Partial Ordering Kit is the scenario sheet's "$299 flat tier" hardware
 * (2026-10-27): the order tablet and a KDS or a printer, beside the same free
 * first kiosk.
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
      // The decomposition itself does not depend on this order: each item
      // fits exactly one slot here.
      { item: "pos", qty: 1 },
      { item: "cfd", qty: 1 },
      { item: "drawer", qty: 1 },
      { item: "terminal", qty: 1 },
      { item: "kds", qty: 1 },
      { item: "printer", qty: 1 },
      { item: "menuboard", qty: 1 },
      { item: "wifi", qty: 1 },
    ],
    appliesWith: ["kiosk27", "kiosk156"],
  },
  {
    id: "partial_ordering_kit",
    name: "Partial Ordering Kit",
    active: true,
    plans: ["marketing_partial"],
    maxPerQuote: 1,
    slots: [
      { item: "tablet", qty: 1 },
      { item: "kds", qty: 1, or: ["printer"] },
    ],
    appliesWith: ["kiosk27", "kiosk156"],
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
 * `terminal` is ABSENT on purpose. The kit's terminal is the POS's AMS1, which
 * the configurator adds alongside every POS it picks, kit or not
 * (`minimumTerminalsFor`). Naming it here would add it twice.
 *
 * A slot's `or` alternative is listed with the kit but not preselected (the
 * printer the partial kit takes instead of a KDS), so the rep sees both where
 * the kit is.
 * `wifi` is HERE since 2026-10-21, when the WiFi package stopped being a
 * derived always-included line and became a pick like the KDS (product owner:
 * "Just add the network package as a regular item in the hardware picker just
 * like a KDS or something"). A rep who doesn't want it un-picks it. The test file
 * asserts the preselect really does fill every slot, so changing the kit
 * without changing this fails loudly.
 */
export const KIT_DEFAULT_PRODUCTS: Partial<Record<SheetKey, string>> = {
  pos: "217445755632",       // POS Unit
  tablet: "276751313619",    // Orders Hub Tablet
  cfd: "318736467644",       // Customer Facing Display
  kds: "223452690132",       // KDS (Kitchen Display System)
  printer: "223511653104",   // Thermal Printer
  drawer: "222497165011",    // Cash Drawer
  menuboard: "223511653103", // Menu Board Computer
  wifi: "338690209525",      // AIO Wifi Network Package - Unifi
};

/** The active kit that comes with this plan, if any. */
export function kitFor(quoteType: QuoteType): QuotePackage | null {
  return PACKAGES.find(p => p.active && p.plans.includes(quoteType)) ?? null;
}

/** What to preselect so the quote opens with the kit on it — every slot's own item. */
export function kitPicks(kit: QuotePackage): Array<{ hubspotProductId: string; qty: number }> {
  const qtyById = new Map<string, number>();
  for (const slot of kit.slots) {
    const id = KIT_DEFAULT_PRODUCTS[slot.item];
    if (id) qtyById.set(id, (qtyById.get(id) ?? 0) + slot.qty);
  }
  return [...qtyById].map(([hubspotProductId, qty]) => ({ hubspotProductId, qty }));
}

/** Every product the kit lists, in slot order: `or` alternatives included. */
export function kitProductIds(kit: QuotePackage): string[] {
  const ids: string[] = [];
  for (const slot of kit.slots) {
    for (const item of [slot.item, ...(slot.or ?? [])]) {
      const id = KIT_DEFAULT_PRODUCTS[item];
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// ── Decomposition ───────────────────────────────────────────────────────────

export type AppliedPackage = {
  packageId: string;
  name: string;
  count: number;
  /** What the kit itself costs the merchant. Always 0 — it is free; kept so the panel can show it. */
  price: number;
};

/** One unit of one line landing in one slot. */
export type FilledSlot = {
  hubspotProductId: string;
  part: SheetKey;
  slot: SheetKey;
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
  /** Listed price of everything the kits absorbed. */
  coveredListAmount: number;
  /** What the kits are worth to the merchant. The kit is free, so this IS `coveredListAmount`. */
  savings: number;
};

function none(lines: QuoteLine[]): PackageDecomposition {
  return { lines, applied: [], filled: [], coveredListAmount: 0, savings: 0 };
}

/** A coverable line and how much of it is still unclaimed. */
type PoolEntry = { line: QuoteLine; parts: Part[]; left: number; msrp: number };

type Slot = { accepts: SheetKey[]; item: SheetKey; owner: number };

// A kit can't be applied more times than this, whatever a package says. A
// guard against a data-entry mistake, not a business rule.
const MAX_PACKAGE_INSTANCES = 10;

/**
 * Where one unit of this entry would go: the slot index per part, or null if
 * ANY part has nowhere to go — a unit is covered whole or not at all.
 */
function placeUnit(entry: PoolEntry, slots: Slot[]): Array<{ part: Part; slot: number }> | null {
  const used = new Set<number>();
  const placed: Array<{ part: Part; slot: number }> = [];
  for (const part of entry.parts) {
    const pick = slots.findIndex((s, i) =>
      s.owner < 0 && !used.has(i) && s.accepts.includes(part.key)
    );
    if (pick < 0) return null;
    used.add(pick);
    placed.push({ part, slot: pick });
  }
  return placed;
}

/**
 * Cover what the kits cover, out of the cart.
 *
 * Per kit instance, every unit that fits: single-part lines before composite
 * ones, so a POS-with-display never takes the seats a loose POS and display
 * would each have filled (the merchant would pay for both of those instead);
 * then DEAREST first, so where a slot takes either of two items (a KDS or a
 * printer) the merchant gets the dearer one free. An instance that places no
 * ordering device is thrown away and no further instances are tried.
 *
 * A device the kit `appliesWith` (a kiosk) fills no slot but still COUNTS as
 * the ordering device that makes the first instance a system — whether the
 * merchant gets it free or pays for it. Without that, a kiosk-only quote
 * would put the KDS, printer and the rest back on at full price.
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

  // Fewest parts, then dearest; a stable sort keeps input order among equals.
  const order = pool.map((_, e) => e).sort(
    (a, b) => pool[a].parts.length - pool[b].parts.length || pool[b].msrp - pool[a].msrp
  );
  const taken = pool.map(() => 0);
  const by = pool.map(() => new Set<string>());
  const filled: FilledSlot[] = [];
  const applied: AppliedPackage[] = [];

  for (const pkg of active) {
    const cap = Math.min(pkg.maxPerQuote ?? MAX_PACKAGE_INSTANCES, MAX_PACKAGE_INSTANCES);
    let count = 0;
    // An ordering device THIS kit goes with without holding a slot for it.
    const withDevice = pool.some(e =>
      e.parts.some(part => part.orders && (pkg.appliesWith ?? []).includes(part.key))
    );

    for (let n = 0; n < cap; n++) {
      const slots: Slot[] = pkg.slots.flatMap(s =>
        Array.from({ length: s.qty }, () => ({
          accepts: [s.item, ...(s.or ?? [])], item: s.item, owner: -1,
        }))
      );
      const left = pool.map(e => e.left);
      const placedUnits = pool.map(() => 0);
      const placements: FilledSlot[] = [];
      let placedOrderingDevice = false;

      for (const e of order) {
        while (left[e] > 0) {
          const placed = placeUnit(pool[e], slots);
          if (!placed) break;
          for (const { part, slot } of placed) {
            slots[slot].owner = e;
            if (part.orders) placedOrderingDevice = true;
            placements.push({ hubspotProductId: pool[e].line.hubspotProductId, part: part.key, slot: slots[slot].item });
          }
          left[e] -= 1;
          placedUnits[e] += 1;
        }
      }

      // No ordering device placed means no system here, whatever else fit —
      // unless the first instance goes with one that holds no slot (a kiosk).
      const deviceSystem = count === 0 && withDevice && placements.length > 0;
      if (!placedOrderingDevice && !deviceSystem) break;

      pool.forEach((entry, e) => {
        if (!placedUnits[e]) return;
        entry.left -= placedUnits[e];
        taken[e] += placedUnits[e];
        by[e].add(pkg.name);
      });
      filled.push(...placements);
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

  return { lines: out, applied, filled, coveredListAmount, savings: coveredListAmount };
}
