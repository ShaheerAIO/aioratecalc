import { describe, it, expect, beforeAll } from "vitest";
import { PACKAGES } from "@/lib/quotePackages";
import {
  AMS1_PRODUCT,
  INCLUDED_SCREEN_COUNT,
  INCLUDED_SERVICE_PRODUCTS,
  WIFI_PRODUCT_ID,
  MARKETING_PRODUCTS,
  MARKETING_INCLUDED_HARDWARE,
  DEFAULT_UNIT_CAPS,
  PLANS_INCLUDING_WEBSITE,
  applyPlanIncludedHardware,
  applyPlanIncludedWebsite,
  maxQtyFor,
  minimumTerminalsFor,
  planIncludesWebsite,
  PROCESSING_DISCLOSURE_PRODUCT,
  ORDER_POINT_RULES,
  PICKER_EXCLUDED_PRODUCT_NAMES,
  PLATFORM_PRODUCTS,
  QUOTE_TYPES,
  UNCATEGORIZED_GROUP,
  buildQuote,
  deriveOrderPoints,
  groupProducts,
  isAllowedForQuoteType,
  isHiddenPick,
  isPickable,
  isProcessingQuote,
  adjustmentsFromQuoteLines,
  picksFromQuoteLines,
  quoteHasProcessing,
  quoteTotals,
  quoteTypeOf,
  resolveIncludedServices,
  resolvePlatformLine,
  toQuoteLine,
  processesCardNotPresentOnly,
  processingDisclosureText,
  PAYROLL_PRODUCT_ID,
  payrollBlockers,
} from "@/lib/quoting";
import type { CatalogProduct, QuoteAdjustments, QuoteLine, QuoteType } from "@/types/merchant";

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
  // Marketing Partial Ordering and its two $0 lines.
  p("343582047937", "AIO Marketing Partial Ordering", 299, "monthly", "Software"),
  p("343374665412", "Online Ordering", 0, "monthly", "Software"),
  p("343579168455", "Marketing (Partial Ordering)", 0, "monthly", ""),
  p("343373224660", "Mega Kiosk Loaner", 100, "monthly", "inventory"),
  // The retired 2-year plan's two records (`marketing_term`, 2026-10-06 to
  // 2026-10-27). Saved quotes still carry them.
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
  p("223519571666", "Kiosk Mini 15.6\" + Payment Terminal (AMS1) and Mount", 1195, "one_time", "inventory"),
  p("223452690132", "KDS (Kitchen Display System)", 735, "one_time", "inventory"),
  p("223511653104", "Thermal Printer", 295, "one_time", "inventory"),
  p("335279520447", "AIO Tableside POS", 399, "one_time", ""),
  p("223511653101", "mPOS", 349, "one_time", "inventory"),
  p("223511653105", "Payment Terminal - AMS1", 300, "one_time", "inventory"),
  p("222497165011", "Cash Drawer", 69, "one_time", "inventory"),
  p("318736467644", "Customer Facing Display", 299, "one_time", "inventory"),
  p("276751313619", "Orders Hub Tablet", 199, "one_time", "inventory"),
  p("276754193118", "Clock in Tablet", 199, "one_time", "inventory"),
  p("252941875920", "QSR POS Hardware Bundle", 1110, "one_time", "inventory"),
  // The three always-included services.
  p("338690209525", "AIO Wifi Network Package - Unifi", 698, "one_time", "inventory"),
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  p("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
  p("260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"),
];

// Nothing in today's catalog bills weekly — every platform product that did is
// deactivated. Published quotes still carry those lines, so `quoteTotals` has
// to keep getting the 52/12 conversion right; this is the fixture for that.
const RETIRED_WEEKLY_PLATFORM = p("217526517443", "AIO Platform (1 to 5 Order Points)", 99, "weekly", "Software");

// The $0 rate-disclosure line. On EVERY quote AIO processes for since
// 2026-10-14, appended past every adjustment — so it shows up at the end
// of most built line sets in this file.
const RATE_LINE = PROCESSING_DISCLOSURE_PRODUCT.name;

const find = (name: string) => CATALOG.find(c => c.name === name)!;
const line = (name: string, qty: number) => toQuoteLine(find(name), qty);

describe("picker exclusions", () => {
  it("hides the placeholders, the pre-auth, and every derived line", () => {
    const hidden = CATALOG.filter(c => !isPickable(c)).map(c => c.name).sort();
    expect(hidden).toEqual([
      "AIO Marketing Partial Ordering",
      "AIO Marketing Platform",
      // Both 2-year records, retired with their plan. Neither may be picked.
      "AIO Marketing Platform (2-year term)",
      "AIO Marketing Platform (2-year term)",
      "AIO Pre Auth",
      "AIO Processing Two Tiered Rate",
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
      expect(isPickable(find(plan.name)), plan.name).toBe(false);
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

  it("offers the Unifi WiFi package (2026-10-21, like a KDS)", () => {
    const wifi = find("AIO Wifi Network Package - Unifi");
    expect(isPickable(wifi)).toBe(true);
    expect(isAllowedForQuoteType(wifi, "all_in_one")).toBe(true);
  });

  it("never offers the individual network components; the WiFi package line stands for them", () => {
    const ids: Array<[string, string]> = [
      ["338693809894", "Unifi Router"], ["338693090009", "Unifi 8 Port Switch"],
      ["338616220368", "Unifi Access Point"], ["338615500489", "Unifi U-LTE Backup Pro"],
      ["338690930367", "Pronto Router + LTE Backup"], ["338690209526", "Pronto 8 Port Switch"],
      ["338691650250", "AIO Wifi Network Package - Pronto"],
    ];
    for (const [id, name] of ids) {
      const prod = p(id, name, 100, "one_time", "inventory");
      expect(isPickable(prod), name).toBe(false);
      expect(isAllowedForQuoteType(prod, "all_in_one"), name).toBe(false);
      // A saved quote that carried one must not hand it back as a pick.
      expect(picksFromQuoteLines([toQuoteLine(prod, 1)], "all_in_one"), name).toEqual([]);
    }
  });

  it("names the exclusions rather than inlining them", () => {
    expect([...PICKER_EXCLUDED_PRODUCT_NAMES]).toContain("CAMP Invoice");
  });
});

describe("quote types", () => {
  it("shows All-in-One, Order & Pay Only, Marketing Partial Ordering, then Marketing Only", () => {
    expect(QUOTE_TYPES.map(t => t.id)).toEqual([
      "all_in_one", "order_pay_only", "marketing_partial", "marketing_only",
    ]);
  });

  it("maps the retired values onto the plan that replaced them", () => {
    // Their platform products are deactivated in HubSpot, so a row left on one
    // couldn't resolve a platform line at all. All-in-One is the successor.
    expect(quoteTypeOf("full_pos")).toBe("all_in_one");
    expect(quoteTypeOf("food_truck")).toBe("all_in_one");
    expect(quoteTypeOf(null)).toBe("all_in_one");
    expect(quoteTypeOf(undefined)).toBe("all_in_one");
    expect(quoteTypeOf("order_pay_only")).toBe("order_pay_only");
    expect(quoteTypeOf("marketing_only")).toBe("marketing_only");
    expect(quoteTypeOf("marketing_partial")).toBe("marketing_partial");
    // The 2-year kiosk plan, retired 2026-10-27: Marketing Only + a Loaner.
    expect(quoteTypeOf("marketing_term")).toBe("marketing_only");
  });

  it("lets a POS quote carry the Website and a Mega, but not the 27\" Marketing Kit", () => {
    expect(isAllowedForQuoteType(find("Website"), "all_in_one")).toBe(true);
    // A Mega goes on any plan since 2026-10-27, bought or on loan.
    expect(isAllowedForQuoteType(find("Marketing Kit - Mega Kiosk"), "all_in_one")).toBe(true);
    expect(isAllowedForQuoteType(find("Mega Kiosk Loaner"), "order_pay_only")).toBe(true);
    expect(isAllowedForQuoteType(find("Marketing Kit - 27\" Kiosk"), "all_in_one")).toBe(false);
    expect(isAllowedForQuoteType(find("QSR POS Hardware Bundle"), "all_in_one")).toBe(false);
    expect(isAllowedForQuoteType(find("POS Unit"), "marketing_only")).toBe(false);
    expect(isAllowedForQuoteType(find("Mega Kiosk"), "marketing_only")).toBe(false);
    // The plan includes three of these free, but they are a PICK — a
    // merchant can want none, or want five and pay for the other two.
    expect(isAllowedForQuoteType(find("Menu Board Computer"), "marketing_only")).toBe(true);
  });

  it("hides the Mega Kiosk Loaner from the picker on the two POS plans only — still allowed, so a draft saves (2026-10-29)", () => {
    const loaner = find("Mega Kiosk Loaner");
    for (const plan of ["order_pay_only", "all_in_one"] as const) {
      expect(isHiddenPick(loaner.hubspotProductId, plan), plan).toBe(true);
      expect(isAllowedForQuoteType(loaner, plan), plan).toBe(true);
    }
    for (const plan of ["marketing_only", "marketing_partial"] as const) {
      expect(isHiddenPick(loaner.hubspotProductId, plan), plan).toBe(false);
      expect(isAllowedForQuoteType(loaner, plan), plan).toBe(true);
    }
    // The plan-wide retirements still hide everywhere; the Mega bought is still offered.
    expect(isHiddenPick("332793212658", "marketing_only")).toBe(true);
    expect(isHiddenPick(find("Marketing Kit - Mega Kiosk").hubspotProductId, "all_in_one")).toBe(false);
  });

  it("allows exactly the marketing products on a marketing-only quote", () => {
    const allowed = CATALOG.filter(c => isAllowedForQuoteType(c, "marketing_only"))
      .map(c => c.hubspotProductId).sort();
    expect(allowed).toEqual(MARKETING_PRODUCTS.map(m => m.hubspotProductId).sort());
  });

  it("keeps online ordering off Marketing Only, and the marketing line on Partial Ordering alone", () => {
    expect(isAllowedForQuoteType(find("Online Ordering"), "marketing_only")).toBe(false);
    for (const plan of ["marketing_partial", "order_pay_only", "all_in_one"] as const) {
      expect(isAllowedForQuoteType(find("Online Ordering"), plan), plan).toBe(true);
    }
    expect(isAllowedForQuoteType(find("Marketing (Partial Ordering)"), "marketing_partial")).toBe(true);
    for (const plan of ["marketing_only", "order_pay_only", "all_in_one"] as const) {
      expect(isAllowedForQuoteType(find("Marketing (Partial Ordering)"), plan), plan).toBe(false);
    }
  });

  it("allows ordering without a POS on Marketing Partial Ordering, and no POS of any kind", () => {
    const allowed = CATALOG.filter(c => isAllowedForQuoteType(c, "marketing_partial")).map(c => c.name).sort();
    expect(allowed).toEqual([
      "KDS (Kitchen Display System)",
      "Kiosk 27\" + Payment Terminal (AMS1) and Mount",
      "Kiosk Mini 15.6\" + Payment Terminal (AMS1) and Mount",
      "Marketing (Partial Ordering)",
      "Marketing Kit - Mega Kiosk",
      "Mega Kiosk Loaner",
      "Menu Board Computer",
      "Online Ordering",
      "Orders Hub Tablet",
      "Payment Terminal - AMS1",
      "Thermal Printer",
      "AIO Wifi Network Package - Unifi",
      "Website",
    ].sort());
  });

  it("derives the software license instead of offering it as a pick", () => {
    expect(isAllowedForQuoteType(find("Additional Software License"), "marketing_only")).toBe(false);
    expect(isAllowedForQuoteType(find("Additional Software License"), "all_in_one")).toBe(false);
  });
});

describe("always-included services", () => {
  const SOMETHING = [line("POS Unit", 1)];

  it("puts an install and a training on any quote with products, one each", () => {
    for (const quoteType of ["order_pay_only", "all_in_one"] as const) {
      const { lines, missing } = resolveIncludedServices(quoteType, SOMETHING, CATALOG);
      expect(missing).toEqual([]);
      expect(lines.map(l => l.name)).toEqual([
        "Onsite Installation",
        "System Onboarding and Training",
      ]);
      expect(lines.every(l => l.qty === 1)).toBe(true);
      // Both are comped to $0 again (2026-10-28). See COMPED_SERVICE_PRODUCT_IDS.
      expect(quoteTotals(lines).oneTime).toBe(0);
      expect(lines.map(l => l.discountPercent ?? 0)).toEqual([100, 100]);
    }
  });

  it("adds none of them to a marketing-only quote — nothing is being installed", () => {
    expect(resolveIncludedServices("marketing_only", SOMETHING, CATALOG)).toEqual({ lines: [], missing: [] });
  });

  it("installs and trains on a Marketing Partial Ordering quote with hardware (product owner, 2026-10-27)", () => {
    const { lines } = resolveIncludedServices("marketing_partial", [line("Orders Hub Tablet", 1)], CATALOG);
    expect(lines.map(l => l.name)).toEqual(["Onsite Installation", "System Onboarding and Training"]);
    // Online ordering alone puts nothing on site.
    expect(resolveIncludedServices("marketing_partial", [line("Online Ordering", 1)], CATALOG).lines).toEqual([]);
  });

  it("adds none of them to a rate-only quote — no products means nothing to install", () => {
    expect(resolveIncludedServices("all_in_one", [], CATALOG)).toEqual({ lines: [], missing: [] });
    expect(resolveIncludedServices("order_pay_only", [], CATALOG)).toEqual({ lines: [], missing: [] });
  });

  it("adds none of them to a software-only pick — a website has nothing on site to install", () => {
    const websiteOnly = [line("Website", 1)];
    expect(resolveIncludedServices("all_in_one", websiteOnly, CATALOG)).toEqual({ lines: [], missing: [] });
  });

  it("still attaches both when hardware is picked ALONGSIDE a website — one physical pick is enough", () => {
    const mixed = [line("POS Unit", 1), line("Website", 1)];
    const { lines, missing } = resolveIncludedServices("all_in_one", mixed, CATALOG);
    expect(missing).toEqual([]);
    expect(lines.map(l => l.name)).toEqual([
      "Onsite Installation",
      "System Onboarding and Training",
    ]);
  });

  it("attaches to products, not to declared channels", () => {
    // A QR-ordering merchant has no on-site anything for a $999 install or
    // a $999 install to cover, even though the channel does carry a
    // platform fee.
    const built = buildQuote("all_in_one", [], ["qr"], CATALOG);
    expect(built.orderPoints.total).toBe(1);
    expect(built.platform.status).toBe("resolved");
    expect(built.includedServices.lines).toEqual([]);
    // The $0 rate disclosure rides along on every quote AIO processes for
    // (2026-10-14). It bills nothing and installs nothing.
    expect(built.quoteLines.map(l => l.name)).toEqual(["All-in-One Platform", RATE_LINE]);
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

  // The class of break this guards against: AIO deactivated "AIO WiFi Network
  // Package" (281351401209) on 2026-10-13 with no replacement matching its id
  // OR its name, so `resolveIncludedServices` reported it `missing` and every
  // processing quote with a product picked could no longer be saved or sent.
  // This asserts every always-included service still resolves against a
  // representative catalog, so the NEXT such deactivation fails a test
  // instead of reaching production silently.
  it("resolves every INCLUDED_SERVICE_PRODUCTS id against the live catalog", () => {
    for (const service of INCLUDED_SERVICE_PRODUCTS) {
      const product = CATALOG.find(c => c.hubspotProductId === service.hubspotProductId);
      expect(product, `${service.name} (${service.hubspotProductId})`).toBeDefined();
      expect(product!.name).toBe(service.name);
    }
    const { missing } = resolveIncludedServices("all_in_one", SOMETHING, CATALOG);
    expect(missing).toEqual([]);
  });

  describe("the retired WiFi package (281351401209, replaced 2026-10-13)", () => {
    const RETIRED_WIFI = toQuoteLine(
      p("281351401209", "AIO WiFi Network Package", 999, "one_time", "inventory"),
      1
    );

    it("a fresh quote with hardware but no WiFi pick has no WiFi line", () => {
      const built = buildQuote("all_in_one", SOMETHING, [], CATALOG);
      expect(built.quoteLines.map(l => l.hubspotProductId)).not.toContain(WIFI_PRODUCT_ID);
      expect(built.includedServices.missing).toEqual([]);
    });

    it("a picked WiFi package is one line at the catalog price", () => {
      const built = buildQuote("all_in_one", [...SOMETHING, line("AIO Wifi Network Package - Unifi", 1)], [], CATALOG);
      const wifi = built.quoteLines.filter(l => l.hubspotProductId === WIFI_PRODUCT_ID);
      expect(wifi).toHaveLength(1);
      expect(wifi[0].unitPrice).toBe(698);
      expect(wifi[0].qty).toBe(1);
    });

    it("a saved quote carrying the retired $999 line reopens as a pick of the Unifi package", () => {
      const saved = [RETIRED_WIFI, line("POS Unit", 1), line("Onsite Installation", 1), line("System Onboarding and Training", 1)];
      const picks = picksFromQuoteLines(saved, "all_in_one");
      expect(picks).not.toContainEqual(expect.objectContaining({ hubspotProductId: "281351401209" }));
      expect(picks).toHaveLength(2);
      expect(picks).toContainEqual({ hubspotProductId: find("POS Unit").hubspotProductId, qty: 1 });
      expect(picks).toContainEqual({ hubspotProductId: WIFI_PRODUCT_ID, qty: 1 });
    });

    it("a saved quote carrying the CURRENT Unifi line reopens as a pick, not dropped", () => {
      const saved = [line("POS Unit", 1), line("AIO Wifi Network Package - Unifi", 1)];
      expect(picksFromQuoteLines(saved, "all_in_one")).toContainEqual({ hubspotProductId: WIFI_PRODUCT_ID, qty: 1 });
    });

    it("re-saving the retired-line quote re-derives the current Unifi line and raises no blocker", () => {
      const picks = picksFromQuoteLines([RETIRED_WIFI, line("POS Unit", 1)], "all_in_one");
      const built = buildQuote("all_in_one", picks.map(({ hubspotProductId, qty }) => toQuoteLine(CATALOG.find(c => c.hubspotProductId === hubspotProductId)!, qty)), [], CATALOG);
      expect(built.blockers).toEqual([]);
      expect(built.quoteLines.map(l => l.name)).not.toContain("AIO WiFi Network Package");
      expect(built.quoteLines.filter(l => l.name === "AIO Wifi Network Package - Unifi")).toHaveLength(1);
    });

    it("saved adjustments that still carry the retired `removed: true` are ignored, not a crash", () => {
      const legacy = { [WIFI_PRODUCT_ID]: { removed: true } } as unknown as QuoteAdjustments;
      const built = buildQuote("all_in_one", [...SOMETHING, line("AIO Wifi Network Package - Unifi", 1)], [], CATALOG, legacy);
      expect(built.quoteLines.map(l => l.hubspotProductId)).toContain(WIFI_PRODUCT_ID);
    });
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
  it("counts 3 POS + 2 kiosks + online ordering as 6, and the Website as nothing", () => {
    // Online ordering is the ordering point since 2026-10-27, not the Website
    // ("Website alone does not include online ordering").
    const lines = [line("POS Unit", 3), line("Mega Kiosk", 2), line("Online Ordering", 1), line("Website", 1)];
    const { orderPoints, unclassified } = deriveOrderPoints(lines, []);

    expect(orderPoints.hardware).toEqual({ "POS Unit": 3, "Mega Kiosk": 2, "Online Ordering": 1 });
    expect(orderPoints.channels).toEqual([]);
    expect(orderPoints.total).toBe(6);
    expect(unclassified).toEqual([]);
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

  it("ignores a stale 'website' channel on an old saved row", () => {
    // The channel chip went 2026-10-13; deriveOrderPoints drops any channel
    // id no longer in ORDER_POINT_CHANNELS.
    const { orderPoints } = deriveOrderPoints([line("Online Ordering", 1)], ["website"]);
    expect(orderPoints.total).toBe(1);
    expect(orderPoints.channels).toEqual([]);
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

  it("counts each declared channel once and only the known ones — including the retired 'website' id", () => {
    // "website" was retired as a channel 2026-10-13 (moved to the Website
    // product instead), so a saved row still carrying it must be dropped
    // exactly like any other unrecognised id, not crash and not count.
    const { orderPoints } = deriveOrderPoints([], ["website", "qr", "not_a_channel"]);
    expect(orderPoints.channels).toEqual(["qr"]);
    expect(orderPoints.total).toBe(1);
  });

  it("excludes payment terminals and cash drawers — non-ordering hardware", () => {
    // Website used to be in this list too (0 points, channel-counted instead),
    // but since 2026-10-13 it IS an ordering point — see its own tests above.
    const lines = [line("Payment Terminal - AMS1", 4), line("Cash Drawer", 2)];
    const { orderPoints, unclassified } = deriveOrderPoints(lines, []);
    expect(orderPoints.total).toBe(0);
    // Both are known rules at 0 points, so neither is a mystery.
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
      order_pay_only: 299, all_in_one: 399, marketing_only: 199, marketing_partial: 299,
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
    // A QR-ordering merchant with no hardware is on the platform. Unlike
    // the install services, which need something physical on site.
    const platform = resolvePlatformLine("all_in_one", [], ["qr"], CATALOG);
    expect(platform.status).toBe("resolved");
    expect(platform.line!.unitPrice).toBe(399);
  });

  it("a website-only merchant now expresses it by picking the Website PRODUCT, and that is NOT rate-only", () => {
    // Since the "website / online ordering" channel chip was removed
    // (2026-10-13), the only way to declare a website is to pick the $50/mo
    // Website product. That makes pickedLines non-empty, so the rate-only
    // escape (`pickedLines.length === 0 && channels.length === 0`) never
    // fires — the quote correctly gets a platform line instead of reading as
    // "nothing picked, no plan due".
    const websiteOnly = [toQuoteLine(CATALOG.find(c => c.name === "Website")!, 1)];
    const platform = resolvePlatformLine("all_in_one", websiteOnly, [], CATALOG);
    expect(platform.status).toBe("resolved");
    expect(platform.line!.unitPrice).toBe(399);

    const built = buildQuote("all_in_one", websiteOnly, [], CATALOG);
    expect(built.blockers).toEqual([]);
    expect(built.platform.status).toBe("resolved");
    // A website takes no orders since 2026-10-27, so it counts no point.
    expect(built.orderPoints.total).toBe(0);
    // FIXED (was a KNOWN GAP): picking the Website product is now the ONLY
    // way to declare a website on a processing quote, which made
    // `pickedLines` non-empty for a merchant with nothing physically on
    // site. `resolveIncludedServices` used to gate purely on
    // `pickedLines.length !== 0`, so a website-only quote wrongly picked up
    // the $698 WiFi package and the comped install/training pair. It now
    // gates on `hasPhysicalPick` (billingFrequency === "one_time"), so a
    // software-only pick like Website attaches none of them — same as the
    // retired channel-only path did.
    expect(built.quoteLines.map(l => l.name)).toEqual([
      "All-in-One Platform",
      "Website",
      RATE_LINE,
    ]);
    expect(built.totals.oneTime).toBe(0);
  });

  it("finds Marketing Partial Ordering's plan by NAME until its HubSpot id is filled in", () => {
    const platform = resolvePlatformLine("marketing_partial", SOME_PICK, [], CATALOG);
    expect(platform.status).toBe("resolved");
    expect(platform.line!.unitPrice).toBe(299);
    // Before the record exists, the quote refuses rather than going out without a plan.
    const without = CATALOG.filter(c => c.name !== "AIO Marketing Partial Ordering");
    expect(resolvePlatformLine("marketing_partial", SOME_PICK, [], without).status).toBe("unresolved");
  });

  it("never leaves a marketing plan rate-only — there is no rate behind it", () => {
    // `none_needed` is for a processing quote with nothing on it. An empty
    // marketing quote is a subscription nobody has added to yet, and it bills.
    const platform = resolvePlatformLine("marketing_only", [], [], CATALOG);
    expect(platform.status).toBe("resolved");
    expect(platform.line!.unitPrice).toBe(199);
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

  it("assembles an All-in-One quote: platform line, the two services, then the picks", () => {
    const built = buildQuote("all_in_one", picked([["POS Unit", 2], ["Cash Drawer", 1]]), ["qr"], CATALOG);

    expect(built.blockers).toEqual([]);
    expect(built.orderPoints.total).toBe(3); // 2 POS + the QR channel
    expect(built.quoteLines.map(l => l.name)).toEqual([
      "All-in-One Platform",
      "Onsite Installation",
      "System Onboarding and Training",
      "POS Unit",
      "Cash Drawer",
      // One per POS unit, charged, on top of anything the rep picked.
      "Payment Terminal - AMS1",
      // Last, past every adjustment — see `resolveProcessingDisclosure`.
      RATE_LINE,
    ]);
    // 0 + 0 + 2×749 + 69 + 2×300 = $2,167 due once. Install and training are
    // both comped again since 2026-10-28.
    expect(built.totals.oneTime).toBe(2167);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 399 }]);
  });

  it("prices the same cart $100/mo lower on the Order & Pay plan", () => {
    const cart = picked([["POS Unit", 2], ["Cash Drawer", 1]]);
    const lesser = buildQuote("order_pay_only", cart, ["qr"], CATALOG);
    const full = buildQuote("all_in_one", cart, ["qr"], CATALOG);

    expect(lesser.totals.oneTime).toBe(full.totals.oneTime);
    expect(lesser.totals.recurring).toEqual([{ frequency: "monthly", amount: 299 }]);
    expect(full.totals.recurring).toEqual([{ frequency: "monthly", amount: 399 }]);
  });

  it("drops declared channels on a marketing-only quote", () => {
    // A marketing merchant isn't taking orders through AIO, so ticking
    // "QR code ordering" must not report an ordering point.
    const built = buildQuote(
      "marketing_only",
      picked([["Marketing Kit - Mega Kiosk", 1]]),
      ["qr", "third_party_delivery"],
      CATALOG
    );

    expect(built.orderPoints).toEqual({ hardware: {}, channels: [], total: 0 });
    expect(built.quoteLines.map(l => l.name)).toEqual([
      "AIO Marketing Platform",
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
    // The menu boards the plan includes are a PICK now, so an empty quote is
    // genuinely the plan alone — the configurator preselects three when the
    // plan is chosen, which is a UI default rather than a derivation.
    const built = buildQuote("marketing_only", [], [], CATALOG);
    expect(built.quoteLines.map(l => l.name)).toEqual(["AIO Marketing Platform"]);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 199 }]);
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

// ── Marketing ───────────────────────────────────────────────────────────────
// Marketing Only, and the marketing half of Marketing Partial Ordering. The
// 2-year kiosk plan was retired 2026-10-27 for the Mega Kiosk Loaner.
describe("marketing plans", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const MEGA = "Marketing Kit - Mega Kiosk";
  const KIOSK_27 = "Marketing Kit - 27\" Kiosk";

  it("holds the three Menu Board Computers Marketing Only includes at no charge", () => {
    const built = buildQuote("marketing_only", picked([["Menu Board Computer", 3], [MEGA, 1]]), [], CATALOG);
    const boards = built.quoteLines.filter(l => l.name === "Menu Board Computer");
    expect(boards.map(l => [l.qty, l.discountPercent ?? null, l.coveredByPackage ?? null])).toEqual([
      [3, 100, PLATFORM_PRODUCTS.marketing_only.name],
    ]);
    expect(quoteTotals(boards).oneTime).toBe(0);
  });

  it("holds them free on Marketing Partial Ordering only when the rep adds the marketing line", () => {
    const base = picked([["Online Ordering", 1], ["Menu Board Computer", 3]]);
    const without = buildQuote("marketing_partial", base, [], CATALOG);
    expect(without.quoteLines.filter(l => l.name === "Menu Board Computer").map(l => l.discountPercent ?? null))
      .toEqual([null]);

    const withMarketing = buildQuote(
      "marketing_partial", [...base, line("Marketing (Partial Ordering)", 1)], [], CATALOG
    );
    expect(withMarketing.quoteLines.filter(l => l.name === "Menu Board Computer")
      .map(l => [l.qty, l.discountPercent ?? null, l.coveredByPackage ?? null]))
      .toEqual([[3, 100, PLATFORM_PRODUCTS.marketing_partial.name]]);
    // $299 either way — the marketing line is $0.
    expect(withMarketing.totals.recurring).toEqual(without.totals.recurring);
  });

  it("bills the ones past the three the plan covers, as a SPLIT line", () => {
    // Not 3/5ths off the whole line: the percentage wouldn't divide, which is
    // the same reason a scoped discount splits rather than averages.
    const built = buildQuote("marketing_only", picked([["Menu Board Computer", 5]]), [], CATALOG);
    const boards = built.quoteLines.filter(l => l.name === "Menu Board Computer");
    expect(boards.map(l => [l.qty, l.discountPercent ?? null])).toEqual([[3, 100], [2, null]]);
    expect(built.totals.oneTime).toBe(99 * 2);
  });

  it("lets a marketing merchant take them all off", () => {
    const built = buildQuote("marketing_only", picked([[MEGA, 1]]), [], CATALOG);
    expect(built.quoteLines.some(l => l.name === "Menu Board Computer")).toBe(false);
  });

  it("gives a processing quote none of it — the computers are ordinary hardware there", () => {
    const lines = picked([["Menu Board Computer", 3]]);
    expect(applyPlanIncludedHardware("all_in_one", lines)).toEqual(lines);
    const built = buildQuote("all_in_one", lines, [], CATALOG);
    expect(built.quoteLines.filter(l => l.name === "Menu Board Computer")
      .map(l => [l.qty, l.discountPercent ?? null])).toEqual([[3, null]]);
  });

  it("loans a Mega for $100 a month on top of the plan — the retired 2-year plan's $299", () => {
    const built = buildQuote("marketing_only", picked([["Mega Kiosk Loaner", 1]]), [], CATALOG);
    expect(built.blockers).toEqual([]);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 299 }]);
    expect(built.totals.oneTime).toBe(0);
  });

  it("caps the marketing kits like the ordering kiosks they are", () => {
    // They were the one uncapped family until 2026-10-12.
    expect(maxQtyFor(find(MEGA).hubspotProductId)).toBe(6);
    expect(maxQtyFor(find(KIOSK_27).hubspotProductId)).toBe(6);
    expect(maxQtyFor(find("Mega Kiosk Loaner").hubspotProductId)).toBe(6);
  });

  it("charges for the same kiosk on the $199 plan", () => {
    const built = buildQuote("marketing_only", picked([[MEGA, 1]]), [], CATALOG);
    expect(built.blockers).toEqual([]);
    expect(built.totals.oneTime).toBe(1500);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 199 }]);
  });

  it("names the hardware the plan includes", () => {
    expect(MARKETING_INCLUDED_HARDWARE.map(h => h.hubspotProductId))
      .toEqual([find("Menu Board Computer").hubspotProductId]);
  });

  it("reopens a retired 2-year quote as Marketing Only with the kiosk it covered on loan", () => {
    // What a `marketing_term` row saved: the 2-year platform line, the kiosk
    // the plan covered, and a second kiosk the merchant bought.
    const covered: QuoteLine = {
      ...line(MEGA, 1), discountPercent: 100, coveredByPackage: "AIO Marketing Platform (2-year term)",
    };
    const saved = [line("AIO Marketing Platform (2-year term)", 1), covered, line(MEGA, 1)];
    const reopened = picksFromQuoteLines(saved, quoteTypeOf("marketing_term"));
    expect(reopened).toEqual([
      { hubspotProductId: find("Mega Kiosk Loaner").hubspotProductId, qty: 1 },
      { hubspotProductId: find(MEGA).hubspotProductId, qty: 1 },
    ]);

    const rebuilt = buildQuote(
      "marketing_only",
      reopened.map(pick => toQuoteLine(CATALOG.find(c => c.hubspotProductId === pick.hubspotProductId)!, pick.qty)),
      [], CATALOG
    );
    // The same money: $199 + $100 loan, and the bought kiosk at $1,500.
    expect(rebuilt.totals.recurring).toEqual([{ frequency: "monthly", amount: 299 }]);
    expect(rebuilt.totals.oneTime).toBe(1500);
    expect(rebuilt.blockers).toEqual([]);
  });

  it("keeps the Menu Board Computer as a pick when reopening a POS quote", () => {
    const built = buildQuote("all_in_one", picked([["Menu Board Computer", 2]]), [], CATALOG);
    expect(picksFromQuoteLines(built.quoteLines, "all_in_one"))
      .toContainEqual({ hubspotProductId: find("Menu Board Computer").hubspotProductId, qty: 2 });
  });

  it("will not let a rep charge for what the plan already paid for", () => {
    // Same rule as a package-covered line, and for the same reason: the
    // subscription bought it. An unrelated edit on the row can't restore it.
    const boards = find("Menu Board Computer").hubspotProductId;
    const built = buildQuote(
      "marketing_only",
      picked([["Menu Board Computer", 3]]),
      [],
      CATALOG,
      { [boards]: { billingStart: { mode: "days", days: 60 } } }
    );
    expect(built.quoteLines.find(l => l.name === "Menu Board Computer")!.discountPercent).toBe(100);
    expect(built.totals.oneTime).toBe(0);
  });
});

// ── The website, and where online ordering went ─────────────────────────────
// From 2026-10-08 a Marketing Only Website could take online orders, which
// made the merchant a processing one. Since 2026-10-27 online ordering is its
// own product on the ordering plans, and a Website is only a website. A
// marketing quote SAVED with the old toggle still carries the rate line, and
// that keeps it processing.
describe("the website and online ordering", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const SITE_ID = find("Website").hubspotProductId;

  it("never makes a Marketing Only quote process — a website takes no orders", () => {
    const withSite = [{ hubspotProductId: SITE_ID }];
    expect(isProcessingQuote("marketing_only")).toBe(false);
    expect(quoteHasProcessing("marketing_only", [])).toBe(false);
    expect(quoteHasProcessing("marketing_only", withSite)).toBe(false);
    // A processing plan processes whatever is on it — Partial Ordering included.
    expect(quoteHasProcessing("all_in_one", [])).toBe(true);
    expect(quoteHasProcessing("marketing_partial", [])).toBe(true);
  });

  it("keeps a marketing quote SAVED with online ordering processing, off its rate line", () => {
    const saved = [line("AIO Marketing Platform", 1), line("Website", 1), line(RATE_LINE, 1)];
    expect(quoteHasProcessing("marketing_only", saved)).toBe(true);
    // And reopening it no longer carries the toggle anywhere.
    expect(adjustmentsFromQuoteLines(saved)[SITE_ID]).toBeUndefined();
  });

  it("adds no rate line to a Marketing Only website", () => {
    const built = buildQuote("marketing_only", picked([["Website", 1]]), [], CATALOG);
    expect(built.blockers).toEqual([]);
    expect(built.quoteLines.map(l => l.name)).not.toContain(RATE_LINE);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 249 }]);
  });

  it("states the card rates on a Marketing Partial Ordering quote that takes orders online", () => {
    // Scenario C less the hardware: $299 plan + $50 website, $0 online ordering.
    const built = buildQuote("marketing_partial", picked([["Website", 1], ["Online Ordering", 1]]), [], CATALOG);
    expect(built.blockers).toEqual([]);
    expect(built.quoteLines.map(l => l.name)).toEqual([
      "AIO Marketing Partial Ordering", "Website", "Online Ordering", RATE_LINE,
    ]);
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 349 }]);
    // Nothing on site, so no install.
    expect(built.includedServices.lines).toEqual([]);
  });

  it("adds it to a POS quote too, since 2026-10-14 — the rates have to be on the document", () => {
    // REVERSED. It used to be marketing-only, on the reasoning that a POS
    // merchant obviously knows they're buying payments — which left the rates
    // written NOWHERE on the document a POS merchant signs. Product owner,
    // 2026-10-14.
    const built = buildQuote("all_in_one", picked([["POS Unit", 1], ["Website", 1]]), [], CATALOG);
    expect(built.quoteLines.map(l => l.name)).toContain(RATE_LINE);
  });

  it("still leaves a RATE-ONLY quote with no lines at all — the one thing the guard protects", () => {
    // A processing plan with nothing picked derives nothing. Putting the $0
    // disclosure on it would make `quoteSanityBlockers` refuse it ("every
    // line nets to $0"), stop `publishBillingQuote`'s empty-lines
    // short-circuit firing, and pull in a $0.50 pre-auth — turning a quote
    // that was never meant to charge anything into one that charges.
    const built = buildQuote("all_in_one", [], [], CATALOG);
    expect(built.quoteLines).toEqual([]);
    expect(built.blockers).toEqual([]);
  });

  it("blocks the quote when the rate product is missing from the catalog", () => {
    const stripped = CATALOG.filter(c => c.name !== RATE_LINE);
    const built = buildQuote("marketing_partial", picked([["Online Ordering", 1]]), [], stripped);
    expect(built.blockers).toHaveLength(1);
    expect(built.blockers[0]).toContain("has to state their rates");
  });

  it("never hands the rate line back as a pick — no rep may put it on by hand", () => {
    const built = buildQuote("marketing_partial", picked([["Online Ordering", 1]]), [], CATALOG);
    expect(isPickable(find(RATE_LINE))).toBe(false);
    expect(picksFromQuoteLines(built.quoteLines, "marketing_partial"))
      .toEqual([{ hubspotProductId: find("Online Ordering").hubspotProductId, qty: 1 }]);
  });
});

describe("one website per merchant", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const WEBSITE = "Website";

  it("caps the Website at one, and caps hardware at what fits in a restaurant", () => {
    expect(maxQtyFor(find(WEBSITE).hubspotProductId)).toBe(1);
    expect(DEFAULT_UNIT_CAPS[find(WEBSITE).hubspotProductId]).toBe(1);
    // A restaurant buys several POS units — capped, but nowhere near 1.
    expect(maxQtyFor(find("POS Unit").hubspotProductId)).toBeGreaterThan(1);
  });

  it("leaves a product with no cap uncapped, and takes the caps from the caller", () => {
    // The admin policy is the authority (quote_limit_policy); these constants
    // are only what an unseeded table falls back to. A product absent from
    // the map is uncapped, which is what keeps a newly added HubSpot record
    // from arriving limited to a number nobody chose.
    expect(maxQtyFor("a-product-nobody-capped")).toBeNull();
    expect(maxQtyFor(find("POS Unit").hubspotProductId, {})).toBeNull();
    expect(maxQtyFor(find("POS Unit").hubspotProductId, { [find("POS Unit").hubspotProductId]: 2 })).toBe(2);
  });

  it("refuses a quantity over an admin-set cap, naming where to raise it", () => {
    const id = find("POS Unit").hubspotProductId;
    const built = buildQuote(
      "all_in_one", picked([["POS Unit", 3]]), [], CATALOG, {}, 50,
      { unitCaps: { [id]: 2 }, discountCaps: {}, maxBillingDelayDays: 90, showTablets: false }
    );
    expect(built.blockers.some(b => b.includes("over the limit of 2"))).toBe(true);
    expect(built.blockers.some(b => b.includes("Admin → Quote limits"))).toBe(true);
  });

  it("refuses a quote carrying two of them", () => {
    const built = buildQuote("all_in_one", picked([[WEBSITE, 2]]), [], CATALOG);
    expect(built.blockers.some(b => b.includes("over the limit of 1"))).toBe(true);
  });

  it("allows exactly one", () => {
    expect(buildQuote("all_in_one", picked([[WEBSITE, 1]]), [], CATALOG).blockers).toEqual([]);
    expect(buildQuote("marketing_only", picked([[WEBSITE, 1]]), [], CATALOG).blockers).toEqual([]);
  });

  it("catches two SPLIT across lines, not just two on one line", () => {
    // A scoped discount splits one pick into two lines. Counting per line
    // instead of per product would let 1 + 1 through as "no line over 1".
    const id = find(WEBSITE).hubspotProductId;
    // Order & Pay, where the Website is charged — All-in-One includes it, and
    // a plan-covered line is never split.
    const built = buildQuote(
      "order_pay_only", picked([[WEBSITE, 2]]), [], CATALOG,
      { [id]: { discountPercent: 50, discountQty: 1 } }, 100
    );
    expect(built.quoteLines.filter(l => l.hubspotProductId === id)).toHaveLength(2);
    expect(built.blockers.some(b => b.includes("over the limit of 1"))).toBe(true);
  });
});

describe("derived terminals, licenses, and the lines a processing quote no longer sells", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const ams1Qty = (lines: QuoteLine[]) =>
    lines.filter(l => l.hubspotProductId === AMS1_PRODUCT.hubspotProductId)
      .reduce((n, l) => n + l.qty, 0);

  it("counts picked AMS1 toward the one-per-POS minimum, and tops up only what's short", () => {
    const built = buildQuote(
      "all_in_one",
      picked([["POS Unit", 2], ["POS Unit - With Customer Facing Display", 1], ["Payment Terminal - AMS1", 1]]),
      [],
      CATALOG
    );
    expect(built.blockers).toEqual([]);
    expect(ams1Qty(built.quoteLines)).toBe(3);
    expect(built.requiredTerminals.qty).toBe(2);
  });

  it("adds nothing when the picks already carry one AMS1 per POS, and keeps extras", () => {
    const exact = buildQuote("all_in_one", picked([["POS Unit", 2], ["Payment Terminal - AMS1", 2]]), [], CATALOG);
    expect(ams1Qty(exact.quoteLines)).toBe(2);
    expect(exact.requiredTerminals.qty).toBe(0);

    const extra = buildQuote("all_in_one", picked([["POS Unit", 1], ["Payment Terminal - AMS1", 3]]), [], CATALOG);
    expect(ams1Qty(extra.quoteLines)).toBe(3);
    expect(extra.requiredTerminals.qty).toBe(0);
  });

  it("sets the AMS1 floor at one per POS, on processing plans only", () => {
    const picks = [
      { hubspotProductId: "217445755632", qty: 2 },
      { hubspotProductId: "223452690130", qty: 1 },
      { hubspotProductId: "222497165009", qty: 4 },
    ];
    expect(minimumTerminalsFor("all_in_one", picks)).toBe(3);
    expect(minimumTerminalsFor("order_pay_only", picks)).toBe(3);
    expect(minimumTerminalsFor("marketing_only", picks)).toBe(0);
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
    expect(built.softwareLicense.lines.map(l => [l.name, l.qty])).toEqual([["Additional Software License", 2]]);
    // Still not ordering points.
    expect(built.orderPoints.total).toBe(2);
  });

  it("does not count a Menu Board Computer as a screen — it drives a TV (2026-10-18)", () => {
    const built = buildQuote(
      "all_in_one",
      picked([["POS Unit", 2], ["Mega Kiosk", 1], ["mPOS", 1], ["Menu Board Computer", 3]]),
      [],
      CATALOG
    );
    expect(built.softwareLicense.screens).toBe(4);
    expect(built.softwareLicense.lines.map(l => [l.name, l.qty])).toEqual([["Additional Software License", 1]]);
  });

  it("adds a software license only past three screens", () => {
    const three = buildQuote(
      "all_in_one",
      picked([["POS Unit", 2], ["Mega Kiosk", 1]]),
      [],
      CATALOG
    );
    expect(three.softwareLicense.screens).toBe(INCLUDED_SCREEN_COUNT);
    expect(three.softwareLicense.lines).toEqual([]);
    expect(three.totals.recurring).toEqual([{ frequency: "monthly", amount: 399 }]);

    const four = buildQuote(
      "all_in_one",
      picked([["POS Unit", 2], ["Mega Kiosk", 1], ["mPOS", 1]]),
      [],
      CATALOG
    );
    expect(four.softwareLicense.lines.map(l => [l.name, l.qty, l.unitPrice])).toEqual([
      ["Additional Software License", 1, 19],
    ]);
    expect(four.totals.recurring).toEqual([{ frequency: "monthly", amount: 418 }]);

    const seven = buildQuote(
      "order_pay_only",
      picked([
        ["POS Unit", 2],
        ["POS Unit - With Customer Facing Display", 1],
        ["Mega Kiosk", 1],
        ["Orders Hub Tablet", 1],
        ["mPOS", 1],
        ["Kiosk 27\" + Payment Terminal (AMS1) and Mount", 1],
      ]),
      [],
      CATALOG
    );
    expect(seven.softwareLicense.screens).toBe(7);
    expect(seven.softwareLicense.lines[0].qty).toBe(4);
    // 299 platform + 4 × 19.
    expect(seven.totals.recurring).toEqual([{ frequency: "monthly", amount: 375 }]);
  });

  it("leaves a rate-only quote without a terminal, a license, or WiFi", () => {
    const built = buildQuote("all_in_one", [], [], CATALOG);
    expect(built.quoteLines).toEqual([]);
    expect(built.requiredTerminals).toEqual({ lines: [], missing: [], qty: 0 });
    expect(built.softwareLicense).toEqual({ lines: [], missing: [], screens: 0 });
  });

  it("keeps a picked WiFi package through a reopen, and nothing is read back as an adjustment", () => {
    const first = buildQuote("all_in_one", picked([["POS Unit", 1], ["AIO Wifi Network Package - Unifi", 1]]), [], CATALOG);
    expect(first.quoteLines.map(l => l.name)).toContain("AIO Wifi Network Package - Unifi");

    expect(adjustmentsFromQuoteLines(first.quoteLines)[WIFI_PRODUCT_ID]).toBeUndefined();
    const picks = picksFromQuoteLines(first.quoteLines, "all_in_one");
    expect(picks).toContainEqual({ hubspotProductId: WIFI_PRODUCT_ID, qty: 1 });

    const second = buildQuote(
      "all_in_one",
      picks.map(pick => toQuoteLine(CATALOG.find(c => c.hubspotProductId === pick.hubspotProductId)!, pick.qty)),
      [],
      CATALOG,
      adjustmentsFromQuoteLines(first.quoteLines)
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
      picked([["POS Unit", 2], ["Mega Kiosk", 1], ["mPOS", 1], ["Orders Hub Tablet", 1]]),
      [],
      noLicense
    );
    expect(license.blockers.join(" ")).toContain("Additional Software License");
  });

  it("drops the 27\" kit and the hardware bundle when a processing quote is reopened, and keeps every AMS1", () => {
    // The Mega kit stays: a Mega goes on any plan since 2026-10-27.
    const lines = [
      line("POS Unit", 2),
      line("Payment Terminal - AMS1", 3),
      line("Marketing Kit - Mega Kiosk", 1),
      line("Marketing Kit - 27\" Kiosk", 1),
      line("QSR POS Hardware Bundle", 1),
      line("Additional Software License", 2),
    ];
    expect(picksFromQuoteLines(lines, "all_in_one")).toEqual([
      { hubspotProductId: find("POS Unit").hubspotProductId, qty: 2 },
      { hubspotProductId: AMS1_PRODUCT.hubspotProductId, qty: 3 },
      { hubspotProductId: find("Marketing Kit - Mega Kiosk").hubspotProductId, qty: 1 },
    ]);
  });

  it("reopens a quote saved under the old derivation with the same terminal count", () => {
    // Before 2026-10-09 the POS's AMS1 was derived on top of the picks: 2 POS +
    // 1 extra saved as one AMS1 line of 3. Reopened and rebuilt, it stays 3.
    const saved = [line("POS Unit", 2), line("Payment Terminal - AMS1", 3)];
    const picks = picksFromQuoteLines(saved, "all_in_one");
    const rebuilt = buildQuote(
      "all_in_one",
      picks.map(pick => toQuoteLine(CATALOG.find(c => c.hubspotProductId === pick.hubspotProductId)!, pick.qty)),
      [],
      CATALOG
    );
    expect(ams1Qty(rebuilt.quoteLines)).toBe(3);
  });

  it("leaves a marketing quote's kit as a pick", () => {
    const lines = [line("Marketing Kit - Mega Kiosk", 1)];
    expect(picksFromQuoteLines(lines, "marketing_only")).toEqual([
      { hubspotProductId: find("Marketing Kit - Mega Kiosk").hubspotProductId, qty: 1 },
    ]);
  });
});

describe("the Website All-in-One includes", () => {
  const website = () => line("Website", 1);
  const websiteLine = (lines: QuoteLine[]) => lines.find(l => l.name === "Website")!;

  // This has moved five times: added to All-in-One 2026-10-07, removed by the
  // 2026-10-09 notes, put back the same day, taken off on 2026-10-27 by the
  // scenario sheet and put back the same day (Elizabeth Phillips: "All in one
  // does include website for free"). The list is what makes each of those one
  // word, so it is asserted directly.
  it("is included on All-in-One only", () => {
    expect(PLANS_INCLUDING_WEBSITE).toEqual(["all_in_one"]);
    expect(planIncludesWebsite("all_in_one")).toBe(true);
    for (const t of ["order_pay_only", "marketing_only", "marketing_partial"] as const) {
      expect(planIncludesWebsite(t)).toBe(false);
    }
  });

  it("is held at $0 as part of the plan on All-in-One", () => {
    const built = buildQuote("all_in_one", [line("POS Unit", 1), website()], [], CATALOG);
    expect(websiteLine(built.quoteLines)).toMatchObject({
      discountPercent: 100,
      coveredByPackage: PLATFORM_PRODUCTS.all_in_one.name,
    });
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 399 }]);
  });

  it("stays at $0 even when the rep edits the row", () => {
    const id = find("Website").hubspotProductId;
    const built = buildQuote("all_in_one", [line("POS Unit", 1), website()], [], CATALOG, { [id]: { discountPercent: 10 } });
    expect(websiteLine(built.quoteLines).discountPercent).toBe(100);
  });

  it("is charged on Order & Pay", () => {
    const built = buildQuote("order_pay_only", [line("POS Unit", 1), website()], [], CATALOG);
    expect(websiteLine(built.quoteLines).discountPercent).toBeUndefined();
    expect(websiteLine(built.quoteLines).coveredByPackage).toBeUndefined();
  });

  it("applies the comp through the helper, which is the only thing the list drives", () => {
    expect(applyPlanIncludedWebsite("all_in_one", [website()])[0].coveredByPackage).toBe(PLATFORM_PRODUCTS.all_in_one.name);
    expect(applyPlanIncludedWebsite("order_pay_only", [website()])[0].coveredByPackage).toBeUndefined();
  });
});

// ── One per thing it attaches to ────────────────────────────────────────────
// Elizabeth Phillips, 2026-10-12: a display or a drawer belongs to a POS, a
// terminal to a POS or a kiosk. The flat unit caps can't say this — they cap
// each product at a number an admin typed, which catches a typo, not "four
// drawers for two tills".
describe("quantities counted against what they attach to", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const blockersFor = (names: Array<[string, number]>) =>
    buildQuote("all_in_one", picked(names), [], CATALOG).blockers;

  it("refuses more displays or drawers than POS units", () => {
    const blockers = blockersFor([["POS Unit", 2], ["Customer Facing Display", 3], ["Cash Drawer", 5]]);
    expect(blockers).toHaveLength(2);
    expect(blockers[0]).toContain('3 × "Customer Facing Display" on it but 2 POS units');
    expect(blockers[1]).toContain('5 × "Cash Drawer" on it but 2 POS units');
  });

  it("counts the POS that ships with a display toward the ceiling too", () => {
    expect(blockersFor([
      ["POS Unit", 1], ["POS Unit - With Customer Facing Display", 1], ["Customer Facing Display", 2],
    ])).toEqual([]);
  });

  it("says so plainly when there is nothing to attach them to", () => {
    const blockers = blockersFor([["Cash Drawer", 2]]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("but no POS units");
  });

  it("counts kiosks as well as POS units for the terminal", () => {
    // One terminal per POS is already DERIVED, so the ceiling it's measured
    // against has to include everything that can take a payment — otherwise
    // the quote blocks itself.
    expect(blockersFor([["POS Unit", 2]])).toEqual([]);
    expect(blockersFor([
      ["Kiosk 27\" + Payment Terminal (AMS1) and Mount", 2], ["Payment Terminal - AMS1", 2],
    ])).toEqual([]);

    const blockers = blockersFor([["POS Unit", 1], ["Payment Terminal - AMS1", 4]]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('4 × "Payment Terminal - AMS1" on it but 1 POS unit or kiosk');
  });

  it("reports rather than clamping — the lines stay on the quote", () => {
    const built = buildQuote("all_in_one", picked([["POS Unit", 1], ["Cash Drawer", 4]]), [], CATALOG);
    expect(built.blockers).toHaveLength(1);
    expect(built.quoteLines.filter(l => l.name === "Cash Drawer").map(l => l.qty)).toEqual([4]);
  });
});

// ── Card-not-present only ───────────────────────────────────────────────────
// A merchant who takes orders online and has nothing on site makes every sale
// card-not-present, so there is no card-present rate to quote them (product
// owner, 2026-10-14). The predicate is deliberately NOT "is it marketing + a
// website", which is what it looks like it should be — see the doc comment on
// `processesCardNotPresentOnly`.
describe("processesCardNotPresentOnly", () => {
  const picked = (names: Array<[string, number]>) => names.map(([n, q]) => line(n, q));
  const RATE = find(RATE_LINE);

  it("is true for a Marketing Partial Ordering quote that only takes orders online", () => {
    expect(processesCardNotPresentOnly("marketing_partial", picked([["Online Ordering", 1], ["Website", 1]]))).toBe(true);
    // The order tablet and KDS take no card either.
    expect(processesCardNotPresentOnly(
      "marketing_partial", picked([["Online Ordering", 1], ["Orders Hub Tablet", 1], ["KDS (Kitchen Display System)", 1]])
    )).toBe(true);
  });

  it("is true for a marketing quote saved with the old website-ordering toggle", () => {
    expect(processesCardNotPresentOnly("marketing_only", [...picked([["Website", 1]]), toQuoteLine(RATE, 1)])).toBe(true);
  });

  it("is FALSE once a kiosk is on it — a kiosk takes a card in person", () => {
    const withKiosk = picked([["Online Ordering", 1], ["Kiosk 27\" + Payment Terminal (AMS1) and Mount", 1]]);
    expect(processesCardNotPresentOnly("marketing_partial", withKiosk)).toBe(false);
  });

  it("is FALSE with an AMS1 on it, which carries ZERO ordering points but reads cards", () => {
    // The second trap: the terminal is explicitly 0 points (ORDER_POINT_RULES),
    // so a points-only test would wave it through.
    const withTerminal = picked([["Online Ordering", 1], ["Payment Terminal - AMS1", 1]]);
    expect(processesCardNotPresentOnly("marketing_partial", withTerminal)).toBe(false);
  });

  it("is FALSE for both POS plans, whatever is or isn't picked", () => {
    // A POS plan puts a system in a restaurant. That merchant takes cards
    // across a counter even before a rep has picked anything.
    for (const plan of ["all_in_one", "order_pay_only"] as const) {
      expect(processesCardNotPresentOnly(plan, [])).toBe(false);
      expect(processesCardNotPresentOnly(plan, picked([["Online Ordering", 1]]))).toBe(false);
    }
  });

  it("is FALSE for a marketing quote that doesn't process at all", () => {
    expect(processesCardNotPresentOnly("marketing_only", picked([["Website", 1]]))).toBe(false);
    expect(processesCardNotPresentOnly("marketing_only", [])).toBe(false);
  });

  it("works off PICKS, which carry no name — the kiosk's product id is enough", () => {
    // `ProductPick` is {hubspotProductId, qty}. The rep surfaces hold those,
    // not quote lines, so the card-present devices are recognised by id.
    const online = { hubspotProductId: find("Online Ordering").hubspotProductId };
    expect(processesCardNotPresentOnly("marketing_partial", [online])).toBe(true);
    expect(processesCardNotPresentOnly(
      "marketing_partial",
      [online, { hubspotProductId: find("Kiosk 27\" + Payment Terminal (AMS1) and Mount").hubspotProductId }]
    )).toBe(false);
  });
});

// ── The rate text on the HubSpot line item ──────────────────────────────────
// The disclosure PRODUCT's own description in HubSpot is static: it states
// 2.49% / 3.50% and a retired AMEX split to every merchant alike. This is what
// overrides it with the rates the rep actually quoted.
describe("processingDisclosureText", () => {
  const RATES = {
    cardPresentRate: 0.0275,
    cardNotPresentRate: 0.033,
    amexCardPresentRate: 0.0275,
    amexCardNotPresentRate: 0.033,
    perTransactionFee: 0.15,
  };

  it("states both lanes at the quote's own rates", () => {
    expect(processingDisclosureText(RATES)).toBe(
      "Card Present — 2.75% + $0.15 per transaction\n" +
      "Card Not Present — 3.30% + $0.15 per transaction\n" +
      "\n" +
      "Chargeback $25 · Retrieval $15"
    );
  });

  it("drops the card-present row for a merchant who can never have one", () => {
    const text = processingDisclosureText(RATES, true);
    expect(text).not.toContain("Card Present —");
    expect(text).toContain("Card Not Present — 3.30% + $0.15 per transaction");
  });

  it("prints two decimals, because every figure on AIO's rate card has two", () => {
    expect(processingDisclosureText({ ...RATES, cardPresentRate: 0.025 }))
      .toContain("Card Present — 2.50% + $0.15 per transaction");
  });

  it("names no AMEX rate — it stopped pricing apart on 2026-10-13", () => {
    expect(processingDisclosureText({ ...RATES, amexCardPresentRate: 0.0279 })).not.toContain("AMEX");
  });
});

describe("payroll needs a counter POS (2026-10-18)", () => {
  const payroll = { hubspotProductId: PAYROLL_PRODUCT_ID, qty: 12 };
  const unit = (hubspotProductId: string) => ({ hubspotProductId, qty: 1 });

  it("blocks payroll on its own", () => {
    expect(payrollBlockers([payroll])).toHaveLength(1);
  });

  it.each([
    ["POS Unit", "217445755632"],
    ["POS Unit - With Customer Facing Display", "223452690130"],
    ["POS (Dual Screen) + Payment Terminal", "339229355762"],
  ])("allows payroll beside a %s", (_name, id) => {
    expect(payrollBlockers([payroll, unit(id)])).toEqual([]);
  });

  it("does not count an mPOS, a tableside device or a kiosk as a counter POS", () => {
    expect(payrollBlockers([
      payroll, unit("223511653101"), unit("335279520447"), unit("222497165009"),
    ])).toHaveLength(1);
  });

  it("says nothing when there is no payroll on the quote", () => {
    expect(payrollBlockers([unit("223511653101")])).toEqual([]);
  });

  it("gates buildQuote", () => {
    const catalog: CatalogProduct[] = [
      ...CATALOG,
      { hubspotProductId: PAYROLL_PRODUCT_ID, name: "Payroll - AIO Platform (Per Person)", price: 8, billingFrequency: "monthly", productType: "Software" },
    ];
    const payrollLine = toQuoteLine(catalog.find(c => c.hubspotProductId === PAYROLL_PRODUCT_ID)!, 12);
    const mpos = toQuoteLine(catalog.find(c => c.name === "mPOS")!, 1);
    const blocked = buildQuote("all_in_one", [payrollLine, mpos], [], catalog);
    expect(blocked.blockers).toEqual(expect.arrayContaining(payrollBlockers([payrollLine])));

    const pos = toQuoteLine(catalog.find(c => c.name === "POS Unit")!, 1);
    const ok = buildQuote("all_in_one", [payrollLine, pos], [], catalog);
    expect(ok.blockers.join(" ")).not.toContain("Payroll");
  });
});

describe("the marketing line on Marketing Partial Ordering", () => {
  it("is one per quote, and never reads as unclassified hardware (HubSpot gives it no type)", () => {
    const id = find("Marketing (Partial Ordering)").hubspotProductId;
    expect(maxQtyFor(id)).toBe(1);
    const { unclassified, orderPoints } = deriveOrderPoints([line("Marketing (Partial Ordering)", 1)], []);
    expect(unclassified).toEqual([]);
    expect(orderPoints.total).toBe(0);
  });
});
