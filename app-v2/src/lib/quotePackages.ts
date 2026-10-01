// Pre-made hardware packages, and the cart → packages + remainder decomposition.
//
// Pure and dependency-free for the same reasons quoting.ts is: no DB, no
// HubSpot, no pricing.ts, nothing that is an AIO internal. quoting.ts owns the
// ordering-point rules and passes them in as `orderPointsPerUnit`, so the
// import only ever runs one way (quoting.ts → here) and there is no cycle.
//
// ── HOW A PACKAGE IS EXPRESSED ON THE QUOTE ────────────────────────────────
//
// One line for the package SKU at the package price, plus the hardware it
// covers still on the quote at MSRP, discounted 100%. Exactly the shape the
// comped install/training lines already use, and the shape Steve's AE price
// sheet tells merchants to expect: lines "will still appear on customer quotes
// at their listed MSRP, automatically discounted to $0".
//
// We deliberately did NOT duplicate the catalog into free/paid twins. A free
// twin carries a new HubSpot product id, and ORDER_POINT_RULES is keyed by
// product id — so every packaged POS and kiosk would have counted ZERO
// ordering points and silently selected the 1–5 platform tier instead of 6+.
// That is the largest recurring line on the quote. Keeping the real product on
// the quote and discounting it keeps the order-point count correct for free,
// keeps one catalog to maintain, and shows the merchant what the package was
// worth.
//
// ── V1 LIMIT: PACKAGES CONTAIN ONE-TIME LINES ONLY ─────────────────────────
//
// The decomposition picks the cheapest combination of packages, which needs a
// single scalar to compare. One-time dollars and a weekly fee are different
// units and must never be added (see quoteTotals), so rather than invent a
// normalisation constant, only `one_time` lines are coverable and a package
// SKU must itself be one-time. Every ordering-point product in AIO's catalog
// is one-time hardware, so this costs nothing today. Putting recurring
// software in a package is a deliberate change, and this comment is where to
// start it.

import type { CatalogProduct, QuoteLine } from "@/types/merchant";

// ── Slot eligibility ────────────────────────────────────────────────────────
//
// ⚠️ INTERCHANGEABLE-ORDERING-POINT POLICY — THE THING TO CHANGE LATER ⚠️
//
// An `order_point` slot today accepts ANY product worth exactly one ordering
// point, at any price and with no cap. That is a deliberate decision (Shaheer,
// 2026-09-29) and it is expected to change: the likely successor is an
// explicit list of eligible product ids per slot, so a slot can take a POS
// Unit or a Kiosk Mini but not a $2,459 Mega Kiosk.
//
// WHY IT MATTERS: the decomposition fills slots with the MOST EXPENSIVE
// eligible item first, because that is what minimises the remainder the
// merchant pays for. With no cap, a merchant who swaps their $749 POS Unit for
// a $2,459 Mega Kiosk pays the same package price and AIO absorbs the $1,710.
//
// WHEN THAT CHANGES, the whole change is here and in `slotAccepts` below:
//   - add `eligibleProductIds?: string[]` to the order_point slot variant
//   - have `slotAccepts` intersect it with the one-point rule
//   - fill in the ids per package in PACKAGES
// `decomposePackages` needs no edit — it asks `slotAccepts`, never the rules.
//
// The middle option that was also on the table, if a hard list proves too
// rigid: give the slot a dollar ALLOWANCE (covers up to $X of MSRP, the excess
// bills as a remainder line). That needs a partial-coverage line shape, which
// the 100%-discount expression above does not have, so it is the bigger change
// of the two.

export type PackageSlot =
  /**
   * N ordering points, filled by any product worth exactly one point. This is
   * what makes 2 POS + 1 kiosk and 1 POS + 2 kiosks the same package.
   *
   * "exactly one" rather than "at least one" on purpose: every ordering-point
   * product in the catalog is worth 1, and a hypothetical 2-point device
   * filling a 1-point slot would over-deliver the package silently. Such a
   * product stays a remainder line until someone decides what it should do.
   */
  | { kind: "order_point"; qty: number }
  /** A specific product, N of them. The `name` is for readability only. */
  | { kind: "product"; hubspotProductId: string; name: string; qty: number };

export type QuotePackage = {
  /** Stable internal id. Never shown; `name` is what a merchant reads. */
  id: string;
  /** Must match the HubSpot product's name closely enough for a rep to reconcile them. */
  name: string;
  /** The package SKU in HubSpot — a real product, priced at the package price. */
  hubspotProductId: string;
  /**
   * Off means the package never applies and is never mentioned. The flag
   * exists so a package can be defined here before it is priced in HubSpot.
   */
  active: boolean;
  slots: PackageSlot[];
  /** Hard ceiling on how many of this package one quote may carry. */
  maxPerQuote?: number;
};

/**
 * The pre-made packages, keyed by their live HubSpot product ids.
 *
 * Code, not a DB table, for the same reason ORDER_POINT_RULES is: this decides
 * what a merchant is charged, it changes rarely, and a mis-typed slot would
 * silently change what every open quote decomposes to. A change here is a
 * one-line edit and a deploy, reviewed like any other pricing change.
 */
export const PACKAGES: QuotePackage[] = [
  {
    // HubSpot product 333450361558, created 2026-09-18. Its description reads:
    //   1 x POS with CFD / 1 x 27" Kiosk / 1 x Kitchen Display System
    //   1 x Printer / 2 x AMS1 / 1 x Wifi Package
    // The POS and the kiosk are the two interchangeable ordering points; the
    // rest are fixed.
    //
    // INACTIVE, and it must stay that way until someone prices it: the HubSpot
    // record is $0 today, so applying it would hand the merchant roughly $4,000
    // of hardware for nothing. `resolvePackages` refuses a $0 package anyway —
    // this flag is so the refusal never has to fire on a live quote.
    id: "qsr_kit",
    name: "QSR Kit",
    hubspotProductId: "333450361558",
    active: false,
    slots: [
      { kind: "order_point", qty: 2 },
      { kind: "product", hubspotProductId: "223452690132", name: "KDS (Kitchen Display System)", qty: 1 },
      { kind: "product", hubspotProductId: "223511653104", name: "Thermal Printer", qty: 1 },
      { kind: "product", hubspotProductId: "223511653105", name: "Payment Terminal - AMS1", qty: 2 },
      { kind: "product", hubspotProductId: "281351401209", name: "AIO WiFi Network Package", qty: 1 },
    ],
  },
];

/**
 * True for a package SKU. Used to keep packages out of the rep's product
 * picker and out of the picks a saved quote is reopened as.
 *
 * Reads the array live rather than a Set built at module load, so it can never
 * disagree with PACKAGES. Same shape as `isCompedService` reading
 * COMPED_SERVICE_PRODUCT_IDS, and with a handful of packages the scan is free.
 */
export function isPackageProduct(hubspotProductId: string): boolean {
  return PACKAGES.some(p => p.hubspotProductId === hubspotProductId);
}

// ── Decomposition ───────────────────────────────────────────────────────────

/** Whether one unit of this line can fill this slot. The whole eligibility policy. */
function slotAccepts(slot: PackageSlot, line: QuoteLine, points: number): boolean {
  return slot.kind === "product"
    ? slot.hubspotProductId === line.hubspotProductId
    : points === 1;
}

export type AppliedPackage = {
  packageId: string;
  name: string;
  count: number;
  /** Package price × count — what the merchant pays for them. */
  price: number;
};

export type PackageDecomposition = {
  /** Package SKU lines, in PACKAGES order. Empty when nothing applied. */
  packageLines: QuoteLine[];
  /**
   * The input lines, rewritten. A line whose quantity was partly absorbed is
   * SPLIT: the covered part at 100% off carrying `coveredByPackage`, the rest
   * at MSRP. Input order is preserved, covered part first.
   */
  lines: QuoteLine[];
  applied: AppliedPackage[];
  /** MSRP of everything the packages absorbed. */
  coveredListAmount: number;
  /**
   * What the packages are worth to the merchant: absorbed MSRP less what the
   * packages themselves cost. Reported for the whole quote rather than per
   * package, because with two packages on one cart there is no non-arbitrary
   * way to say which one absorbed a given POS.
   */
  savings: number;
  /**
   * Reasons a package that this cart QUALIFIES FOR could not be applied —
   * always a catalog problem someone has to fix, never a rep's doing. Surfaced
   * rather than swallowed: silently quoting à la carte charges the merchant
   * more than the package they were promised.
   */
  blockers: string[];
};

function none(lines: QuoteLine[], blockers: string[] = []): PackageDecomposition {
  return { packageLines: [], lines, applied: [], coveredListAmount: 0, savings: 0, blockers };
}

type Resolved = { pkg: QuotePackage; product: CatalogProduct };

/** One coverable line and how much of it is still unclaimed. */
type PoolEntry = { line: QuoteLine; left: number; points: number };

// Only ever used to probe whether a cart WOULD have qualified for a package
// whose real product is missing from the catalog. Its price is never read.
const PLACEHOLDER: CatalogProduct = {
  hubspotProductId: "", name: "", price: 0, billingFrequency: "one_time", productType: "inventory",
};

/**
 * Try to fill `counts[i]` instances of each resolved package out of the pool.
 * Returns what each pool entry gave up, or null if some slot can't be filled.
 *
 * Two global passes rather than package-by-package, so the result doesn't
 * depend on the order packages happen to sit in: specific product slots are
 * claimed first (only one kind of item can fill them), then the ordering-point
 * slots take the most expensive eligible units left. For a fixed `counts`
 * vector that is exactly the assignment leaving the cheapest remainder.
 */
function fill(
  counts: number[],
  resolved: Resolved[],
  pool: PoolEntry[]
): { taken: number[]; by: Array<Set<string>> } | null {
  const left = pool.map(e => e.left);
  const taken = pool.map(() => 0);
  const by: Array<Set<string>> = pool.map(() => new Set<string>());

  const claim = (index: number, qty: number, packageName: string) => {
    left[index] -= qty;
    taken[index] += qty;
    by[index].add(packageName);
  };

  // Pass 1 — specific products.
  for (let i = 0; i < resolved.length; i++) {
    if (!counts[i]) continue;
    const { pkg } = resolved[i];
    for (const slot of pkg.slots) {
      if (slot.kind !== "product") continue;
      let want = slot.qty * counts[i];
      for (let j = 0; j < pool.length && want > 0; j++) {
        if (left[j] <= 0 || !slotAccepts(slot, pool[j].line, pool[j].points)) continue;
        const take = Math.min(left[j], want);
        claim(j, take, pkg.name);
        want -= take;
      }
      if (want > 0) return null;
    }
  }

  // Pass 2 — ordering points, dearest first so the remainder is as cheap as it
  // can be. Every order_point slot has identical eligibility, so they are
  // pooled into one demand rather than filled slot by slot.
  let points = 0;
  const wantedBy: string[] = [];
  for (let i = 0; i < resolved.length; i++) {
    if (!counts[i]) continue;
    for (const slot of resolved[i].pkg.slots) {
      if (slot.kind !== "order_point") continue;
      points += slot.qty * counts[i];
      wantedBy.push(resolved[i].pkg.name);
    }
  }
  if (points > 0) {
    const eligible = pool
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry, index }) => left[index] > 0 && slotAccepts(ORDER_POINT_SLOT, entry.line, entry.points))
      .sort((a, b) => b.entry.line.unitPrice - a.entry.line.unitPrice || a.index - b.index);

    // With one package wanting points — the ordinary case — this is its name.
    // With two, nothing can say which POS went where, so both are named.
    const label = [...new Set(wantedBy)].join(" + ");
    for (const { index } of eligible) {
      if (points <= 0) break;
      const take = Math.min(left[index], points);
      claim(index, take, label);
      points -= take;
    }
    if (points > 0) return null;
  }

  return { taken, by };
}

const ORDER_POINT_SLOT: PackageSlot = { kind: "order_point", qty: 1 };

/** One-time dollars: package prices plus whatever the merchant still pays MSRP for. */
function costOf(counts: number[], resolved: Resolved[], pool: PoolEntry[], taken: number[]): number {
  let total = 0;
  for (let i = 0; i < resolved.length; i++) total += counts[i] * resolved[i].product.price;
  for (let j = 0; j < pool.length; j++) total += (pool[j].left - taken[j]) * pool[j].line.unitPrice;
  return Math.round(total * 100) / 100;
}

// A package can't be applied more times than the cart has room for, and the
// search is exhaustive, so this bounds it twice over. Realistic carts produce
// a handful of leaves; the caps are here so a data-entry mistake (a package
// with one cheap slot, a cart with 40 of it) can't hang the rep's browser.
const MAX_PACKAGE_INSTANCES = 10;
const MAX_SEARCH_LEAVES = 20_000;

/**
 * Break a cart into whole packages plus the remainder, choosing the cheapest
 * combination for the merchant.
 *
 * Exhaustive over package counts rather than greedy: greedy takes the package
 * with the best headline saving first and can strand the items a second,
 * better-value package needed. The search space is the product of each
 * package's feasible count, which for AIO's catalog is a few dozen leaves.
 */
export function decomposePackages({
  lines,
  catalog,
  orderPointsPerUnit,
  packages = PACKAGES,
}: {
  lines: QuoteLine[];
  catalog: CatalogProduct[];
  orderPointsPerUnit: (line: QuoteLine) => number;
  packages?: QuotePackage[];
}): PackageDecomposition {
  const active = packages.filter(p => p.active);
  if (active.length === 0 || lines.length === 0) return none(lines);

  // Only one-time lines are coverable — see the v1 limit at the top.
  const pool: PoolEntry[] = [];
  const poolIndexOfLine = new Map<number, number>();
  lines.forEach((line, i) => {
    if (line.billingFrequency !== "one_time" || line.qty <= 0) return;
    poolIndexOfLine.set(i, pool.length);
    pool.push({ line, left: line.qty, points: orderPointsPerUnit(line) });
  });
  if (pool.length === 0) return none(lines);

  // Resolve each package's SKU. A package the cart qualifies for but that we
  // can't price is a blocker, not a silent fallback to à la carte.
  const resolved: Resolved[] = [];
  const blockers: string[] = [];
  for (const pkg of active) {
    const product = catalog.find(p => p.hubspotProductId === pkg.hubspotProductId);
    const problem =
      !product
        ? "isn't in the HubSpot catalog (renamed, archived, or the catalog didn't load)"
        : product.price <= 0
          ? "is priced $0 in HubSpot, so applying it would give away everything in it for nothing"
          : product.billingFrequency !== "one_time"
            ? `bills ${product.billingFrequency} in HubSpot — a package SKU has to be a one-time charge`
            : null;

    if (!problem) {
      resolved.push({ pkg, product: product! });
      continue;
    }
    // Only worth saying if this cart would actually have used the package.
    if (fill([1], [{ pkg, product: product ?? PLACEHOLDER }], pool)) {
      blockers.push(
        `This quote qualifies for the "${pkg.name}" package, but that product ${problem}. ` +
        "Sending it would charge the merchant full price for hardware the package covers."
      );
    }
  }
  if (resolved.length === 0) return none(lines, blockers);

  // Upper bound per package: how many times each slot could conceivably be
  // filled. Loose (product and ordering-point slots compete for the same POS),
  // which is fine — `fill` rejects the branches that don't hold up.
  const totalPoints = pool.reduce((n, e) => n + (e.points === 1 ? e.left : 0), 0);
  const qtyOfProduct = new Map<string, number>();
  for (const e of pool) {
    qtyOfProduct.set(e.line.hubspotProductId, (qtyOfProduct.get(e.line.hubspotProductId) ?? 0) + e.left);
  }
  const maxCounts = resolved.map(({ pkg }) => {
    let max = pkg.maxPerQuote ?? MAX_PACKAGE_INSTANCES;
    for (const slot of pkg.slots) {
      const available = slot.kind === "product" ? (qtyOfProduct.get(slot.hubspotProductId) ?? 0) : totalPoints;
      max = Math.min(max, Math.floor(available / slot.qty));
    }
    return Math.max(0, Math.min(max, MAX_PACKAGE_INSTANCES));
  });

  type Best = { counts: number[]; taken: number[]; by: Array<Set<string>>; cost: number; applied: number };
  let best: Best | null = null;
  let leaves = 0;
  const counts = resolved.map(() => 0);

  const evaluate = () => {
    leaves++;
    const filled = fill(counts, resolved, pool);
    if (!filled) return;
    const cost = costOf(counts, resolved, pool, filled.taken);
    const applied = counts.reduce((n, c) => n + c, 0);
    // Cheapest wins. On a tie, the version with more packages on it — same
    // money, but a quote that reads as a package is the one AIO wants to send.
    if (!best || cost < best.cost || (cost === best.cost && applied > best.applied)) {
      best = { counts: [...counts], taken: filled.taken, by: filled.by, cost, applied };
    }
  };

  const walk = (i: number) => {
    if (leaves >= MAX_SEARCH_LEAVES) return;
    if (i === resolved.length) return evaluate();
    // Descending, so the package-heavy combinations are seen first and a cap
    // that does fire leaves a good answer rather than the empty one.
    for (let c = maxCounts[i]; c >= 0 && leaves < MAX_SEARCH_LEAVES; c--) {
      counts[i] = c;
      walk(i + 1);
    }
    counts[i] = 0;
  };
  walk(0);

  // The cast is TypeScript's closure-assignment blind spot, not a doubt about
  // the value: `best` is only ever written inside `evaluate`, so control-flow
  // analysis still believes it is `null` here.
  const chosen = best as Best | null;
  if (!chosen || chosen.applied === 0) return none(lines, blockers);

  const packageLines: QuoteLine[] = [];
  const applied: AppliedPackage[] = [];
  let packageCost = 0;
  for (let i = 0; i < resolved.length; i++) {
    const count = chosen.counts[i];
    if (!count) continue;
    const { pkg, product } = resolved[i];
    packageLines.push({
      hubspotProductId: product.hubspotProductId,
      name: product.name,
      qty: count,
      unitPrice: product.price,
      billingFrequency: product.billingFrequency,
      productType: product.productType,
    });
    const price = Math.round(product.price * count * 100) / 100;
    packageCost += price;
    applied.push({ packageId: pkg.id, name: pkg.name, count, price });
  }

  const out: QuoteLine[] = [];
  let coveredListAmount = 0;
  lines.forEach((line, i) => {
    const poolIndex = poolIndexOfLine.get(i);
    const took = poolIndex === undefined ? 0 : chosen.taken[poolIndex];
    if (!took || poolIndex === undefined) {
      out.push(line);
      return;
    }
    coveredListAmount += took * line.unitPrice;
    out.push({
      ...line,
      qty: took,
      discountPercent: 100,
      coveredByPackage: [...chosen.by[poolIndex]].join(" + "),
    });
    if (line.qty - took > 0) out.push({ ...line, qty: line.qty - took });
  });
  coveredListAmount = Math.round(coveredListAmount * 100) / 100;

  return {
    packageLines,
    lines: out,
    applied,
    coveredListAmount,
    savings: Math.round((coveredListAmount - packageCost) * 100) / 100,
    blockers,
  };
}
