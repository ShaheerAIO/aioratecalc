import { describe, it, expect } from "vitest";
import {
  FOOD_TRUCK_PLATFORM_NAME,
  INCLUDED_SERVICE_PRODUCTS,
  MARKETING_PRODUCTS,
  ORDER_POINT_RULES,
  PICKER_EXCLUDED_PRODUCT_NAMES,
  PLATFORM_TIER_PRODUCT_NAMES,
  UNCATEGORIZED_GROUP,
  buildQuote,
  deriveOrderPoints,
  groupProducts,
  isAllowedForQuoteType,
  isPickable,
  picksFromQuoteLines,
  platformTierNameFor,
  quoteTotals,
  quoteTypeOf,
  resolveIncludedServices,
  resolvePlatformLine,
  toQuoteLine,
} from "@/lib/quoting";
import type { CatalogProduct, QuoteLine } from "@/types/merchant";

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
  p("217526517443", PLATFORM_TIER_PRODUCT_NAMES.small, 99, "weekly", "Software"),
  p("292286544587", PLATFORM_TIER_PRODUCT_NAMES.large, 199, "weekly", "Software"),
  p("247900575472", "AIO Platform - Food Truck", 75, "weekly", "Software"),
  p("223152695997", "AIO Marketing Platform", 49, "weekly", "Software"),
  p("303779019494", "AIO - Automated Review Manager", 39, "monthly", "Software"),
  p("217445755632", "POS Unit", 749, "one_time", "inventory"),
  p("223452690130", "POS Unit - With Customer Facing Display", 949, "one_time", "inventory"),
  p("260674226888", "Mega Kiosk", 2459, "one_time", "inventory"),
  p("222497165009", "Kiosk + Payment Terminal (AMS1) and Mount", 999, "one_time", "inventory"),
  p("223511653101", "mPOS", 349, "one_time", "inventory"),
  p("223511653105", "Payment Terminal - AMS1", 99, "one_time", "inventory"),
  p("222497165011", "Cash Drawer", 69, "one_time", "inventory"),
  p("276751313619", "Orders Hub Tablet", 199, "one_time", "inventory"),
  p("276754193118", "Clock in Tablet", 199, "one_time", "inventory"),
  p("247901295335", "AIO Marketing Add Spend", 99, "monthly", "Service"),
  p("252941875920", "QSR POS Hardware Bundle", 1110, "one_time", "inventory"),
  // The three always-included services.
  p("281351401209", "AIO WiFi Network Package", 999, "one_time", "inventory"),
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  p("318731436770", "CAMP Invoice", 300, "one_time", ""),
  p("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
  p("260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"),
  p("316076031729", "Small TV (32in to 43in)", 299, "one_time", ""),
];

const find = (name: string) => CATALOG.find(c => c.name === name)!;
const line = (name: string, qty: number) => toQuoteLine(find(name), qty);

describe("picker exclusions", () => {
  it("hides the placeholders, CAMP Invoice, the pre-auth, and every derived line", () => {
    const hidden = CATALOG.filter(c => !isPickable(c)).map(c => c.name).sort();
    expect(hidden).toEqual([
      "AIO Platform (1 to 5 Order Points)",
      "AIO Platform (6 + Order Points)",
      "AIO Platform - Food Truck",
      "AIO Pre Auth",
      "AIO Processing Two Tiered Rate",
      "AIO WiFi Network Package",
      "CAMP Invoice",
      "Onsite Installation",
      "System Onboarding and Training",
    ]);
  });

  it("hides the food-truck platform, which is now derived from the quote type", () => {
    // It used to be pickable, with resolvePlatformTier sniffing the lines for it.
    // A rep picking it by hand is how a quote ends up with two platform fees.
    expect(isPickable(find(FOOD_TRUCK_PLATFORM_NAME))).toBe(false);
  });

  it("hides the three always-included services — they are added, not chosen", () => {
    for (const s of INCLUDED_SERVICE_PRODUCTS) {
      expect(isPickable(find(s.name))).toBe(false);
    }
  });

  it("keeps ordinary hardware and software quotable", () => {
    expect(isPickable(find("POS Unit"))).toBe(true);
    expect(isPickable(find("AIO Marketing Platform"))).toBe(true);
  });

  it("names the exclusions rather than inlining them", () => {
    expect([...PICKER_EXCLUDED_PRODUCT_NAMES]).toContain("CAMP Invoice");
  });
});

describe("quote types", () => {
  it("reads a row written before quote types existed as a full-POS deal", () => {
    expect(quoteTypeOf(null)).toBe("full_pos");
    expect(quoteTypeOf(undefined)).toBe("full_pos");
    expect(quoteTypeOf("marketing_only")).toBe("marketing_only");
  });

  it("lets a POS quote carry marketing products, but not the reverse", () => {
    // A restaurant buying marketing alongside its POS is one deal, not two
    // quotes — so only marketing-only restricts anything.
    expect(isAllowedForQuoteType(find("AIO Marketing Platform"), "full_pos")).toBe(true);
    expect(isAllowedForQuoteType(find("POS Unit"), "marketing_only")).toBe(false);
    expect(isAllowedForQuoteType(find("Mega Kiosk"), "marketing_only")).toBe(false);
  });

  it("allows exactly the two marketing products on a marketing-only quote", () => {
    const allowed = CATALOG.filter(c => isAllowedForQuoteType(c, "marketing_only")).map(c => c.name).sort();
    expect(allowed).toEqual([...MARKETING_PRODUCTS].map(m => m.name).sort());
  });

  it("does not treat the Review Manager as marketing", () => {
    // It's reputation management sold with a POS, not a marketing product.
    expect(isAllowedForQuoteType(find("AIO - Automated Review Manager"), "marketing_only")).toBe(false);
    expect(isAllowedForQuoteType(find("AIO - Automated Review Manager"), "full_pos")).toBe(true);
  });
});

describe("always-included services", () => {
  const SOMETHING = [line("POS Unit", 1)];

  it("puts a network, an install and a training on any quote with products, one each", () => {
    for (const quoteType of ["full_pos", "food_truck"] as const) {
      const { lines, missing } = resolveIncludedServices(quoteType, SOMETHING, CATALOG);
      expect(missing).toEqual([]);
      expect(lines.map(l => l.name)).toEqual([
        "AIO WiFi Network Package",
        "Onsite Installation",
        "System Onboarding and Training",
      ]);
      expect(lines.every(l => l.qty === 1)).toBe(true);
      expect(quoteTotals(lines).oneTime).toBe(999 + 999 + 499);
    }
  });

  it("adds none of them to a marketing-only quote — nothing is being installed", () => {
    expect(resolveIncludedServices("marketing_only", SOMETHING, CATALOG)).toEqual({ lines: [], missing: [] });
  });

  it("adds none of them to a rate-only quote — no products means nothing to install", () => {
    expect(resolveIncludedServices("full_pos", [], CATALOG)).toEqual({ lines: [], missing: [] });
    expect(resolveIncludedServices("food_truck", [], CATALOG)).toEqual({ lines: [], missing: [] });
  });

  it("attaches to products, not to declared channels", () => {
    // A website-ordering merchant has no on-site anything for a $999 install or
    // a $999 WiFi package to cover, even though the channel does carry a
    // platform fee.
    const built = buildQuote("full_pos", [], ["website"], CATALOG);
    expect(built.orderPoints.total).toBe(1);
    expect(built.platform.status).toBe("resolved");
    expect(built.includedServices.lines).toEqual([]);
    expect(built.quoteLines.map(l => l.name)).toEqual([PLATFORM_TIER_PRODUCT_NAMES.small]);
  });

  it("is LOUD when a required service isn't in the catalog", () => {
    // Silently dropping it is $999 off the quote, so it has to block the send
    // rather than read as "not included."
    const without = CATALOG.filter(c => c.name !== "Onsite Installation");
    const { lines, missing } = resolveIncludedServices("full_pos", SOMETHING, without);
    expect(missing).toEqual(["Onsite Installation"]);
    expect(lines.map(l => l.name)).not.toContain("Onsite Installation");
  });

  it("finds a service by product id, so a HubSpot rename can't drop it", () => {
    const renamed = CATALOG.map(c =>
      c.name === "Onsite Installation" ? { ...c, name: "On-Site Installation (2026)" } : c
    );
    const { lines, missing } = resolveIncludedServices("full_pos", SOMETHING, renamed);
    expect(missing).toEqual([]);
    expect(lines.find(l => l.hubspotProductId === "223452690133")!.unitPrice).toBe(999);
  });
});

describe("groupProducts", () => {
  const groups = groupProducts(CATALOG.filter(isPickable));

  it("orders hardware, software, service, then the untyped bucket", () => {
    expect(groups.map(g => g.label)).toEqual(["Hardware", "Software", "Service", UNCATEGORIZED_GROUP]);
  });

  it("never silently hides an untyped product", () => {
    const uncategorized = groups.find(g => g.type === UNCATEGORIZED_GROUP)!;
    expect(uncategorized.products.map(x => x.name)).toContain("Small TV (32in to 43in)");
  });
});

describe("quoteTotals — frequency-aware, never merged", () => {
  it("keeps a weekly platform fee and a one-time POS unit as separate numbers", () => {
    // E2E-PLAN.md's Phase C verify case.
    const lines = [line(PLATFORM_TIER_PRODUCT_NAMES.small, 1), line("POS Unit", 1)];
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
      line(PLATFORM_TIER_PRODUCT_NAMES.small, 1),   // $99/wk
      line("AIO Marketing Platform", 1),            // $49/wk
      line("AIO - Automated Review Manager", 1),    // $39/mo
    ];
    const t = quoteTotals(lines);

    expect(t.recurring).toEqual([
      { frequency: "weekly", amount: 148 },
      { frequency: "monthly", amount: 39 },
    ]);
    // 148 x 52/12 + 39 — the only legitimate way to combine the two cycles.
    expect(t.monthlyEquivalent).toBeCloseTo(148 * (52 / 12) + 39, 10);
    expect(t.recurring.some(r => r.amount === 187)).toBe(false);
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
    const catalogNow = [p("217526517443", PLATFORM_TIER_PRODUCT_NAMES.small, 99, "weekly", "Software")];
    const quoted = toQuoteLine(catalogNow[0], 1);

    // HubSpot raises the platform fee after the quote went out.
    catalogNow[0] = { ...catalogNow[0], price: 129, billingFrequency: "monthly" };

    expect(quoted.unitPrice).toBe(99);
    expect(quoted.billingFrequency).toBe("weekly");
    expect(quoteTotals([quoted]).recurring).toEqual([{ frequency: "weekly", amount: 99 }]);
  });
});

describe("deriveOrderPoints", () => {
  it("counts 3 POS + 2 kiosks + a website as 6 and flips to the 6+ tier", () => {
    // The plan's own verify case.
    const lines = [line("POS Unit", 3), line("Mega Kiosk", 2)];
    const { orderPoints } = deriveOrderPoints(lines, ["website"]);

    expect(orderPoints.hardware).toEqual({ "POS Unit": 3, "Mega Kiosk": 2 });
    expect(orderPoints.channels).toEqual(["website"]);
    expect(orderPoints.total).toBe(6);
    expect(platformTierNameFor(6)).toBe(PLATFORM_TIER_PRODUCT_NAMES.large);

    const tier = resolvePlatformLine("full_pos", orderPoints.total, CATALOG);
    expect(tier.status).toBe("resolved");
    expect(tier.line!.name).toBe(PLATFORM_TIER_PRODUCT_NAMES.large);
    expect(tier.line!.unitPrice).toBe(199);
    expect(tier.line!.billingFrequency).toBe("weekly");
  });

  it("stays on the 1-5 tier at exactly 5", () => {
    const lines = [line("POS Unit", 3), line("mPOS", 1)];
    const { orderPoints } = deriveOrderPoints(lines, ["website"]);
    expect(orderPoints.total).toBe(5);
    expect(platformTierNameFor(5)).toBe(PLATFORM_TIER_PRODUCT_NAMES.small);
    expect(resolvePlatformLine("full_pos", 5, CATALOG).line!.unitPrice).toBe(99);
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
    expect(platformTierNameFor(orderPoints.total)).toBe(PLATFORM_TIER_PRODUCT_NAMES.large);
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
    const lines = [line("Payment Terminal - AMS1", 4), line("Cash Drawer", 2), line("Small TV (32in to 43in)", 1)];
    const { orderPoints, unclassified } = deriveOrderPoints(lines, []);
    expect(orderPoints.total).toBe(0);
    // All three are known rules at 0 points, so none of them is a mystery —
    // including the TV, which carries no hs_product_type live.
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
      [line("Onsite Installation", 1), line("AIO Marketing Platform", 1)], []
    );
    expect(unclassified).toEqual([]);
  });
});

describe("platform line selection", () => {
  it("selects nothing at zero order points", () => {
    expect(platformTierNameFor(0)).toBeNull();
    expect(resolvePlatformLine("full_pos", 0, CATALOG))
      .toEqual({ status: "none_needed", line: null, productName: null });
  });

  it("gives a food-truck quote the flat platform fee, whatever the point count", () => {
    for (const total of [0, 1, 9]) {
      const platform = resolvePlatformLine("food_truck", total, CATALOG);
      expect(platform.status).toBe("resolved");
      expect(platform.line!.name).toBe(FOOD_TRUCK_PLATFORM_NAME);
      expect(platform.line!.unitPrice).toBe(75);
    }
  });

  it("gives a marketing-only quote no platform line at all", () => {
    expect(resolvePlatformLine("marketing_only", 4, CATALOG))
      .toEqual({ status: "not_applicable", line: null, productName: null });
  });

  it("finds the tier by product id, so a HubSpot rename can't drop the platform fee", () => {
    const renamed = CATALOG.map(c =>
      c.name === PLATFORM_TIER_PRODUCT_NAMES.large ? { ...c, name: "AIO Platform (6+ Ordering Points)" } : c
    );
    const tier = resolvePlatformLine("full_pos", 6, renamed);
    expect(tier.status).toBe("resolved");
    expect(tier.line!.unitPrice).toBe(199);
  });

  it("is LOUD, not null, when a tier is owed but the catalog can't supply it", () => {
    // Silently omitting this line is a $433/mo hole in the quote, so the caller
    // has to be forced to deal with it rather than reading it as "no fee due".
    const tier = resolvePlatformLine("full_pos", 3, []);
    expect(tier.status).toBe("unresolved");
    expect(tier.line).toBeNull();
    expect(tier.productName).toBe(PLATFORM_TIER_PRODUCT_NAMES.small);
  });
});

describe("buildQuote — the one derivation", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));

  it("assembles a full-POS quote: platform line, the three services, then the picks", () => {
    const built = buildQuote("full_pos", picked([["POS Unit", 2], ["Cash Drawer", 1]]), ["website"], CATALOG);

    expect(built.blockers).toEqual([]);
    expect(built.orderPoints.total).toBe(3); // 2 POS + website
    expect(built.quoteLines.map(l => l.name)).toEqual([
      PLATFORM_TIER_PRODUCT_NAMES.small,
      "AIO WiFi Network Package",
      "Onsite Installation",
      "System Onboarding and Training",
      "POS Unit",
      "Cash Drawer",
    ]);
    // 999 + 999 + 499 + 2×749 + 69 = $4,064 due once; the platform fee is weekly.
    expect(built.totals.oneTime).toBe(4064);
    expect(built.totals.recurring).toEqual([{ frequency: "weekly", amount: 99 }]);
  });

  it("drops declared channels on a marketing-only quote", () => {
    // Otherwise ticking "website / online ordering" conjures a $99/wk platform
    // tier onto a $49/wk marketing quote.
    const built = buildQuote(
      "marketing_only",
      picked([["AIO Marketing Platform", 1]]),
      ["website", "qr"],
      CATALOG
    );

    expect(built.orderPoints).toEqual({ hardware: {}, channels: [], total: 0 });
    expect(built.platform.status).toBe("not_applicable");
    expect(built.quoteLines.map(l => l.name)).toEqual(["AIO Marketing Platform"]);
    expect(built.totals.oneTime).toBe(0);
    expect(built.blockers).toEqual([]);
  });

  it("leaves a rate-only quote empty — no products, so no install services", () => {
    const built = buildQuote("full_pos", [], [], CATALOG);
    expect(built.platform.status).toBe("none_needed");
    expect(built.quoteLines).toEqual([]);
    expect(built.totals.oneTime).toBe(0);
  });

  it("gives a food-truck quote its flat platform fee with nothing picked, and no services", () => {
    const built = buildQuote("food_truck", [], [], CATALOG);
    expect(built.quoteLines.map(l => l.name)).toEqual([FOOD_TRUCK_PLATFORM_NAME]);
    expect(built.totals.recurring).toEqual([{ frequency: "weekly", amount: 75 }]);
    expect(built.totals.oneTime).toBe(0);
  });

  it("puts nothing on a marketing-only quote with nothing picked", () => {
    expect(buildQuote("marketing_only", [], [], CATALOG).quoteLines).toEqual([]);
  });

  it("blocks the send when a required line can't be priced", () => {
    const stripped = CATALOG.filter(
      c => c.name !== "Onsite Installation" && c.name !== PLATFORM_TIER_PRODUCT_NAMES.small
    );
    const built = buildQuote("full_pos", picked([["POS Unit", 1]]), [], stripped);

    expect(built.blockers).toHaveLength(2);
    expect(built.blockers.join(" ")).toContain(PLATFORM_TIER_PRODUCT_NAMES.small);
    expect(built.blockers.join(" ")).toContain("Onsite Installation");
  });

  it("round-trips through picksFromQuoteLines without duplicating a derived line", () => {
    // Reopening a saved quote must not send the platform fee or the services
    // back as picks — they'd be quoted twice, or refused as unpickable.
    const first = buildQuote("full_pos", picked([["Mega Kiosk", 1]]), [], CATALOG);
    const reopened = picksFromQuoteLines(first.quoteLines);

    expect(reopened).toEqual([{ hubspotProductId: "260674226888", qty: 1 }]);

    const second = buildQuote(
      "full_pos",
      reopened.map(pick => toQuoteLine(CATALOG.find(c => c.hubspotProductId === pick.hubspotProductId)!, pick.qty)),
      [],
      CATALOG
    );
    expect(second.quoteLines).toEqual(first.quoteLines);
  });
});
