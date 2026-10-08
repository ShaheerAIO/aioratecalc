import { describe, it, expect, beforeAll } from "vitest";
import { PACKAGES } from "@/lib/quotePackages";
import {
  AMS1_PRODUCT,
  INCLUDED_SCREEN_COUNT,
  INCLUDED_SERVICE_PRODUCTS,
  WIFI_PRODUCT_ID,
  MARKETING_PRODUCTS,
  MARKETING_INCLUDED_HARDWARE,
  MARKETING_TERM_KIOSK_IDS,
  SINGLE_INSTANCE_PRODUCT_IDS,
  maxQtyFor,
  PROCESSING_DISCLOSURE_PRODUCT,
  ORDER_POINT_RULES,
  PICKER_EXCLUDED_PRODUCT_NAMES,
  PLATFORM_PRODUCTS,
  UNCATEGORIZED_GROUP,
  buildQuote,
  deriveOrderPoints,
  groupProducts,
  isAllowedForQuoteType,
  isPickable,
  isProcessingQuote,
  adjustmentsFromQuoteLines,
  picksFromQuoteLines,
  quoteHasProcessing,
  quoteTotals,
  quoteTypeOf,
  resolveIncludedServices,
  resolveMarketingHardware,
  resolvePlatformLine,
  toQuoteLine,
} from "@/lib/quoting";
import type { CatalogProduct, QuoteLine, QuoteType } from "@/types/merchant";

// The free hardware kit is switched off for this file: these tests assert what
// a plain quote derives, and left on the kit would zero its hardware lines. It
// has its own file (quotePackages.test.ts).
beforeAll(() => { for (const pkg of PACKAGES) pkg.active = false; });

// Fixture catalog mirroring the live HubSpot records (names and prices as they
// actually are, post-trim). No network anywhere in this file.
const p = (
  hubspotProductId: string,
  name: string,
  price: number,
  billingFrequency: CatalogProduct["billingFrequency"],
  productType: string,
): CatalogProduct => ({ hubspotProductId, name, price, billingFrequency, productType });

const CATALOG: CatalogProduct[] = [
  // The three plans' platform products. All monthly — AIO retired the weekly
  // ones on 2026-10-05.
  p("335279520445", "All-in-One (Order & Pay only)", 299, "monthly", ""),
  p("335283119838", "All-in-One Platform", 399, "monthly", ""),
  p("332609247965", "AIO Marketing Platform", 199, "monthly", "Software"),
  // HubSpot holds two active records for the 2-year term and they are NOT
  // identical: 332927902454 includes "1 x Mega Kiosk or 27\" Kiosk" and is the
  // one `marketing_term` quotes, while 334139877086 includes only the 27" and
  // is retired.
  p("332927902454", "AIO Marketing Platform (2-year term)", 299, "monthly", "Software"),
  p("334139877086", "AIO Marketing Platform (2-year term)", 299, "monthly", "Software"),
  p("332617109238", "Marketing Kit - Mega Kiosk", 1500, "one_time", "inventory"),
  p("332793212658", "Marketing Kit - 27\" Kiosk", 999, "one_time", "inventory"),
  p("333275576048", "Website", 50, "monthly", ""),
  // Included ×3 on both marketing plans; ordinary $99 hardware on a POS quote.
  p("223511653103", "Menu Board Computer", 99, "one_time", "inventory"),
  p("335280960199", "Additional Software License", 19, "monthly", "Software"),
  p("217445755632", "POS Unit", 749, "one_time", "inventory"),
  p("223452690130", "POS Unit - With Customer Facing Display", 899, "one_time", "inventory"),
  p("260674226888", "Mega Kiosk", 2459, "one_time", "inventory"),
  p("222497165009", "Kiosk 27\" + Payment Terminal (AMS1) and Mount", 999, "one_time", "inventory"),
  p("335279520447", "AIO Tableside POS", 399, "one_time", ""),
  p("223511653101", "mPOS", 349, "one_time", "inventory"),
  p("223511653105", "Payment Terminal - AMS1", 300, "one_time", "inventory"),
  p("222497165011", "Cash Drawer", 69, "one_time", "inventory"),
  p("276751313619", "Orders Hub Tablet", 199, "one_time", "inventory"),
  p("276754193118", "Clock in Tablet", 199, "one_time", "inventory"),
  p("252941875920", "QSR POS Hardware Bundle", 1110, "one_time", "inventory"),
  // The three always-included services.
  p("281351401209", "AIO WiFi Network Package", 999, "one_time", "inventory"),
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  p("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
  p("260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"),
];

// Nothing in today's catalog bills weekly — every platform product that did is
// deactivated. Published quotes still carry those lines, so `quoteTotals` has
// to keep getting the 52/12 conversion right; this is the fixture for that.
const RETIRED_WEEKLY_PLATFORM = p("217526517443", "AIO Platform (1 to 5 Order Points)", 99, "weekly", "Software");

const find = (name: string) => CATALOG.find(c => c.name === name)!;
const line = (name: string, qty: number) => toQuoteLine(find(name), qty);

describe("picker exclusions", () => {
  it("hides the placeholders, the pre-auth, and every derived line", () => {
    const hidden = CATALOG.filter(c => !isPickable(c)).map(c => c.name).sort();
    expect(hidden).toEqual([
      "AIO Marketing Platform",
      // Both 2-year records: one is this plan's derived platform line, the
      // other is its retired twin. Neither may be picked.
      "AIO Marketing Platform (2-year term)",
      "AIO Marketing Platform (2-year term)",
      "AIO Pre Auth",
      "AIO Processing Two Tiered Rate",
      "AIO WiFi Network Package",
      "Additional Software License",
      "All-in-One (Order & Pay only)",
      "All-in-One Platform",
      "Onsite Installation",
      "QSR POS Hardware Bundle",
      "System Onboarding and Training",
    ]);
  });

  it("hides every plan's platform product — they're derived from the quote type", () => {
    // A rep picking one by hand is how a quote ends up with two platform fees,
    // and it is the largest recurring line on the document.
    for (const plan of Object.values(PLATFORM_PRODUCTS)) {
      expect(isPickable(find(plan.name))).toBe(false);
    }
  });

  it("hides the three always-included services — they are added, not chosen", () => {
    for (const s of INCLUDED_SERVICE_PRODUCTS) {
      expect(isPickable(find(s.name))).toBe(false);
    }
  });

  it("keeps ordinary hardware and software quotable", () => {
    expect(isPickable(find("POS Unit"))).toBe(true);
    // Extras a rep adds by hand. The one-per-POS terminals are derived on top.
    expect(isPickable(find("Payment Terminal - AMS1"))).toBe(true);
    // Derived from the screen count, so a hand-added line would bill it twice.
    expect(isPickable(find("Additional Software License"))).toBe(false);
    // Hardware a marketing plan includes stays ordinary pickable hardware on a
    // POS quote — `isPickable` is about the product, and only the quote type
    // knows whether a line of it was derived or chosen.
    expect(isPickable(find("Menu Board Computer"))).toBe(true);
  });

  it("names the exclusions rather than inlining them", () => {
    expect([...PICKER_EXCLUDED_PRODUCT_NAMES]).toContain("CAMP Invoice");
  });
});

describe("quote types", () => {
  it("maps the retired values onto the plan that replaced them", () => {
    // Their platform products are deactivated in HubSpot, so a row left on one
    // couldn't resolve a platform line at all. All-in-One is the successor.
    expect(quoteTypeOf("full_pos")).toBe("all_in_one");
    expect(quoteTypeOf("food_truck")).toBe("all_in_one");
    expect(quoteTypeOf(null)).toBe("all_in_one");
    expect(quoteTypeOf(undefined)).toBe("all_in_one");
    expect(quoteTypeOf("order_pay_only")).toBe("order_pay_only");
    expect(quoteTypeOf("marketing_only")).toBe("marketing_only");
    expect(quoteTypeOf("marketing_term")).toBe("marketing_term");
  });

  it("lets a POS quote carry marketing products, but not the reverse", () => {
    // The Website can sit on a POS quote. The kits cannot — they belong to the
    // marketing plans, and a processing quote sells its own hardware.
    expect(isAllowedForQuoteType(find("Website"), "all_in_one")).toBe(true);
    expect(isAllowedForQuoteType(find("Marketing Kit - Mega Kiosk"), "all_in_one")).toBe(false);
    expect(isAllowedForQuoteType(find("Marketing Kit - 27\" Kiosk"), "all_in_one")).toBe(false);
    expect(isAllowedForQuoteType(find("QSR POS Hardware Bundle"), "all_in_one")).toBe(false);
    for (const plan of ["marketing_only", "marketing_term"] as const) {
      expect(isAllowedForQuoteType(find("POS Unit"), plan)).toBe(false);
      expect(isAllowedForQuoteType(find("Mega Kiosk"), plan)).toBe(false);
      // Included by the plan, so derived — never a thing a rep adds.
      expect(isAllowedForQuoteType(find("Menu Board Computer"), plan)).toBe(false);
    }
  });

  it("allows exactly the marketing products on a marketing-only quote", () => {
    for (const plan of ["marketing_only", "marketing_term"] as const) {
      const allowed = CATALOG.filter(c => isAllowedForQuoteType(c, plan))
        .map(c => c.hubspotProductId).sort();
      expect(allowed).toEqual(MARKETING_PRODUCTS.map(m => m.hubspotProductId).sort());
    }
  });

  it("derives the software license instead of offering it as a pick", () => {
    expect(isAllowedForQuoteType(find("Additional Software License"), "marketing_only")).toBe(false);
    expect(isAllowedForQuoteType(find("Additional Software License"), "all_in_one")).toBe(false);
  });
});

describe("always-included services", () => {
  const SOMETHING = [line("POS Unit", 1)];

  it("puts a network, an install and a training on any quote with products, one each", () => {
    for (const quoteType of ["order_pay_only", "all_in_one"] as const) {
      const { lines, missing } = resolveIncludedServices(quoteType, SOMETHING, CATALOG);
      expect(missing).toEqual([]);
      expect(lines.map(l => l.name)).toEqual([
        "AIO WiFi Network Package",
        "Onsite Installation",
        "System Onboarding and Training",
      ]);
      expect(lines.every(l => l.qty === 1)).toBe(true);
      // Only the WiFi package is CHARGED. The install and the training are on
      // the quote at MSRP and comped to $0 — AE price sheet, effective
      // 2026-09-18. See COMPED_SERVICE_PRODUCT_IDS.
      expect(quoteTotals(lines).oneTime).toBe(999);
      const byName = new Map(lines.map(l => [l.name, l]));
      expect(byName.get("AIO WiFi Network Package")!.discountPercent).toBeUndefined();
      expect(byName.get("Onsite Installation")!.discountPercent).toBe(100);
      expect(byName.get("System Onboarding and Training")!.discountPercent).toBe(100);
    }
  });

  it("adds none of them to a marketing-only quote — nothing is being installed", () => {
    expect(resolveIncludedServices("marketing_only", SOMETHING, CATALOG)).toEqual({ lines: [], missing: [] });
    expect(resolveIncludedServices("marketing_term", SOMETHING, CATALOG)).toEqual({ lines: [], missing: [] });
  });

  it("adds none of them to a rate-only quote — no products means nothing to install", () => {
    expect(resolveIncludedServices("all_in_one", [], CATALOG)).toEqual({ lines: [], missing: [] });
    expect(resolveIncludedServices("order_pay_only", [], CATALOG)).toEqual({ lines: [], missing: [] });
  });

  it("attaches to products, not to declared channels", () => {
    // A website-ordering merchant has no on-site anything for a $999 install or
    // a $999 WiFi package to cover, even though the channel does carry a
    // platform fee.
    const built = buildQuote("all_in_one", [], ["website"], CATALOG);
    expect(built.orderPoints.total).toBe(1);
    expect(built.platform.status).toBe("resolved");
    expect(built.includedServices.lines).toEqual([]);
    expect(built.quoteLines.map(l => l.name)).toEqual(["All-in-One Platform"]);
  });

  it("is LOUD when a required service isn't in the catalog", () => {
    // Silently dropping it is $999 off the quote, so it has to block the send
    // rather than read as "not included."
    const without = CATALOG.filter(c => c.name !== "Onsite Installation");
    const { lines, missing } = resolveIncludedServices("all_in_one", SOMETHING, without);
    expect(missing).toEqual(["Onsite Installation"]);
    expect(lines.map(l => l.name)).not.toContain("Onsite Installation");
  });

  it("finds a service by product id, so a HubSpot rename can't drop it", () => {
    const renamed = CATALOG.map(c =>
      c.name === "Onsite Installation" ? { ...c, name: "On-Site Installation (2026)" } : c
    );
    const { lines, missing } = resolveIncludedServices("all_in_one", SOMETHING, renamed);
    expect(missing).toEqual([]);
    expect(lines.find(l => l.hubspotProductId === "223452690133")!.unitPrice).toBe(999);
  });
});

describe("groupProducts", () => {
  it("orders hardware, software, service, then the untyped bucket", () => {
    // Built from a synthetic list rather than CATALOG: AIO currently sells no
    // pickable Service-typed product at all (the only ones are the two
    // included services and the per-transaction pre-auth, all unpickable), so
    // the live catalog can't exercise the ordering rule on its own.
    const groups = groupProducts([
      p("1", "Untyped Thing", 1, "one_time", ""),
      p("2", "A Service", 1, "one_time", "Service"),
      p("3", "A Hardware Thing", 1, "one_time", "inventory"),
      p("4", "A Software Thing", 1, "monthly", "Software"),
    ]);
    expect(groups.map(g => g.label)).toEqual(["Hardware", "Software", "Service", UNCATEGORIZED_GROUP]);
  });

  it("never silently hides an untyped product", () => {
    const groups = groupProducts(CATALOG.filter(isPickable));
    const uncategorized = groups.find(g => g.type === UNCATEGORIZED_GROUP)!;
    // Four live catalog entries carry no hs_product_type.
    expect(uncategorized.products.map(x => x.name)).toContain("AIO Tableside POS");
    expect(uncategorized.products.map(x => x.name)).toContain("Website");
  });
});

describe("quoteTotals — frequency-aware, never merged", () => {
  it("keeps a weekly platform fee and a one-time POS unit as separate numbers", () => {
    // E2E-PLAN.md's Phase C verify case, on the retired weekly platform fee:
    // nothing sellable bills weekly any more, but published quotes do.
    const lines = [toQuoteLine(RETIRED_WEEKLY_PLATFORM, 1), line("POS Unit", 1)];
    const t = quoteTotals(lines);

    expect(t.oneTime).toBe(749);
    expect(t.recurring).toEqual([{ frequency: "weekly", amount: 99 }]);
    // The 4.33x trap: 99 x 52/12, not 99 (rendering a weekly price as monthly)
    // and not 99 x 4. HubSpot's own hs_mrr shows $428.67 because it rounds the
    // factor to 4.33; the exact 52/12 normalization is $429.00, so assert the
    // magnitude rather than pretending the two agree to the cent.
    expect(t.monthlyEquivalent).toBeCloseTo(99 * (52 / 12), 10);
    expect(t.monthlyEquivalent).toBeGreaterThan(428);
    expect(t.monthlyEquivalent).toBeLessThan(430);
    expect(Math.abs(t.monthlyEquivalent - 428.67)).toBeLessThan(0.5);

    // Nothing anywhere in the result equals the naive cross-frequency sum.
    const naive = 749 + 99;
    expect(t.oneTime).not.toBe(naive);
    expect(t.monthlyEquivalent).not.toBe(naive);
    expect(t.recurring.some(r => r.amount === naive)).toBe(false);
  });

  it("groups recurring lines by cycle instead of adding weekly to monthly", () => {
    const lines = [
      toQuoteLine(RETIRED_WEEKLY_PLATFORM, 1),      // $99/wk
      line("All-in-One Platform", 1),               // $399/mo
      line("Additional Software License", 1),       // $19/mo
    ];
    const t = quoteTotals(lines);

    expect(t.recurring).toEqual([
      { frequency: "weekly", amount: 99 },
      { frequency: "monthly", amount: 418 },
    ]);
    // 99 x 52/12 + 418 — the only legitimate way to combine the two cycles.
    expect(t.monthlyEquivalent).toBeCloseTo(99 * (52 / 12) + 418, 10);
    expect(t.recurring.some(r => r.amount === 517)).toBe(false);
  });

  it("multiplies by quantity and leaves one-time charges out of the monthly figure", () => {
    const t = quoteTotals([line("POS Unit", 3)]);
    expect(t.oneTime).toBe(2247);
    expect(t.monthlyEquivalent).toBe(0);
    expect(t.recurring).toEqual([]);
  });
});

describe("snapshot immutability", () => {
  it("keeps the quoted price when the catalog price later changes", () => {
    const catalogNow = [p("335283119838", "All-in-One Platform", 399, "monthly", "")];
    const quoted = toQuoteLine(catalogNow[0], 1);

    // HubSpot raises the platform fee after the quote went out.
    catalogNow[0] = { ...catalogNow[0], price: 449, billingFrequency: "weekly" };

    expect(quoted.unitPrice).toBe(399);
    expect(quoted.billingFrequency).toBe("monthly");
    expect(quoteTotals([quoted]).recurring).toEqual([{ frequency: "monthly", amount: 399 }]);
  });
});

describe("deriveOrderPoints", () => {
  it("counts 3 POS + 2 kiosks + a website as 6", () => {
    const lines = [line("POS Unit", 3), line("Mega Kiosk", 2)];
    const { orderPoints } = deriveOrderPoints(lines, ["website"]);

    expect(orderPoints.hardware).toEqual({ "POS Unit": 3, "Mega Kiosk": 2 });
    expect(orderPoints.channels).toEqual(["website"]);
    expect(orderPoints.total).toBe(6);
  });

  it("no longer moves the platform fee — the count is reporting only", () => {
    // It used to select a 1-5 or 6+ tier, a $433/mo swing. Since 2026-10-05
    // the plan decides, so the same quote type prices the same at any count.
    for (const lines of [[line("POS Unit", 1)], [line("POS Unit", 3), line("Mega Kiosk", 2)]]) {
      const platform = resolvePlatformLine("all_in_one", lines, [], CATALOG);
      expect(platform.status).toBe("resolved");
      expect(platform.line!.unitPrice).toBe(399);
      expect(platform.line!.billingFrequency).toBe("monthly");
    }
  });

  it("counts a tableside POS, which Steve's list calls a Tableside AI Device", () => {
    expect(ORDER_POINT_RULES["AIO Tableside POS"].pointsPerUnit).toBe(1);
    const { orderPoints, unclassified } = deriveOrderPoints([line("AIO Tableside POS", 2)], []);
    expect(orderPoints.total).toBe(2);
    expect(unclassified).toEqual([]);
  });

  it("counts neither marketing kit, and calls neither of them a mystery", () => {
    // Named for kiosks, but not ordering kiosks (Shaheer, 2026-10-05). Both
    // are typed `inventory`, so without an explicit 0-point rule they'd warn
    // the rep about unclassified hardware on every marketing quote.
    const lines = [line("Marketing Kit - Mega Kiosk", 1), line("Marketing Kit - 27\" Kiosk", 2)];
    const { orderPoints, unclassified, needsReview } = deriveOrderPoints(lines, []);
    expect(orderPoints.total).toBe(0);
    expect(unclassified).toEqual([]);
    expect(needsReview).toEqual([]);
  });

  it("counts the website CHANNEL, never the Website product, so it can't double", () => {
    const { orderPoints } = deriveOrderPoints([line("Website", 1)], ["website"]);
    expect(orderPoints.total).toBe(1);
    expect(orderPoints.hardware).toEqual({});
  });

  it("counts the QSR bundle as the one POS it contains", () => {
    // Confirmed 2026-08-20. It used to contribute 0 with a needs-review flag
    // while nobody knew what was in it.
    expect(ORDER_POINT_RULES["QSR POS Hardware Bundle"].pointsPerUnit).toBe(1);
    expect(ORDER_POINT_RULES["QSR POS Hardware Bundle"].needsReview).toBeUndefined();

    const { orderPoints, needsReview } = deriveOrderPoints([line("QSR POS Hardware Bundle", 3)], []);
    expect(orderPoints.total).toBe(3);
    expect(needsReview).toEqual([]);
  });

  it("counts a point-bearing product even when HubSpot lost its product type", () => {
    // The type gate used to skip anything not typed `inventory`, so an untyped
    // or re-typed kiosk silently contributed 0 AND never showed up as
    // unclassified — 6 real points billed as 5.
    const untypedKiosk: QuoteLine = {
      ...line("Mega Kiosk", 2), productType: "",
    };
    const { orderPoints, unclassified } = deriveOrderPoints([untypedKiosk, line("POS Unit", 4)], []);

    expect(orderPoints.hardware["Mega Kiosk"]).toBe(2);
    expect(orderPoints.total).toBe(6);
    expect(unclassified).toEqual([]);
  });

  it("matches the rule on product id, so a HubSpot rename can't drop the points", () => {
    const renamed: QuoteLine = { ...line("Mega Kiosk", 1), name: "Mega Kiosk (2026 Edition)" };
    const { orderPoints, unclassified } = deriveOrderPoints([renamed], []);

    expect(orderPoints.total).toBe(1);
    expect(orderPoints.hardware["Mega Kiosk (2026 Edition)"]).toBe(1);
    expect(unclassified).toEqual([]);
  });

  it("counts a kiosk once, not once per lane", () => {
    expect(ORDER_POINT_RULES["Mega Kiosk"].pointsPerUnit).toBe(1);
    expect(deriveOrderPoints([line("Mega Kiosk", 1)], []).orderPoints.total).toBe(1);
  });

  it("counts each declared channel once and only the known ones", () => {
    const { orderPoints } = deriveOrderPoints([], ["website", "qr", "not_a_channel"]);
    expect(orderPoints.channels).toEqual(["website", "qr"]);
    expect(orderPoints.total).toBe(2);
  });

  it("excludes payment terminals, cash drawers and other non-ordering hardware", () => {
    const lines = [line("Payment Terminal - AMS1", 4), line("Cash Drawer", 2), line("Website", 1)];
    const { orderPoints, unclassified } = deriveOrderPoints(lines, []);
    expect(orderPoints.total).toBe(0);
    // All three are known rules at 0 points, so none of them is a mystery —
    // including the Website product, which carries no hs_product_type live.
    expect(unclassified).toEqual([]);
  });

  it("counts neither tablet, and flags neither for review", () => {
    // Resolved by Shaheer 2026-09-17. Both were 0-with-needsReview, and that
    // flag REFUSED the billing publish (billing/preconditions.ts rule 6) on
    // every quote carrying one — a real deal stalled on "Clock in Tablet" with
    // nothing a rep could click to clear it. They still contribute 0 points;
    // what's gone is the refusal.
    for (const name of ["Orders Hub Tablet", "Clock in Tablet"]) {
      expect(ORDER_POINT_RULES[name].pointsPerUnit).toBe(0);
      expect(ORDER_POINT_RULES[name].needsReview).toBeUndefined();
    }

    const lines = [line("POS Unit", 2), line("Orders Hub Tablet", 4), line("Clock in Tablet", 1)];
    const { orderPoints, needsReview, unclassified } = deriveOrderPoints(lines, []);

    expect(orderPoints.total).toBe(2);                     // still not counted
    expect(orderPoints.hardware["Orders Hub Tablet"]).toBeUndefined();
    expect(orderPoints.hardware["Clock in Tablet"]).toBeUndefined();
    expect(needsReview).toEqual([]);                       // and no longer blocking
    expect(unclassified).toEqual([]);                      // known rules, not mysteries
  });

  it("surfaces unrecognised hardware as unclassified at zero points", () => {
    const unknown: QuoteLine = {
      hubspotProductId: "999", name: "Some New Ordering Gadget", qty: 2,
      unitPrice: 500, billingFrequency: "one_time", productType: "inventory",
    };
    const { orderPoints, unclassified } = deriveOrderPoints([unknown], []);
    expect(orderPoints.total).toBe(0);
    expect(unclassified).toEqual([{ name: "Some New Ordering Gadget", qty: 2 }]);
  });

  it("does not treat software or services as unclassified hardware", () => {
    const { unclassified } = deriveOrderPoints(
      [line("Onsite Installation", 1), line("Additional Software License", 1)], []
    );
    expect(unclassified).toEqual([]);
  });
});

describe("platform line selection", () => {
  const SOME_PICK = [toQuoteLine(CATALOG.find(c => c.name === "POS Unit")!, 1)];

  it("gives each plan its own monthly platform product", () => {
    const prices: Record<QuoteType, number> = {
      order_pay_only: 299, all_in_one: 399, marketing_only: 199, marketing_term: 299,
    };
    for (const [quoteType, price] of Object.entries(prices) as Array<[QuoteType, number]>) {
      const platform = resolvePlatformLine(quoteType, SOME_PICK, [], CATALOG);
      expect(platform.status).toBe("resolved");
      expect(platform.line!.name).toBe(PLATFORM_PRODUCTS[quoteType].name);
      expect(platform.line!.unitPrice).toBe(price);
      expect(platform.line!.billingFrequency).toBe("monthly");
    }
  });

  it("selects nothing for a rate-only quote — nothing picked, no channel declared", () => {
    expect(resolvePlatformLine("all_in_one", [], [], CATALOG))
      .toEqual({ status: "none_needed", line: null, productName: null });
  });

  it("still charges the plan when the only ordering point is a declared channel", () => {
    // A website-ordering merchant with no hardware is on the platform. Unlike
    // the install services, which need something physical on site.
    const platform = resolvePlatformLine("all_in_one", [], ["website"], CATALOG);
    expect(platform.status).toBe("resolved");
    expect(platform.line!.unitPrice).toBe(399);
  });

  it("quotes the 2-year term as the PLAN, picking HubSpot's 'Mega or 27\"' record", () => {
    // It used to be a product a rep added, which replaced the $199 line. It is
    // a plan of its own since 2026-10-06 — and of HubSpot's two $299 records
    // this is the one whose description carries the kiosk CHOICE.
    const platform = resolvePlatformLine("marketing_term", [], [], CATALOG);
    expect(platform.status).toBe("resolved");
    expect(platform.line!.hubspotProductId).toBe("332927902454");
    expect(platform.line!.unitPrice).toBe(299);
  });

  it("never leaves a marketing plan rate-only — there is no rate behind it", () => {
    // `none_needed` is for a processing quote with nothing on it. An empty
    // marketing quote is a subscription nobody has added to yet, and it bills.
    for (const [plan, price] of [["marketing_only", 199], ["marketing_term", 299]] as const) {
      const platform = resolvePlatformLine(plan, [], [], CATALOG);
      expect(platform.status).toBe("resolved");
      expect(platform.line!.unitPrice).toBe(price);
    }
  });

  it("finds the plan by product id, so a HubSpot rename can't drop the platform fee", () => {
    const renamed = CATALOG.map(c =>
      c.name === "All-in-One Platform" ? { ...c, name: "All-in-One Platform (2027)" } : c
    );
    const platform = resolvePlatformLine("all_in_one", SOME_PICK, [], renamed);
    expect(platform.status).toBe("resolved");
    expect(platform.line!.unitPrice).toBe(399);
  });

  it("is LOUD, not null, when the plan's fee is owed but the catalog can't supply it", () => {
    // Silently omitting this line is a $399/mo hole in the quote, so the caller
    // has to be forced to deal with it rather than reading it as "no fee due".
    const platform = resolvePlatformLine("all_in_one", SOME_PICK, [], []);
    expect(platform.status).toBe("unresolved");
    expect(platform.line).toBeNull();
    expect(platform.productName).toBe("All-in-One Platform");
  });
});

describe("buildQuote — the one derivation", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));

  it("assembles an All-in-One quote: platform line, the three services, then the picks", () => {
    const built = buildQuote("all_in_one", picked([["POS Unit", 2], ["Cash Drawer", 1]]), ["website"], CATALOG);

    expect(built.blockers).toEqual([]);
    expect(built.orderPoints.total).toBe(3); // 2 POS + website
    expect(built.quoteLines.map(l => l.name)).toEqual([
      "All-in-One Platform",
      "AIO WiFi Network Package",
      "Onsite Installation",
      "System Onboarding and Training",
      "POS Unit",
      "Cash Drawer",
      // One per POS unit, charged, on top of anything the rep picked.
      "Payment Terminal - AMS1",
    ]);
    // 999 + 2×749 + 69 + 2×300 = $3,166 due once. The install ($999) and the
    // training ($499) are on the quote but comped to $0, so they add nothing.
    expect(built.totals.oneTime).toBe(3166);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 399 }]);
  });

  it("prices the same cart $100/mo lower on the Order & Pay plan", () => {
    const cart = picked([["POS Unit", 2], ["Cash Drawer", 1]]);
    const lesser = buildQuote("order_pay_only", cart, ["website"], CATALOG);
    const full = buildQuote("all_in_one", cart, ["website"], CATALOG);

    expect(lesser.totals.oneTime).toBe(full.totals.oneTime);
    expect(lesser.totals.recurring).toEqual([{ frequency: "monthly", amount: 299 }]);
    expect(full.totals.recurring).toEqual([{ frequency: "monthly", amount: 399 }]);
  });

  it("drops declared channels on a marketing-only quote", () => {
    // A marketing merchant isn't taking orders through AIO, so ticking
    // "website / online ordering" must not report an ordering point.
    const built = buildQuote(
      "marketing_only",
      picked([["Marketing Kit - Mega Kiosk", 1]]),
      ["website", "qr"],
      CATALOG
    );

    expect(built.orderPoints).toEqual({ hardware: {}, channels: [], total: 0 });
    expect(built.quoteLines.map(l => l.name)).toEqual([
      "AIO Marketing Platform",
      "Menu Board Computer",
      "Marketing Kit - Mega Kiosk",
    ]);
    expect(built.includedServices.lines).toEqual([]);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 199 }]);
    expect(built.blockers).toEqual([]);
  });

  it("leaves a rate-only quote empty — no products, so no plan and no services", () => {
    const built = buildQuote("all_in_one", [], [], CATALOG);
    expect(built.platform.status).toBe("none_needed");
    expect(built.quoteLines).toEqual([]);
    expect(built.totals.oneTime).toBe(0);
  });

  it("still charges a marketing-only quote with nothing picked", () => {
    // Unlike a processing quote, there is no rate behind this one — a quote
    // with no lines on it would be nothing at all.
    const built = buildQuote("marketing_only", [], [], CATALOG);
    expect(built.quoteLines.map(l => l.name)).toEqual([
      "AIO Marketing Platform",
      "Menu Board Computer",
    ]);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 199 }]);
    // The included hardware is on the quote at MSRP and costs nothing.
    expect(built.totals.oneTime).toBe(0);
  });

  it("blocks the send when a required line can't be priced", () => {
    const stripped = CATALOG.filter(
      c => c.name !== "Onsite Installation" && c.name !== "All-in-One Platform"
    );
    const built = buildQuote("all_in_one", picked([["POS Unit", 1]]), [], stripped);

    expect(built.blockers).toHaveLength(2);
    expect(built.blockers.join(" ")).toContain("All-in-One Platform");
    expect(built.blockers.join(" ")).toContain("Onsite Installation");
  });

  it("round-trips through picksFromQuoteLines without duplicating a derived line", () => {
    // Reopening a saved quote must not send the platform fee or the services
    // back as picks — they'd be quoted twice, or refused as unpickable.
    const first = buildQuote("all_in_one", picked([["Mega Kiosk", 1]]), [], CATALOG);
    const reopened = picksFromQuoteLines(first.quoteLines, "all_in_one");

    expect(reopened).toEqual([{ hubspotProductId: "260674226888", qty: 1 }]);

    const second = buildQuote(
      "all_in_one",
      reopened.map(pick => toQuoteLine(CATALOG.find(c => c.hubspotProductId === pick.hubspotProductId)!, pick.qty)),
      [],
      CATALOG
    );
    expect(second.quoteLines).toEqual(first.quoteLines);
  });
});

// ── The two marketing plans ─────────────────────────────────────────────────
// $199 and $299 (2-year term) differ in exactly two ways: the platform line,
// and whether the kiosk is free. Everything else about them is identical, and
// these are the tests that keep it that way.
describe("marketing plans", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const MEGA = "Marketing Kit - Mega Kiosk";
  const KIOSK_27 = "Marketing Kit - 27\" Kiosk";

  it("hands both plans three Menu Board Computers at no charge", () => {
    for (const plan of ["marketing_only", "marketing_term"] as const) {
      const { lines, missing } = resolveMarketingHardware(plan, CATALOG);
      expect(missing).toEqual([]);
      expect(lines.map(l => [l.name, l.qty, l.discountPercent, l.coveredByPackage])).toEqual([
        ["Menu Board Computer", 3, 100, PLATFORM_PRODUCTS[plan].name],
      ]);
      expect(quoteTotals(lines).oneTime).toBe(0);
    }
  });

  it("gives a processing quote none of it — the computers are ordinary hardware there", () => {
    expect(resolveMarketingHardware("all_in_one", CATALOG)).toEqual({ lines: [], missing: [] });
  });

  it("blocks a 2-year quote with no kiosk on it", () => {
    // The kiosk is part of what $299/mo buys. A quote without one charges the
    // committed price for hardware that never appears on the document.
    const built = buildQuote("marketing_term", [], [], CATALOG);
    expect(built.blockers).toHaveLength(1);
    expect(built.blockers[0]).toContain("includes one kiosk at no cost");
  });

  it("holds the first kiosk at $0 on the 2-year plan and bills the rest", () => {
    const built = buildQuote("marketing_term", picked([[MEGA, 3]]), [], CATALOG);
    expect(built.blockers).toEqual([]);

    const kiosks = built.quoteLines.filter(l => l.name === MEGA);
    expect(kiosks.map(l => [l.qty, l.discountPercent ?? null])).toEqual([[1, 100], [2, null]]);
    // $1,500 × 2 — the third is the plan's, and the menu boards are free.
    expect(built.totals.oneTime).toBe(3000);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 299 }]);
  });

  it("charges for the same kiosk on the $199 plan", () => {
    const built = buildQuote("marketing_only", picked([[MEGA, 1]]), [], CATALOG);
    expect(built.blockers).toEqual([]);
    expect(built.totals.oneTime).toBe(1500);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 199 }]);
  });

  it("comps the DEARER kiosk when a merchant buys both", () => {
    // The plan says "a Mega or a 27-inch". Buying the other one too must not
    // cost the merchant the better half of the inclusion.
    const built = buildQuote("marketing_term", picked([[KIOSK_27, 1], [MEGA, 1]]), [], CATALOG);
    const free = built.quoteLines.find(l => l.discountPercent === 100 && l.name !== "Menu Board Computer");
    expect(free!.name).toBe(MEGA);
    expect(built.totals.oneTime).toBe(999);
  });

  it("names both kiosks the plan may include", () => {
    expect(MARKETING_TERM_KIOSK_IDS).toEqual([find(MEGA).hubspotProductId, find(KIOSK_27).hubspotProductId]);
    expect(MARKETING_INCLUDED_HARDWARE.map(h => h.hubspotProductId))
      .toEqual([find("Menu Board Computer").hubspotProductId]);
  });

  it("reopens a 2-year quote with the kiosk whole and the included hardware gone", () => {
    // The split halves sum back to what the rep picked, and the three derived
    // Menu Board Computers must NOT come back as picks — the server refuses
    // them outright on a marketing quote, so a round-trip would wedge the save.
    const first = buildQuote("marketing_term", picked([[MEGA, 2]]), [], CATALOG);
    const reopened = picksFromQuoteLines(first.quoteLines, "marketing_term");
    expect(reopened).toEqual([{ hubspotProductId: find(MEGA).hubspotProductId, qty: 2 }]);

    const second = buildQuote(
      "marketing_term",
      reopened.map(pick => toQuoteLine(CATALOG.find(c => c.hubspotProductId === pick.hubspotProductId)!, pick.qty)),
      [],
      CATALOG
    );
    expect(second.quoteLines).toEqual(first.quoteLines);
  });

  it("keeps the Menu Board Computer as a pick when reopening a POS quote", () => {
    const built = buildQuote("all_in_one", picked([["Menu Board Computer", 2]]), [], CATALOG);
    expect(picksFromQuoteLines(built.quoteLines, "all_in_one"))
      .toContainEqual({ hubspotProductId: find("Menu Board Computer").hubspotProductId, qty: 2 });
  });

  it("will not let a rep charge for what the plan already paid for", () => {
    // Same rule as a package-covered line, and for the same reason: the
    // subscription bought it. An unrelated edit on the row can't restore it.
    const built = buildQuote(
      "marketing_term",
      picked([[MEGA, 1]]),
      [],
      CATALOG,
      { [find(MEGA).hubspotProductId]: { billingStart: { mode: "days", days: 60 } } }
    );
    const kiosk = built.quoteLines.find(l => l.name === MEGA)!;
    expect(kiosk.discountPercent).toBe(100);
    expect(built.totals.oneTime).toBe(0);
  });
});

// ── The website unlock ──────────────────────────────────────────────────────
// A marketing merchant whose $50 Website takes online orders sells through it,
// so AIO processes those card payments. That makes them a PROCESSING merchant
// without making them a POS merchant, and these tests exist to keep those two
// apart. Online ordering is optional: a plain website takes no payments.
describe("website on a marketing quote", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const RATE_LINE = PROCESSING_DISCLOSURE_PRODUCT.name;
  const SITE_ID = find("Website").hubspotProductId;
  const ORDERING = { [SITE_ID]: { onlineOrdering: true } };

  it("separates 'is this a POS deal' from 'does AIO touch their money'", () => {
    const withSite = [{ hubspotProductId: SITE_ID }];

    for (const plan of ["marketing_only", "marketing_term"] as const) {
      // The plan alone: no processing.
      expect(isProcessingQuote(plan)).toBe(false);
      expect(quoteHasProcessing(plan, [])).toBe(false);
      // A plain website takes no payments.
      expect(quoteHasProcessing(plan, withSite)).toBe(false);
      expect(quoteHasProcessing(plan, withSite, {})).toBe(false);
      // With online ordering they process — but it is still not a POS deal.
      expect(quoteHasProcessing(plan, withSite, ORDERING)).toBe(true);
      expect(isProcessingQuote(plan)).toBe(false);
    }

    // A processing plan processes whatever is on it.
    expect(quoteHasProcessing("all_in_one", [])).toBe(true);
  });

  it("reads processing off SAVED lines by the rate line, which legacy website quotes all carry", () => {
    const saved = buildQuote("marketing_only", picked([["Website", 1]]), [], CATALOG, ORDERING).quoteLines;
    expect(quoteHasProcessing("marketing_only", saved)).toBe(true);
    const plain = buildQuote("marketing_only", picked([["Website", 1]]), [], CATALOG).quoteLines;
    expect(quoteHasProcessing("marketing_only", plain)).toBe(false);
  });

  it("adds no rate line for a website without online ordering", () => {
    const built = buildQuote("marketing_only", picked([["Website", 1]]), [], CATALOG);
    expect(built.blockers).toEqual([]);
    expect(built.quoteLines.map(l => l.name)).not.toContain(RATE_LINE);
  });

  it("keeps online ordering on when a saved quote is reopened", () => {
    const saved = buildQuote("marketing_only", picked([["Website", 1]]), [], CATALOG, ORDERING).quoteLines;
    expect(adjustmentsFromQuoteLines(saved, "marketing_only")[SITE_ID]).toEqual({ onlineOrdering: true });
    const plain = buildQuote("marketing_only", picked([["Website", 1]]), [], CATALOG).quoteLines;
    expect(adjustmentsFromQuoteLines(plain, "marketing_only")[SITE_ID]).toBeUndefined();
  });

  it("states the card rates on the quote once online ordering is on", () => {
    const built = buildQuote("marketing_only", picked([["Website", 1]]), [], CATALOG, ORDERING);
    expect(built.blockers).toEqual([]);
    expect(built.quoteLines.map(l => l.name)).toEqual([
      "AIO Marketing Platform",
      RATE_LINE,
      "Menu Board Computer",
      "Website",
    ]);
    // It discloses, it doesn't bill: $199 + $50 and nothing one-time.
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 249 }]);
    expect(built.totals.oneTime).toBe(0);
  });

  it("leaves a marketing quote with no website alone", () => {
    const built = buildQuote("marketing_only", picked([["Marketing Kit - Mega Kiosk", 1]]), [], CATALOG);
    expect(built.quoteLines.map(l => l.name)).not.toContain(RATE_LINE);
  });

  it("does NOT add it to a POS quote, which has always processed without one", () => {
    // Every POS quote AIO has ever sent carries no rate line, and those
    // documents can't be amended once published. The marketing case is
    // different because nothing else on that quote says AIO touches the money.
    const built = buildQuote("all_in_one", picked([["POS Unit", 1], ["Website", 1]]), [], CATALOG, ORDERING);
    expect(built.quoteLines.map(l => l.name)).not.toContain(RATE_LINE);
  });

  it("still installs nothing — a website merchant has nothing on site", () => {
    // The regression this whole split exists to prevent: answering "do they
    // process" with the plan predicate, or "is this a POS deal" with this one,
    // puts a $999 onsite installation on a website merchant's quote.
    const built = buildQuote("marketing_term", picked([["Website", 1], ["Marketing Kit - Mega Kiosk", 1]]), [], CATALOG);
    expect(built.includedServices.lines).toEqual([]);
    expect(built.quoteLines.map(l => l.name)).not.toContain("Onsite Installation");
    expect(built.quoteLines.map(l => l.name)).not.toContain("AIO WiFi Network Package");
    expect(built.orderPoints.total).toBe(0);
  });

  it("blocks the quote when the rate product is missing from the catalog", () => {
    const stripped = CATALOG.filter(c => c.name !== RATE_LINE);
    const built = buildQuote("marketing_only", picked([["Website", 1]]), [], stripped, ORDERING);
    expect(built.blockers).toHaveLength(1);
    expect(built.blockers[0]).toContain("state the card rates");
  });

  it("never hands the rate line back as a pick — no rep may put it on by hand", () => {
    const built = buildQuote("marketing_only", picked([["Website", 1]]), [], CATALOG, ORDERING);
    expect(isPickable(find(RATE_LINE))).toBe(false);
    expect(picksFromQuoteLines(built.quoteLines, "marketing_only"))
      .toEqual([{ hubspotProductId: find("Website").hubspotProductId, qty: 1 }]);
  });
});

describe("one website per merchant", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const WEBSITE = "Website";

  it("caps the Website at one and leaves hardware uncapped", () => {
    expect(maxQtyFor(find(WEBSITE).hubspotProductId)).toBe(1);
    expect(SINGLE_INSTANCE_PRODUCT_IDS).toEqual([find(WEBSITE).hubspotProductId]);
    // A restaurant buys several POS units; that must stay unrestricted.
    expect(maxQtyFor(find("POS Unit").hubspotProductId)).toBeNull();
  });

  it("refuses a quote carrying two of them", () => {
    const built = buildQuote("all_in_one", picked([[WEBSITE, 2]]), [], CATALOG);
    expect(built.blockers.some(b => b.includes("only have 1"))).toBe(true);
  });

  it("allows exactly one", () => {
    expect(buildQuote("all_in_one", picked([[WEBSITE, 1]]), [], CATALOG).blockers).toEqual([]);
    expect(buildQuote("marketing_only", picked([[WEBSITE, 1]]), [], CATALOG).blockers).toEqual([]);
  });

  it("catches two SPLIT across lines, not just two on one line", () => {
    // A scoped discount splits one pick into two lines. Counting per line
    // instead of per product would let 1 + 1 through as "no line over 1".
    const id = find(WEBSITE).hubspotProductId;
    const built = buildQuote(
      "all_in_one", picked([[WEBSITE, 2]]), [], CATALOG,
      { [id]: { discountPercent: 50, discountQty: 1 } }, 100
    );
    expect(built.quoteLines.filter(l => l.hubspotProductId === id)).toHaveLength(2);
    expect(built.blockers.some(b => b.includes("only have 1"))).toBe(true);
  });
});

describe("derived terminals, licenses, and the lines a processing quote no longer sells", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const ams1Qty = (lines: QuoteLine[]) =>
    lines.filter(l => l.hubspotProductId === AMS1_PRODUCT.hubspotProductId)
      .reduce((n, l) => n + l.qty, 0);

  it("charges one AMS1 per POS unit, on top of any the rep picked", () => {
    const built = buildQuote(
      "all_in_one",
      picked([["POS Unit", 2], ["POS Unit - With Customer Facing Display", 1], ["Payment Terminal - AMS1", 1]]),
      [],
      CATALOG
    );
    expect(built.blockers).toEqual([]);
    expect(ams1Qty(built.quoteLines)).toBe(4);
    expect(built.requiredTerminals.qty).toBe(3);
  });

  it("does not add an AMS1 for a kiosk that already includes one", () => {
    const built = buildQuote("order_pay_only", picked([["Kiosk 27\" + Payment Terminal (AMS1) and Mount", 2]]), [], CATALOG);
    expect(ams1Qty(built.quoteLines)).toBe(0);
    expect(built.requiredTerminals.qty).toBe(0);
  });

  it("counts both tablets as screens toward the software license", () => {
    const built = buildQuote(
      "all_in_one",
      picked([["POS Unit", 2], ["Orders Hub Tablet", 2], ["Clock in Tablet", 1]]),
      [],
      CATALOG
    );
    expect(built.softwareLicense.screens).toBe(5);
    expect(built.softwareLicense.lines.map(l => [l.name, l.qty])).toEqual([["Additional Software License", 1]]);
    // Still not ordering points.
    expect(built.orderPoints.total).toBe(2);
  });

  it("adds a software license only past four screens", () => {
    const four = buildQuote(
      "all_in_one",
      picked([["POS Unit", 2], ["Mega Kiosk", 1], ["Menu Board Computer", 1]]),
      [],
      CATALOG
    );
    expect(four.softwareLicense.screens).toBe(INCLUDED_SCREEN_COUNT);
    expect(four.softwareLicense.lines).toEqual([]);
    expect(four.totals.recurring).toEqual([{ frequency: "monthly", amount: 399 }]);

    const five = buildQuote(
      "all_in_one",
      picked([["POS Unit", 2], ["Mega Kiosk", 1], ["Menu Board Computer", 1], ["mPOS", 1]]),
      [],
      CATALOG
    );
    expect(five.softwareLicense.lines.map(l => [l.name, l.qty, l.unitPrice])).toEqual([
      ["Additional Software License", 1, 19],
    ]);
    expect(five.totals.recurring).toEqual([{ frequency: "monthly", amount: 418 }]);

    const seven = buildQuote(
      "order_pay_only",
      picked([
        ["POS Unit", 2],
        ["POS Unit - With Customer Facing Display", 1],
        ["Mega Kiosk", 1],
        ["Menu Board Computer", 1],
        ["mPOS", 1],
        ["Kiosk 27\" + Payment Terminal (AMS1) and Mount", 1],
      ]),
      [],
      CATALOG
    );
    expect(seven.softwareLicense.screens).toBe(7);
    expect(seven.softwareLicense.lines[0].qty).toBe(3);
    // 299 platform + 3 × 19.
    expect(seven.totals.recurring).toEqual([{ frequency: "monthly", amount: 356 }]);
  });

  it("leaves a rate-only quote without a terminal, a license, or WiFi", () => {
    const built = buildQuote("all_in_one", [], [], CATALOG);
    expect(built.quoteLines).toEqual([]);
    expect(built.requiredTerminals).toEqual({ lines: [], missing: [], qty: 0 });
    expect(built.softwareLicense).toEqual({ lines: [], missing: [], screens: 0 });
  });

  it("does not treat a channel-only quote as having removed WiFi", () => {
    const built = buildQuote("all_in_one", [], ["website"], CATALOG);
    expect(adjustmentsFromQuoteLines(built.quoteLines, "all_in_one")[WIFI_PRODUCT_ID]).toBeUndefined();
  });

  it("keeps a removed WiFi package off through a reopen", () => {
    const adjustments = { [WIFI_PRODUCT_ID]: { removed: true as const } };
    const first = buildQuote("all_in_one", picked([["POS Unit", 1]]), [], CATALOG, adjustments);
    expect(first.quoteLines.map(l => l.name)).not.toContain("AIO WiFi Network Package");
    expect(first.includedServices.missing).toEqual([]);
    expect(first.quoteLines.map(l => l.name)).toContain("Onsite Installation");

    const reopened = adjustmentsFromQuoteLines(first.quoteLines, "all_in_one");
    expect(reopened[WIFI_PRODUCT_ID]).toEqual({ removed: true });
    const picks = picksFromQuoteLines(first.quoteLines, "all_in_one");
    expect(picks).toEqual([{ hubspotProductId: find("POS Unit").hubspotProductId, qty: 1 }]);

    const second = buildQuote(
      "all_in_one",
      picks.map(pick => toQuoteLine(CATALOG.find(c => c.hubspotProductId === pick.hubspotProductId)!, pick.qty)),
      [],
      CATALOG,
      reopened
    );
    expect(second.quoteLines).toEqual(first.quoteLines);
  });

  it("blocks when the AMS1 or the license is missing from the catalog", () => {
    const noTerminal = CATALOG.filter(c => c.hubspotProductId !== AMS1_PRODUCT.hubspotProductId);
    const terminal = buildQuote("all_in_one", picked([["POS Unit", 1]]), [], noTerminal);
    expect(terminal.blockers.join(" ")).toContain(AMS1_PRODUCT.name);

    const noLicense = CATALOG.filter(c => c.name !== "Additional Software License");
    const license = buildQuote(
      "all_in_one",
      picked([["POS Unit", 2], ["Mega Kiosk", 1], ["Menu Board Computer", 1], ["mPOS", 1]]),
      [],
      noLicense
    );
    expect(license.blockers.join(" ")).toContain("Additional Software License");
  });

  it("drops kits, the hardware bundle, and derived AMS1 when a processing quote is reopened", () => {
    const lines = [
      line("POS Unit", 2),
      line("Payment Terminal - AMS1", 3),
      line("Marketing Kit - Mega Kiosk", 1),
      line("QSR POS Hardware Bundle", 1),
      line("Additional Software License", 2),
    ];
    expect(picksFromQuoteLines(lines, "all_in_one")).toEqual([
      { hubspotProductId: find("POS Unit").hubspotProductId, qty: 2 },
      { hubspotProductId: AMS1_PRODUCT.hubspotProductId, qty: 1 },
    ]);
  });

  it("leaves a marketing quote's kit as a pick", () => {
    const lines = [line("Marketing Kit - Mega Kiosk", 1)];
    expect(picksFromQuoteLines(lines, "marketing_only")).toEqual([
      { hubspotProductId: find("Marketing Kit - Mega Kiosk").hubspotProductId, qty: 1 },
    ]);
  });
});
