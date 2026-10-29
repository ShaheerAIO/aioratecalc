import { describe, it, expect, beforeAll } from "vitest";
import { PACKAGES, chargeableKitProductIds, decomposePackages } from "@/lib/quotePackages";
import {
  MARKETING_ADDON_PRODUCT,
  adjustmentsFromQuoteLines,
  buildQuote,
  includesMarketing,
  lineNetAmount,
  picksFromQuoteLines,
  toQuoteLine,
} from "@/lib/quoting";
import { lineHardwareCommission } from "@/lib/commission";
import type { CatalogProduct, QuoteAdjustments, QuoteType } from "@/types/merchant";

// The two product-owner changes of 2026-10-28:
//  - the QSR Kit's free first kiosk can be CHARGED for instead
//    (`LineAdjustment.outsideKit`), decided inside buildQuote and persisted on
//    the saved lines;
//  - Marketing Partial Ordering's Marketing chip puts the hidden $0
//    "Marketing (Partial Ordering)" line on the quote, which is still a real
//    line and still brings the three free menu boards.

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
// The QSR kit as the configurator seeds it, plus the optional kiosk.
const QSR_WITH_KIOSK: Array<[string, number]> = [
  ["POS Unit", 1], ["Customer Facing Display", 1], ["Cash Drawer", 1], ["Payment Terminal - AMS1", 1],
  ["KDS (Kitchen Display System)", 1], ["Thermal Printer", 1], ["Menu Board Computer", 1],
  ["AIO Wifi Network Package - Unifi", 1], [KIOSK_NAME, 1],
];

const CHARGE: QuoteAdjustments = { [KIOSK]: { outsideKit: true } };

const build = (plan: QuoteType, picks: Array<[string, number]>, adjustments: QuoteAdjustments = {}) =>
  buildQuote(plan, lines(picks), [], CATALOG, adjustments);

const kioskLines = (built: ReturnType<typeof buildQuote>) =>
  built.quoteLines.filter(l => l.hubspotProductId === KIOSK);

describe("charging for the QSR Kit's kiosk (2026-10-28)", () => {
  it("is offered on the QSR Kit's kiosk slot only — both kiosk sizes, never on the partial-ordering kit", () => {
    expect(chargeableKitProductIds("all_in_one").sort()).toEqual([KIOSK, KIOSK_156].sort());
    expect(chargeableKitProductIds("order_pay_only").sort()).toEqual([KIOSK, KIOSK_156].sort());
    expect(chargeableKitProductIds("marketing_partial")).toEqual([]);
    expect(chargeableKitProductIds("marketing_only")).toEqual([]);
  });

  for (const plan of ["all_in_one", "order_pay_only"] as const) {
    it(`${plan}: free by default; charged, it bills at list and the rest of the kit stays free`, () => {
      const free = build(plan, QSR_WITH_KIOSK);
      const charged = build(plan, QSR_WITH_KIOSK, CHARGE);

      // Free: the whole kiosk is package-covered at 100%.
      expect(kioskLines(free)).toHaveLength(1);
      expect(kioskLines(free)[0]).toMatchObject({ qty: 1, discountPercent: 100, coveredByPackage: "QSR Kit" });
      expect(kioskLines(free)[0].outsideKit).toBeUndefined();

      // Charged: an ordinary line at its price, marked so a reopen knows why.
      expect(kioskLines(charged)).toHaveLength(1);
      const kiosk = kioskLines(charged)[0];
      expect(kiosk.coveredByPackage).toBeUndefined();
      expect(kiosk.outsideKit).toBe(true);
      expect(lineNetAmount(kiosk)).toBe(999);

      // Exactly the kiosk's price moved — nothing else came out of the kit.
      expect(charged.totals.oneTime - free.totals.oneTime).toBe(999);
      expect(charged.totals.monthlyEquivalent).toBe(free.totals.monthlyEquivalent);
      for (const name of ["POS Unit", "KDS (Kitchen Display System)", "AIO Wifi Network Package - Unifi"]) {
        const line = charged.quoteLines.find(l => l.name === name)!;
        expect(line.coveredByPackage, name).toBe("QSR Kit");
      }
      expect(charged.packages.applied.map(a => a.name)).toEqual(["QSR Kit"]);
      expect(charged.blockers).toEqual(free.blockers);
    });
  }

  it("a charged kiosk takes the rep's discount like any line", () => {
    const built = build("all_in_one", QSR_WITH_KIOSK, { [KIOSK]: { outsideKit: true, discountPercent: 20 } });
    const kiosk = kioskLines(built)[0];
    expect(kiosk.coveredByPackage).toBeUndefined();
    expect(lineNetAmount(kiosk)).toBeCloseTo(799.2, 2);
  });

  it("only the first kiosk is ever free, so a second one bills either way", () => {
    const two: Array<[string, number]> = [...QSR_WITH_KIOSK.filter(([n]) => n !== KIOSK_NAME), [KIOSK_NAME, 2]];
    const free = build("all_in_one", two);
    expect(kioskLines(free).map(l => [l.qty, l.coveredByPackage ?? null])).toEqual([[1, "QSR Kit"], [1, null]]);
    const charged = build("all_in_one", two, CHARGE);
    expect(kioskLines(charged).map(l => [l.qty, l.coveredByPackage ?? null])).toEqual([[2, null]]);
    expect(charged.totals.oneTime - free.totals.oneTime).toBe(999);
  });

  it("on a kiosk-only kit, charging the kiosk still leaves the kit applied to the rest", () => {
    const picks: Array<[string, number]> = [[KIOSK_NAME, 1], ["KDS (Kitchen Display System)", 1]];
    const free = build("order_pay_only", picks);
    const charged = build("order_pay_only", picks, CHARGE);
    expect(kioskLines(free)[0].coveredByPackage).toBe("QSR Kit");
    expect(kioskLines(charged)[0].coveredByPackage).toBeUndefined();
    // The kiosk the merchant pays for is still the system the kit goes with.
    expect(charged.quoteLines.find(l => l.name === "KDS (Kitchen Display System)")!.coveredByPackage).toBe("QSR Kit");
    expect(charged.totals.oneTime - free.totals.oneTime).toBe(999);
  });

  it("a charged kiosk alone, with nothing else in the kit, is still marked as charged", () => {
    const built = build("order_pay_only", [[KIOSK_NAME, 1]], CHARGE);
    expect(built.packages.applied).toEqual([]);
    expect(kioskLines(built)[0]).toMatchObject({ outsideKit: true });
    expect(adjustmentsFromQuoteLines(built.quoteLines)[KIOSK]).toEqual({ outsideKit: true });
  });

  it("decomposePackages: an outsideKit product never fills the chargeable slot; a 15.6\" still can", () => {
    const qsr = lines([["POS Unit", 1], [KIOSK_NAME, 1], ["Kiosk Mini 15.6\" + Payment Terminal (AMS1) and Mount", 1]]);
    const d = decomposePackages({ lines: qsr, quoteType: "all_in_one", outsideKit: [KIOSK] });
    expect(d.lines.find(l => l.hubspotProductId === KIOSK)!.coveredByPackage).toBeUndefined();
    expect(d.lines.find(l => l.hubspotProductId === KIOSK_156)!.coveredByPackage).toBe("QSR Kit");
  });

  it("is ignored on Marketing Partial Ordering, whose kit has no chargeable slot", () => {
    const picks: Array<[string, number]> = [
      ["Orders Hub Tablet", 1], ["KDS (Kitchen Display System)", 1], [KIOSK_NAME, 1],
    ];
    const built = build("marketing_partial", picks, CHARGE);
    expect(kioskLines(built)[0].coveredByPackage).toBe("Partial Ordering Kit");
    expect(kioskLines(built)[0].outsideKit).toBeUndefined();
  });

  it("hardware commission: a charged kiosk earns like a sale; a free one is 'included'", () => {
    const free = kioskLines(build("all_in_one", QSR_WITH_KIOSK))[0];
    const charged = kioskLines(build("all_in_one", QSR_WITH_KIOSK, CHARGE))[0];
    expect(lineHardwareCommission(free)).toMatchObject({ status: "included", rep: null });
    const c = lineHardwareCommission(charged);
    expect(c.status).not.toBe("included");
    // (999 − 600) × 45% — the charged-kiosk rate (2026-10-29)
    expect(c.rep).toBeCloseTo(179.55, 2);
  });
});

describe("the charge flag survives saving and reopening", () => {
  it("round-trips: saved lines → picks + adjustments → the same quote", () => {
    const saved = build("all_in_one", QSR_WITH_KIOSK, CHARGE).quoteLines;

    const reopenedAdjustments = adjustmentsFromQuoteLines(saved);
    expect(reopenedAdjustments[KIOSK]).toEqual({ outsideKit: true });

    const reopenedPicks = picksFromQuoteLines(saved, "all_in_one");
    const rebuilt = buildQuote(
      "all_in_one",
      reopenedPicks.map(pick => toQuoteLine(CATALOG.find(c => c.hubspotProductId === pick.hubspotProductId)!, pick.qty)),
      [], CATALOG, reopenedAdjustments
    );
    expect(rebuilt.quoteLines).toEqual(saved);
  });

  it("carries a discount on the charged kiosk back alongside the flag", () => {
    const saved = build("all_in_one", QSR_WITH_KIOSK, { [KIOSK]: { outsideKit: true, discountPercent: 20 } }).quoteLines;
    expect(adjustmentsFromQuoteLines(saved)[KIOSK]).toEqual({ outsideKit: true, discountPercent: 20 });
  });

  it("a free kiosk reopens free — no flag appears from nowhere", () => {
    const saved = build("all_in_one", QSR_WITH_KIOSK).quoteLines;
    expect(adjustmentsFromQuoteLines(saved)[KIOSK]).toBeUndefined();
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

  it("without the marketing chip there is no marketing line, and the boards bill", () => {
    const built = build("marketing_partial", ALL_CHIPS.filter(([n]) => n !== "Marketing (Partial Ordering)"));
    expect(built.quoteLines.some(l => l.hubspotProductId === MARKETING_ADDON_PRODUCT.hubspotProductId)).toBe(false);
    expect(built.quoteLines.find(l => l.name === "Menu Board Computer")!.coveredByPackage).toBeUndefined();
  });

  it("either ordering chip alone satisfies the ordering-point rule", () => {
    const base: Array<[string, number]> = [["Orders Hub Tablet", 1], ["KDS (Kitchen Display System)", 1]];
    const needsPoint = /needs a way to take orders/;
    expect(build("marketing_partial", base).blockers.some(b => needsPoint.test(b))).toBe(true);
    expect(build("marketing_partial", [...base, [KIOSK_NAME, 1]]).blockers.some(b => needsPoint.test(b))).toBe(false);
    expect(build("marketing_partial", [...base, ["Online Ordering", 1]]).blockers.some(b => needsPoint.test(b))).toBe(false);
  });
});
