import { describe, it, expect, afterEach } from "vitest";
import {
  PACKAGES,
  decomposePackages,
  isPackageProduct,
  type QuotePackage,
} from "@/lib/quotePackages";
import {
  adjustmentBlockers,
  adjustmentsFromQuoteLines,
  buildQuote,
  isPickable,
  orderPointsPerUnit,
  picksFromQuoteLines,
  toQuoteLine,
} from "@/lib/quoting";
import type { CatalogProduct, QuoteLine } from "@/types/merchant";

// Live HubSpot ids and prices, so a fixture that stops matching the portal is
// a fixture someone has to look at.
const ID = {
  posCfd:   "223452690130", // POS Unit - With Customer Facing Display, $899, 1 point
  pos:      "217445755632", // POS Unit, $749, 1 point
  mega:     "260674226888", // Mega Kiosk, $2,459, 1 point
  kds:      "223452690132", // KDS, $499, 0 points
  printer:  "223511653104", // Thermal Printer, $249, 0 points
  wifi:     "281351401209", // AIO WiFi Network Package, $999, 0 points
  install:  "223452690133", // Onsite Installation, $999 — comped
  training: "223152695032", // System Onboarding and Training, $499 — comped
  platform: "335283119838", // All-in-One Platform, $399/mo
  review:   "335280960199", // Additional Software License, $19/mo
  // Not a real product: the fixture package SKU.
  kit:      "900000000001",
};

const p = (
  hubspotProductId: string, name: string, price: number,
  billingFrequency: CatalogProduct["billingFrequency"], productType: string,
): CatalogProduct => ({ hubspotProductId, name, price, billingFrequency, productType });

const CATALOG: CatalogProduct[] = [
  p(ID.posCfd,   "POS Unit - With Customer Facing Display", 899, "one_time", "inventory"),
  p(ID.pos,      "POS Unit", 749, "one_time", "inventory"),
  p(ID.mega,     "Mega Kiosk", 2459, "one_time", "inventory"),
  p(ID.kds,      "KDS (Kitchen Display System)", 499, "one_time", "inventory"),
  p(ID.printer,  "Thermal Printer", 249, "one_time", "inventory"),
  p(ID.wifi,     "AIO WiFi Network Package", 999, "one_time", "inventory"),
  p(ID.install,  "Onsite Installation", 999, "one_time", "Service"),
  p(ID.training, "System Onboarding and Training", 499, "one_time", "Service"),
  p(ID.platform, "All-in-One Platform", 399, "monthly", ""),
  p(ID.review,   "Additional Software License", 19, "monthly", "Software"),
  p(ID.kit,      "Test Kit", 1500, "one_time", "inventory"),
];

const product = (id: string) => CATALOG.find(c => c.hubspotProductId === id)!;
const line = (id: string, qty: number): QuoteLine => toQuoteLine(product(id), qty);

const pkg = (over: Partial<QuotePackage> = {}): QuotePackage => ({
  id: "test_kit",
  name: "Test Kit",
  hubspotProductId: ID.kit,
  active: true,
  slots: [{ kind: "order_point", qty: 2 }],
  ...over,
});

const run = (lines: QuoteLine[], packages: QuotePackage[], catalog = CATALOG) =>
  decomposePackages({ lines, catalog, orderPointsPerUnit, packages });

describe("decomposePackages", () => {
  it("leaves the cart alone when no package is active", () => {
    const lines = [line(ID.posCfd, 2), line(ID.kds, 1)];
    const out = run(lines, [pkg({ active: false })]);
    expect(out.applied).toEqual([]);
    expect(out.packageLines).toEqual([]);
    expect(out.lines).toBe(lines);
  });

  it("absorbs a matching cart into one package line plus 100%-off components", () => {
    const out = run([line(ID.posCfd, 1), line(ID.mega, 1), line(ID.kds, 1)], [
      pkg({ slots: [{ kind: "order_point", qty: 2 }, { kind: "product", hubspotProductId: ID.kds, name: "KDS", qty: 1 }] }),
    ]);

    expect(out.applied).toEqual([{ packageId: "test_kit", name: "Test Kit", count: 1, price: 1500 }]);
    expect(out.packageLines).toHaveLength(1);
    expect(out.packageLines[0]).toMatchObject({ hubspotProductId: ID.kit, qty: 1, unitPrice: 1500 });

    for (const l of out.lines) {
      expect(l.discountPercent).toBe(100);
      expect(l.coveredByPackage).toBe("Test Kit");
    }
    expect(out.coveredListAmount).toBe(899 + 2459 + 499);
    expect(out.savings).toBe(899 + 2459 + 499 - 1500);
  });

  it("treats ordering points as interchangeable — any mix of the same count is the same package", () => {
    const slots: QuotePackage["slots"] = [{ kind: "order_point", qty: 3 }];
    const twoPosOneKiosk = run([line(ID.posCfd, 2), line(ID.mega, 1)], [pkg({ slots })]);
    const onePosTwoKiosks = run([line(ID.posCfd, 1), line(ID.mega, 2)], [pkg({ slots })]);

    expect(twoPosOneKiosk.applied[0].count).toBe(1);
    expect(onePosTwoKiosks.applied[0].count).toBe(1);
    expect(twoPosOneKiosk.lines.every(l => l.coveredByPackage === "Test Kit")).toBe(true);
    expect(onePosTwoKiosks.lines.every(l => l.coveredByPackage === "Test Kit")).toBe(true);
  });

  it("fills ordering-point slots with the dearest eligible unit, so the remainder is cheapest", () => {
    // 3 points on the cart, a 2-point package: the Mega Kiosk and one POS go
    // in, the second POS is what the merchant still pays for.
    const out = run([line(ID.posCfd, 2), line(ID.mega, 1)], [pkg()]);

    const covered = out.lines.filter(l => l.coveredByPackage);
    const remainder = out.lines.filter(l => !l.coveredByPackage);
    expect(covered.map(l => [l.hubspotProductId, l.qty])).toEqual([[ID.posCfd, 1], [ID.mega, 1]]);
    expect(remainder.map(l => [l.hubspotProductId, l.qty])).toEqual([[ID.posCfd, 1]]);
    expect(out.coveredListAmount).toBe(899 + 2459);
  });

  it("splits a partly-covered line rather than blending the discount", () => {
    const out = run([line(ID.posCfd, 3)], [pkg()]);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ qty: 2, discountPercent: 100, coveredByPackage: "Test Kit" });
    expect(out.lines[1]).toMatchObject({ qty: 1 });
    expect(out.lines[1].discountPercent).toBeUndefined();
    expect(out.lines[1].coveredByPackage).toBeUndefined();
  });

  it("never covers a recurring line", () => {
    const out = run([line(ID.review, 2), line(ID.posCfd, 2)], [
      pkg({ slots: [{ kind: "order_point", qty: 2 }, { kind: "product", hubspotProductId: ID.review, name: "Review Manager", qty: 1 }] }),
    ]);
    // The review-manager slot can never be filled, so the package can't apply.
    expect(out.applied).toEqual([]);
    expect(out.blockers).toEqual([]);
  });

  it("picks the cheapest combination, not the biggest single saving", () => {
    // Greedy-by-saving takes the 3-point package first (saves $1,197) and
    // strands the fourth point; two 2-point packages are $399 cheaper.
    const big = pkg({ id: "big", name: "Big Kit", hubspotProductId: "900000000002", slots: [{ kind: "order_point", qty: 3 }] });
    const small = pkg({ id: "small", name: "Small Kit", hubspotProductId: "900000000003", slots: [{ kind: "order_point", qty: 2 }] });
    const catalog = [
      ...CATALOG,
      p("900000000002", "Big Kit", 1500, "one_time", "inventory"),
      p("900000000003", "Small Kit", 1000, "one_time", "inventory"),
    ];

    const out = decomposePackages({ lines: [line(ID.posCfd, 4)], catalog, orderPointsPerUnit, packages: [big, small] });
    expect(out.applied).toEqual([{ packageId: "small", name: "Small Kit", count: 2, price: 2000 }]);
    expect(out.lines.every(l => l.coveredByPackage === "Small Kit")).toBe(true);
  });

  it("honours maxPerQuote", () => {
    const out = run([line(ID.posCfd, 4)], [pkg({ maxPerQuote: 1 })]);
    expect(out.applied[0].count).toBe(1);
    expect(out.lines.filter(l => !l.coveredByPackage)).toHaveLength(1);
  });

  it("refuses a $0 package and says so, rather than giving its contents away", () => {
    const catalog = CATALOG.map(c => (c.hubspotProductId === ID.kit ? { ...c, price: 0 } : c));
    const out = run([line(ID.posCfd, 2)], [pkg()], catalog);

    expect(out.applied).toEqual([]);
    expect(out.lines.every(l => !l.coveredByPackage)).toBe(true);
    expect(out.blockers).toHaveLength(1);
    expect(out.blockers[0]).toContain("Test Kit");
    expect(out.blockers[0]).toContain("priced $0");
  });

  it("reports a package SKU missing from the catalog", () => {
    const out = run([line(ID.posCfd, 2)], [pkg()], CATALOG.filter(c => c.hubspotProductId !== ID.kit));
    expect(out.blockers[0]).toContain("isn't in the HubSpot catalog");
  });

  it("stays quiet about a broken package the cart wouldn't have used anyway", () => {
    const catalog = CATALOG.map(c => (c.hubspotProductId === ID.kit ? { ...c, price: 0 } : c));
    // One KDS, no ordering points — the package could never have applied.
    const out = run([line(ID.kds, 1)], [pkg()], catalog);
    expect(out.blockers).toEqual([]);
  });

  it("refuses a package SKU that bills recurring", () => {
    const catalog = CATALOG.map(c => (c.hubspotProductId === ID.kit ? { ...c, billingFrequency: "monthly" as const } : c));
    const out = run([line(ID.posCfd, 2)], [pkg()], catalog);
    expect(out.applied).toEqual([]);
    expect(out.blockers[0]).toContain("one-time charge");
  });
});

describe("the shipped PACKAGES table", () => {
  it("has unique ids and unique SKUs", () => {
    expect(new Set(PACKAGES.map(x => x.id)).size).toBe(PACKAGES.length);
    expect(new Set(PACKAGES.map(x => x.hubspotProductId)).size).toBe(PACKAGES.length);
  });

  it("never lists its own SKU as one of its slots", () => {
    for (const x of PACKAGES) {
      const slotIds = x.slots.flatMap(s => (s.kind === "product" ? [s.hubspotProductId] : []));
      expect(slotIds).not.toContain(x.hubspotProductId);
    }
  });

  it("has at least one slot per package — an empty one would apply to every cart", () => {
    for (const x of PACKAGES) expect(x.slots.length).toBeGreaterThan(0);
  });

  it("keeps package SKUs out of the rep's picker", () => {
    for (const x of PACKAGES) {
      expect(isPackageProduct(x.hubspotProductId)).toBe(true);
      expect(isPickable(p(x.hubspotProductId, x.name, 1500, "one_time", "inventory"))).toBe(false);
    }
  });
});

describe("buildQuote with a package on it", () => {
  const TEST_PACKAGE = pkg({
    slots: [
      { kind: "order_point", qty: 2 },
      { kind: "product", hubspotProductId: ID.wifi, name: "AIO WiFi Network Package", qty: 1 },
    ],
  });

  // PACKAGES is the shipped table and buildQuote reads it directly — the same
  // way COMPED_SERVICE_PRODUCT_IDS is read. Borrow it for the length of a test.
  const withPackage = () => {
    PACKAGES.push(TEST_PACKAGE);
    return () => { PACKAGES.splice(PACKAGES.indexOf(TEST_PACKAGE), 1); };
  };
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  const build = (picks: QuoteLine[], adjustments = {}) => {
    restore = withPackage();
    return buildQuote("all_in_one", picks, [], CATALOG, adjustments);
  };

  it("puts the package line on the quote and covers the WiFi package with it", () => {
    const built = build([line(ID.posCfd, 2)]);

    expect(built.packages.applied[0]).toMatchObject({ name: "Test Kit", count: 1 });
    expect(built.quoteLines.find(l => l.hubspotProductId === ID.kit)).toBeDefined();

    const wifi = built.quoteLines.find(l => l.hubspotProductId === ID.wifi)!;
    expect(wifi.coveredByPackage).toBe("Test Kit");
    expect(wifi.discountPercent).toBe(100);
    expect(built.blockers).toEqual([]);
  });

  it("does not refuse the quote over the 100% on a covered line", () => {
    const built = build([line(ID.posCfd, 2)]);
    expect(adjustmentBlockers(built.quoteLines, 50)).toEqual([]);
  });

  it("holds a covered line at 100% when the rep adjusts that product's other half", () => {
    // Three POS: two covered, one not. The rep delays billing on the product —
    // applyLineAdjustment clears discountPercent, and only applyPackageComp
    // puts the covered half back.
    const built = build([line(ID.posCfd, 3)], {
      [ID.posCfd]: { billingStart: { mode: "days" as const, days: 60 } },
    });

    const pos = built.quoteLines.filter(l => l.hubspotProductId === ID.posCfd);
    expect(pos).toHaveLength(2);
    expect(pos[0]).toMatchObject({ qty: 2, discountPercent: 100, coveredByPackage: "Test Kit" });
    expect(pos[1].discountPercent).toBeUndefined();
  });

  it("counts ordering points off the unsplit picks, so splitting can't move the platform tier", () => {
    const withPkg = build([line(ID.posCfd, 3)]);
    const withoutPkg = buildQuote("all_in_one", [line(ID.posCfd, 3)], [], CATALOG);
    expect(withPkg.orderPoints.total).toBe(3);
    expect(withPkg.orderPoints.total).toBe(withoutPkg.orderPoints.total);
    expect(withPkg.platform.productName).toBe(withoutPkg.platform.productName);
  });

  it("round-trips through the configurator: picks merge, the package SKU is dropped", () => {
    const built = build([line(ID.posCfd, 3), line(ID.kds, 1)]);
    const picks = picksFromQuoteLines(built.quoteLines, "all_in_one");

    expect(picks).toContainEqual({ hubspotProductId: ID.posCfd, qty: 3 });
    expect(picks).toContainEqual({ hubspotProductId: ID.kds, qty: 1 });
    expect(picks.find(x => x.hubspotProductId === ID.kit)).toBeUndefined();
    expect(picks.find(x => x.hubspotProductId === ID.wifi)).toBeUndefined();
  });

  it("does not read a package's 100% back as a rep adjustment", () => {
    const built = build([line(ID.posCfd, 2)]);
    const reopened = adjustmentsFromQuoteLines(built.quoteLines);
    expect(reopened[ID.posCfd]).toBeUndefined();
    expect(reopened[ID.wifi]).toBeUndefined();
    // The standing comps on install and training still come back.
    expect(reopened[ID.install]).toEqual({ discountPercent: 100 });
  });
});
