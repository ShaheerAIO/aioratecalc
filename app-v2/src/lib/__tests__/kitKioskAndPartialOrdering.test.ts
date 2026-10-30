import { describe, it, expect, beforeAll } from "vitest";
import { PACKAGES } from "@/lib/quotePackages";
import {
  DEFAULT_QUOTE_LIMITS,
  MARKETING_ADDON_PRODUCT,
  adjustmentBlockers,
  adjustmentsFromQuoteLines,
  buildQuote,
  firstKioskProductId,
  includesMarketing,
  lineNetAmount,
  picksFromQuoteLines,
  toQuoteLine,
} from "@/lib/quoting";
import { lineHardwareCommission } from "@/lib/commission";
import type { CatalogProduct, QuoteAdjustments, QuoteLine, QuoteType } from "@/types/merchant";

// Two product-owner changes:
//  - 2026-10-29: the first kiosk is OUT of the kit — a regular line at list,
//    marked `QuoteLine.firstKiosk`, whose one unit the rep may discount up to
//    100% past the cap, earning a flat 45/5 commission floored at $0;
//  - 2026-10-28: Marketing Partial Ordering's Marketing chip puts the hidden $0
//    "Marketing (Partial Ordering)" line on the quote, which is still a real
//    line and still brings the three free menu boards;
//  - 2026-10-30: the chip is gone and the line is no longer optional —
//    `buildQuote` forces it onto every MPO quote, whatever the picks say.

beforeAll(() => { for (const pkg of PACKAGES) pkg.active = true; });

const p = (
  hubspotProductId: string, name: string, price: number,
  billingFrequency: CatalogProduct["billingFrequency"], productType = "inventory",
  extra: Partial<CatalogProduct> = {},
): CatalogProduct => ({ hubspotProductId, name, price, billingFrequency, productType, ...extra });

const KIOSK = "222497165009";
const KIOSK_156 = "223519571666";

const CATALOG: CatalogProduct[] = [
  p("335279520445", "All-in-One (Order & Pay only)", 299, "monthly", ""),
  p("335283119838", "All-in-One Platform", 399, "monthly", ""),
  p("343582047937", "AIO Marketing Partial Ordering", 299, "monthly", "Software"),
  p("343374665412", "Online Ordering", 0, "monthly", "Software"),
  p("343579168455", "Marketing (Partial Ordering)", 0, "monthly", ""),
  p("333275576048", "Website", 50, "monthly", "Software"),
  p("335280960199", "Additional Software License", 19, "monthly", "Software"),
  p("223511653103", "Menu Board Computer", 99, "one_time"),
  p("276751313619", "Orders Hub Tablet", 199, "one_time"),
  p("223452690132", "KDS (Kitchen Display System)", 735, "one_time"),
  p("223511653104", "Thermal Printer", 295, "one_time"),
  p(KIOSK, "Kiosk 27\" + Payment Terminal (AMS1) and Mount", 999, "one_time", "inventory",
    { costToRep: 600, repCommissionBps: 1000 }),
  p(KIOSK_156, "Kiosk Mini 15.6\" + Payment Terminal (AMS1) and Mount", 799, "one_time"),
  p("217445755632", "POS Unit", 749, "one_time"),
  p("318736467644", "Customer Facing Display", 299, "one_time", ""),
  p("223511653105", "Payment Terminal - AMS1", 350, "one_time"),
  p("222497165011", "Cash Drawer", 75, "one_time"),
  p("338690209525", "AIO Wifi Network Package - Unifi", 698, "one_time"),
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  p("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
  p("260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"),
];

const byName = (name: string) => CATALOG.find(c => c.name === name)!;
const lines = (picks: Array<[string, number]>) => picks.map(([name, qty]) => toQuoteLine(byName(name), qty));

const KIOSK_NAME = "Kiosk 27\" + Payment Terminal (AMS1) and Mount";
const KIOSK_156_NAME = "Kiosk Mini 15.6\" + Payment Terminal (AMS1) and Mount";
const QSR_KIT: Array<[string, number]> = [
  ["POS Unit", 1], ["Customer Facing Display", 1], ["Cash Drawer", 1], ["Payment Terminal - AMS1", 1],
  ["KDS (Kitchen Display System)", 1], ["Thermal Printer", 1], ["Menu Board Computer", 1],
  ["AIO Wifi Network Package - Unifi", 1],
];
// The kit as the configurator seeds it, plus a kiosk.
const QSR_WITH_KIOSK: Array<[string, number]> = [...QSR_KIT, [KIOSK_NAME, 1]];
const MPO_WITH_KIOSK: Array<[string, number]> = [
  ["Orders Hub Tablet", 1], ["KDS (Kitchen Display System)", 1], [KIOSK_NAME, 1],
];
const withKiosks = (picks: Array<[string, number]>, qty: number) =>
  [...picks.filter(([n]) => n !== KIOSK_NAME), [KIOSK_NAME, qty]] as Array<[string, number]>;

// The rep giving the first kiosk away: 100% on one unit.
const FREE: QuoteAdjustments = { [KIOSK]: { discountPercent: 100, discountQty: 1 } };

const build = (
  plan: QuoteType, picks: Array<[string, number]>, adjustments: QuoteAdjustments = {},
  discountCaps: Record<string, number> = {},
) => buildQuote(plan, lines(picks), [], CATALOG, adjustments, 50, { ...DEFAULT_QUOTE_LIMITS, discountCaps });

const kioskLines = (built: { quoteLines: QuoteLine[] }) =>
  built.quoteLines.filter(l => l.hubspotProductId === KIOSK);

/** Save → reopen → rebuild, the way the configurator does it. */
const reopen = (plan: QuoteType, saved: QuoteLine[]) =>
  buildQuote(
    plan,
    picksFromQuoteLines(saved, plan).map(pick =>
      toQuoteLine(CATALOG.find(c => c.hubspotProductId === pick.hubspotProductId)!, pick.qty)
    ),
    [], CATALOG, adjustmentsFromQuoteLines(saved)
  );

const PLANS: Array<[QuoteType, Array<[string, number]>]> = [
  ["all_in_one", QSR_WITH_KIOSK],
  ["order_pay_only", QSR_WITH_KIOSK],
  ["marketing_partial", MPO_WITH_KIOSK],
];

describe("the first kiosk: at list, out of the kit, discountable to 100% (2026-10-29)", () => {
  for (const [plan, picks] of PLANS) {
    it(`${plan}: one line at list, marked — no default discount, never covered by the kit`, () => {
      const built = build(plan, picks);
      expect(kioskLines(built)).toEqual([expect.objectContaining({ qty: 1, unitPrice: 999, firstKiosk: true })]);
      expect(kioskLines(built)[0].discountPercent).toBeUndefined();
      expect(kioskLines(built)[0].coveredByPackage).toBeUndefined();
      expect(lineNetAmount(kioskLines(built)[0])).toBe(999);
      expect(built.blockers).toEqual([]);
    });

    it(`${plan}: 100% on one of two kiosks splits, marks the free unit, and passes the cap`, () => {
      const built = build(plan, withKiosks(picks, 2), FREE);
      expect(kioskLines(built).map(l => [l.qty, l.discountPercent ?? 0, l.firstKiosk ?? false]))
        .toEqual([[1, 100, true], [1, 0, false]]);
      expect(built.blockers).toEqual([]);
    });
  }

  it("is not on a plan without a kit", () => {
    expect(firstKioskProductId("marketing_only", lines([[KIOSK_NAME, 1]]))).toBeNull();
    expect(firstKioskProductId("all_in_one", lines([[KIOSK_NAME, 1]]))).toBe(KIOSK);
  });

  it("is one unit across both sizes: the dearer one when the quote has both", () => {
    const both = build("all_in_one", [...QSR_KIT, [KIOSK_156_NAME, 1], [KIOSK_NAME, 1]]);
    expect(kioskLines(both)).toEqual([expect.objectContaining({ firstKiosk: true })]);
    const mini = both.quoteLines.filter(l => l.hubspotProductId === KIOSK_156);
    expect(mini).toHaveLength(1);
    expect(mini[0].firstKiosk).toBeUndefined();

    // A 15.6" alone is the first kiosk.
    const alone = build("all_in_one", [...QSR_KIT, [KIOSK_156_NAME, 1]]);
    expect(alone.quoteLines.find(l => l.hubspotProductId === KIOSK_156)).toMatchObject({ firstKiosk: true });
  });

  it("marks the discounted unit wherever 'adjust each unit' put it", () => {
    const built = build("all_in_one", withKiosks(QSR_WITH_KIOSK, 2), { [KIOSK]: { units: [{}, { discountPercent: 100 }] } });
    expect(kioskLines(built).map(l => [l.discountPercent ?? 0, l.firstKiosk ?? false])).toEqual([[0, false], [100, true]]);
    expect(built.blockers).toEqual([]);
  });

  it("free, it leaves the rest of the kit free and costs exactly the kiosk", () => {
    const charged = build("all_in_one", QSR_WITH_KIOSK);
    const free = build("all_in_one", QSR_WITH_KIOSK, FREE);
    expect(charged.totals.oneTime - free.totals.oneTime).toBe(999);
    for (const name of ["POS Unit", "KDS (Kitchen Display System)", "AIO Wifi Network Package - Unifi"]) {
      expect(charged.quoteLines.find(l => l.name === name)!.coveredByPackage, name).toBe("QSR Kit");
    }
  });

  it("its single unit is exempt from the cap at any figure, in either lever, at publish too", () => {
    for (const adjustment of [{ discountPercent: 100 }, { discountPercent: 30 }, { discountAmount: 999 }]) {
      const built = build("all_in_one", QSR_WITH_KIOSK, { [KIOSK]: adjustment }, { [KIOSK]: 20 });
      expect(built.blockers, JSON.stringify(adjustment)).toEqual([]);
      // The publish re-check, which only has the saved lines, agrees.
      expect(adjustmentBlockers(built.quoteLines, 50, undefined, { [KIOSK]: 20 })).toEqual([]);
    }
  });

  it("still refuses a dollar discount bigger than the line", () => {
    expect(build("all_in_one", QSR_WITH_KIOSK, { [KIOSK]: { discountAmount: 1500 } }).blockers)
      .toEqual([expect.stringMatching(/more than the line/)]);
  });

  it("caps a discount across SEVERAL kiosks as usual — only the first one is exempt", () => {
    const both = build("all_in_one", withKiosks(QSR_WITH_KIOSK, 2), { [KIOSK]: { discountPercent: 100 } });
    expect(both.blockers).toEqual([expect.stringMatching(/discounted 100%, over the 50% limit/)]);
    // And a second kiosk discounted on its own line is an ordinary line.
    const second = build("all_in_one", withKiosks(QSR_WITH_KIOSK, 2),
      { [KIOSK]: { units: [{ discountPercent: 100 }, { discountPercent: 60 }] } });
    expect(second.blockers).toEqual([expect.stringMatching(/discounted 60%, over the 50% limit/)]);
  });

  it("a kiosk-only QSR quote still gets the kit on the rest (the kiosk is still its ordering device)", () => {
    const picks: Array<[string, number]> = [[KIOSK_NAME, 1], ["KDS (Kitchen Display System)", 1]];
    for (const adjustments of [{}, FREE]) {
      const built = build("order_pay_only", picks, adjustments);
      expect(built.packages.applied.map(a => a.name)).toEqual(["QSR Kit"]);
      expect(built.quoteLines.find(l => l.name === "KDS (Kitchen Display System)")!.coveredByPackage).toBe("QSR Kit");
      expect(kioskLines(built)[0].coveredByPackage).toBeUndefined();
    }
  });
});

describe("first-kiosk commission: 45% rep / 5% RSM of margin, floored at $0 (2026-10-29)", () => {
  // Cost $600, list $999, the product's own rep rate 10%.
  it("pays the flat rate at list, ignoring the product's own", () => {
    const c = lineHardwareCommission(kioskLines(build("all_in_one", QSR_WITH_KIOSK))[0]);
    expect(c.status).toBe("computed");
    expect(c.rep).toBeCloseTo(399 * 0.45, 6);
    expect(c.rsm).toBeCloseTo(399 * 0.05, 6);
  });

  it("pays nothing at 100% off — computed, floored, never negative", () => {
    const c = lineHardwareCommission(kioskLines(build("all_in_one", QSR_WITH_KIOSK, FREE))[0]);
    expect(c).toMatchObject({ status: "computed", rep: 0, rsm: 0 });
  });

  it("with 1 of 2 at 100%: the free unit floors at 0, the second earns the product's own rate", () => {
    const [first, second] = kioskLines(build("all_in_one", withKiosks(QSR_WITH_KIOSK, 2), FREE));
    expect(first.firstKiosk).toBe(true);
    expect(lineHardwareCommission(first)).toMatchObject({ rep: 0, rsm: 0 });
    expect(lineHardwareCommission(second).rep).toBeCloseTo(399 * 0.10, 6);
  });

  it("splits a line of two kiosks at list: one at the flat rate, one at the product's", () => {
    const [line] = kioskLines(build("all_in_one", withKiosks(QSR_WITH_KIOSK, 2)));
    expect(line).toMatchObject({ qty: 2, firstKiosk: true });
    expect(lineHardwareCommission(line).rep).toBeCloseTo(399 * 0.45 + 399 * 0.10, 6);
  });
});

describe("the first kiosk survives saving and reopening", () => {
  const cases: Array<[string, QuoteType, Array<[string, number]>, QuoteAdjustments]> = [
    ["charged (list)", "all_in_one", QSR_WITH_KIOSK, {}],
    ["charged, two on one line", "order_pay_only", withKiosks(QSR_WITH_KIOSK, 2), {}],
    ["free", "all_in_one", QSR_WITH_KIOSK, { [KIOSK]: { discountPercent: 100 } }],
    ["free, one of two", "all_in_one", withKiosks(QSR_WITH_KIOSK, 2), FREE],
    ["free on Marketing Partial Ordering", "marketing_partial", MPO_WITH_KIOSK, { [KIOSK]: { discountPercent: 100 } }],
    ["at 30%", "all_in_one", QSR_WITH_KIOSK, { [KIOSK]: { discountPercent: 30 } }],
  ];
  for (const [name, plan, picks, adjustments] of cases) {
    it(`reproduces the same lines: ${name}`, () => {
      const saved = build(plan, picks, adjustments).quoteLines;
      expect(reopen(plan, saved).quoteLines).toEqual(saved);
    });
  }

  it("reads the rep's discount back like any line's, and nothing for a charged kiosk", () => {
    expect(adjustmentsFromQuoteLines(build("all_in_one", QSR_WITH_KIOSK).quoteLines)[KIOSK]).toBeUndefined();
    expect(adjustmentsFromQuoteLines(build("all_in_one", withKiosks(QSR_WITH_KIOSK, 2), FREE).quoteLines)[KIOSK])
      .toEqual({ discountPercent: 100, discountQty: 1 });
  });
});

describe("Marketing Partial Ordering's marketing line (2026-10-28)", () => {
  // What the three chips put on the quote: the kiosk, online ordering, and
  // the marketing line with the three menu boards it makes free.
  const ALL_CHIPS: Array<[string, number]> = [
    ["Orders Hub Tablet", 1], ["KDS (Kitchen Display System)", 1],
    [KIOSK_NAME, 1], ["Online Ordering", 1], ["Marketing (Partial Ordering)", 1], ["Menu Board Computer", 3],
  ];

  it("stays a real $0 line on the quote when chosen, and brings the three free menu boards", () => {
    const built = build("marketing_partial", ALL_CHIPS);
    const marketing = built.quoteLines.filter(l => l.hubspotProductId === MARKETING_ADDON_PRODUCT.hubspotProductId);
    expect(marketing).toHaveLength(1);
    expect(marketing[0]).toMatchObject({ qty: 1, unitPrice: 0, billingFrequency: "monthly" });
    expect(includesMarketing("marketing_partial", built.quoteLines)).toBe(true);
    const boards = built.quoteLines.filter(l => l.name === "Menu Board Computer");
    expect(boards).toEqual([expect.objectContaining({ qty: 3, coveredByPackage: "AIO Marketing Partial Ordering" })]);
    expect(built.blockers).toEqual([]);
  });

  it("reopens as a pick, so the Marketing chip lights again", () => {
    const saved = build("marketing_partial", ALL_CHIPS).quoteLines;
    const picks = picksFromQuoteLines(saved, "marketing_partial");
    expect(picks).toContainEqual({ hubspotProductId: MARKETING_ADDON_PRODUCT.hubspotProductId, qty: 1 });
  });

  // 2026-10-30, product owner: "remove marketing button from MPO (autoselect
  // it, cannot be changed)". `buildQuote` runs server-side against the
  // browser's picks, so this is where "cannot be changed" is enforced.
  const WITHOUT_MARKETING = ALL_CHIPS.filter(([n]) => n !== "Marketing (Partial Ordering)");
  const marketingLines = (built: { quoteLines: QuoteLine[] }) =>
    built.quoteLines.filter(l => l.hubspotProductId === MARKETING_ADDON_PRODUCT.hubspotProductId);

  it("is forced onto a pick list that leaves it off, and the boards stay free", () => {
    const built = build("marketing_partial", WITHOUT_MARKETING);
    expect(marketingLines(built)).toEqual([expect.objectContaining({ qty: 1, unitPrice: 0, billingFrequency: "monthly" })]);
    expect(includesMarketing("marketing_partial", built.quoteLines)).toBe(true);
    expect(built.quoteLines.filter(l => l.name === "Menu Board Computer"))
      .toEqual([expect.objectContaining({ qty: 3, coveredByPackage: "AIO Marketing Partial Ordering" })]);
    expect(built.blockers).toEqual([]);
    // Exactly the quote the rep would have got by picking it.
    expect(built.totals).toEqual(build("marketing_partial", ALL_CHIPS).totals);
  });

  it("is never doubled when the picks already carry it", () => {
    expect(marketingLines(build("marketing_partial", ALL_CHIPS))).toHaveLength(1);
  });

  it("comes back on a quote saved before 2026-10-30 without it", () => {
    // A pre-change MPO quote: no marketing line, boards billed at list.
    const saved = build("marketing_partial", WITHOUT_MARKETING).quoteLines
      .filter(l => l.hubspotProductId !== MARKETING_ADDON_PRODUCT.hubspotProductId);
    expect(marketingLines(reopen("marketing_partial", saved))).toHaveLength(1);
  });

  it("refuses the quote when the product is missing from the catalog", () => {
    const catalog = CATALOG.filter(c => c.hubspotProductId !== MARKETING_ADDON_PRODUCT.hubspotProductId);
    const built = buildQuote(
      "marketing_partial",
      WITHOUT_MARKETING.map(([name, qty]) => toQuoteLine(catalog.find(c => c.name === name)!, qty)),
      [], catalog
    );
    expect(marketingLines(built)).toEqual([]);
    expect(built.blockers.join(" ")).toContain("always includes marketing");
  });

  it("stays off every other plan", () => {
    for (const plan of ["all_in_one", "order_pay_only"] as const) {
      expect(marketingLines(build(plan, QSR_WITH_KIOSK)), plan).toEqual([]);
    }
  });

  it("either ordering chip alone satisfies the ordering-point rule", () => {
    const base: Array<[string, number]> = [["Orders Hub Tablet", 1], ["KDS (Kitchen Display System)", 1]];
    const needsPoint = /needs a way to take orders/;
    expect(build("marketing_partial", base).blockers.some(b => needsPoint.test(b))).toBe(true);
    expect(build("marketing_partial", [...base, [KIOSK_NAME, 1]]).blockers.some(b => needsPoint.test(b))).toBe(false);
    expect(build("marketing_partial", [...base, ["Online Ordering", 1]]).blockers.some(b => needsPoint.test(b))).toBe(false);
  });
});
