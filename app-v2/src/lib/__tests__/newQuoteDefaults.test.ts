import { describe, it, expect, beforeAll } from "vitest";
import { KIT_DEFAULT_PRODUCTS, PACKAGES, kitFor, kitPicks } from "@/lib/quotePackages";
import {
  AMS1_PRODUCT,
  MARKETING_INCLUDED_HARDWARE,
  PLAN_DEFAULT_BILLING_DELAY_DAYS,
  PRE_AUTH_PRODUCT,
  WEBSITE_PRODUCT_ID,
  buildQuote,
  isMarketingQuote,
  minimumTerminalsFor,
  planDefaultBillingStart,
  planIncludesWebsite,
  toQuoteLine,
} from "@/lib/quoting";
import type { CatalogProduct, QuoteAdjustments, QuoteLine, QuoteType } from "@/types/merchant";

// The live HubSpot records this path actually touches, at their real prices.
const P: Array<[string, string, number, CatalogProduct["billingFrequency"], string]> = [
  ["335283119838", "All-in-One Platform", 399, "monthly", "Software"],
  ["332609247965", "AIO Marketing Platform", 199, "monthly", "Software"],
  ["333275576048", "Website", 50, "monthly", "Software"],
  ["217445755632", "POS Unit", 749, "one_time", "inventory"],
  ["318736467644", "Customer Facing Display", 299, "one_time", ""],
  ["222497165009", "Kiosk 27\" + Payment Terminal (AMS1) and Mount", 999, "one_time", "inventory"],
  ["223511653105", "Payment Terminal - AMS1", 300, "one_time", "inventory"],
  ["223452690132", "KDS (Kitchen Display System)", 399, "one_time", "inventory"],
  ["223511653104", "Thermal Printer", 199, "one_time", "inventory"],
  ["222497165011", "Cash Drawer", 70, "one_time", "inventory"],
  ["223511653103", "Menu Board Computer", 99, "one_time", "inventory"],
  ["281351401209", "AIO WiFi Network Package", 999, "one_time", "inventory"],
  ["223452690133", "Onsite Installation", 999, "one_time", "Service"],
  ["223152695032", "System Onboarding and Training", 499, "one_time", "Service"],
  ["335280960199", "Additional Software License", 19, "monthly", "Software"],
  [PRE_AUTH_PRODUCT.hubspotProductId, PRE_AUTH_PRODUCT.name, 0.5, "one_time", "Service"],
];
const CATALOG: CatalogProduct[] = P.map(([hubspotProductId, name, price, billingFrequency, productType]) => ({
  hubspotProductId, name, price, billingFrequency, productType,
}));

/** Exactly what the configurator seeds when a rep opens a new All-in-One quote. */
function seededPicks() {
  const kit = kitFor("all_in_one")!;
  const qty = new Map(kitPicks(kit).map(k => [k.hubspotProductId, k.qty]));
  const terminals = minimumTerminalsFor("all_in_one", kitPicks(kit));
  if (terminals > 0) qty.set(AMS1_PRODUCT.hubspotProductId, terminals);
  return [...qty].map(([id, n]) => toQuoteLine(CATALOG.find(c => c.hubspotProductId === id)!, n));
}

/** And the 60-day start it then sweeps across the recurring lines. */
function seededAdjustments(lines: QuoteLine[]): QuoteAdjustments {
  const start = planDefaultBillingStart("all_in_one")!;
  const out: QuoteAdjustments = {};
  for (const l of lines) if (l.billingFrequency !== "one_time") out[l.hubspotProductId] = { billingStart: start };
  return out;
}

beforeAll(() => { for (const pkg of PACKAGES) pkg.active = true; });

describe("the quote a rep opens on, end to end", () => {
  it("seeds the whole kit — every slot filled, nothing missing from the catalog", () => {
    for (const id of Object.values(KIT_DEFAULT_PRODUCTS)) {
      expect(CATALOG.some(c => c.hubspotProductId === id)).toBe(true);
    }
    expect(seededPicks().length).toBeGreaterThan(0);
  });

  it("builds a sendable quote with the kit free and the plan delayed 60 days", () => {
    const picks = seededPicks();
    // One pass to find the recurring lines, as the configurator does, then the
    // real build with the start applied.
    const first = buildQuote("all_in_one", picks, [], CATALOG);
    const built = buildQuote("all_in_one", picks, [], CATALOG, seededAdjustments(first.quoteLines));

    expect(built.blockers).toEqual([]);

    const platform = built.quoteLines.find(l => l.name === "All-in-One Platform")!;
    expect(platform.billingStart).toEqual({ mode: "days", days: PLAN_DEFAULT_BILLING_DELAY_DAYS });

    // The kit covers the hardware, so everything on the quote is at $0 —
    // which is exactly the case the pre-authorization exists for.
    expect(built.packages.applied).toHaveLength(1);
    expect(built.preAuth.lines).toHaveLength(1);
    expect(built.quoteLines.at(-1)!.hubspotProductId).toBe(PRE_AUTH_PRODUCT.hubspotProductId);
  });

  it("collects at least HubSpot's floor at checkout, so the quote can be published", () => {
    const picks = seededPicks();
    const first = buildQuote("all_in_one", picks, [], CATALOG);
    const built = buildQuote("all_in_one", picks, [], CATALOG, seededAdjustments(first.quoteLines));
    const due = built.quoteLines
      .filter(l => l.billingFrequency === "one_time" || !l.billingStart)
      .reduce((n, l) => n + l.unitPrice * l.qty * (1 - (l.discountPercent ?? 0) / 100), 0);
    expect(due).toBeGreaterThanOrEqual(0.5);
  });

  it("is still sendable once the rep clears the delay again", () => {
    const picks = seededPicks();
    const built = buildQuote("all_in_one", picks, [], CATALOG, {});
    expect(built.blockers).toEqual([]);
  });
});

describe("what each plan opens with", () => {
  // The cart `changeType` builds, modelled off the same constants it reads.
  // The component isn't rendered here; this pins the CONTENTS a plan is meant
  // to open with, which is what the product owner reported wrong twice.
  const openingCart = (plan: QuoteType) => {
    const out = new Map<string, number>();
    const kit = kitFor(plan);
    if (kit) {
      for (const k of kitPicks(kit)) out.set(k.hubspotProductId, k.qty);
      const terminals = minimumTerminalsFor(plan, kitPicks(kit));
      if (terminals > 0) out.set(AMS1_PRODUCT.hubspotProductId, terminals);
    }
    if (planIncludesWebsite(plan)) out.set(WEBSITE_PRODUCT_ID, 1);
    if (isMarketingQuote(plan)) {
      for (const h of MARKETING_INCLUDED_HARDWARE) out.set(h.hubspotProductId, h.qty);
    }
    return out;
  };

  it("opens All-in-One with the kit AND the Website the plan includes", () => {
    const cart = openingCart("all_in_one");
    expect(cart.get(WEBSITE_PRODUCT_ID)).toBe(1);
    expect(cart.get("217445755632")).toBe(1); // POS Unit, from the kit
  });

  it("opens Order & Pay with the kit but no Website — it isn't in that plan", () => {
    const cart = openingCart("order_pay_only");
    expect(cart.has(WEBSITE_PRODUCT_ID)).toBe(false);
    expect(cart.get("217445755632")).toBe(1);
  });

  it("opens both marketing plans with the three Menu Board Computers", () => {
    for (const plan of ["marketing_only", "marketing_term"] as const) {
      expect(openingCart(plan).get("223511653103")).toBe(3);
      // No kit, and no Website: a marketing merchant buys that separately.
      expect(openingCart(plan).has("217445755632")).toBe(false);
      expect(openingCart(plan).has(WEBSITE_PRODUCT_ID)).toBe(false);
    }
  });

  it("holds everything a plan opens with at $0 — opening a quote costs nothing", () => {
    // Marketing only: the three boards are the plan's, so the opening quote is
    // the subscription and nothing else one-time.
    const boards = MARKETING_INCLUDED_HARDWARE.map(h =>
      toQuoteLine(CATALOG.find(c => c.hubspotProductId === h.hubspotProductId)!, h.qty)
    );
    const built = buildQuote("marketing_only", boards, [], CATALOG);
    expect(built.totals.oneTime).toBe(0);
    expect(built.quoteLines.filter(l => l.name === "Menu Board Computer")
      .map(l => [l.qty, l.discountPercent ?? null])).toEqual([[3, 100]]);
  });
});
