import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_DISCOUNT_PERCENT,
  INCLUDED_SERVICE_PRODUCTS,
  MAX_BILLING_DELAY_DAYS,
  PLATFORM_TIER_PRODUCT_NAMES,
  adjustmentBlockers,
  adjustmentsFromQuoteLines,
  applyLineAdjustment,
  buildQuote,
  describeBillingStart,
  lineDiscountAmount,
  lineListAmount,
  lineNetAmount,
  picksFromQuoteLines,
  quoteTotals,
  toQuoteLine,
} from "@/lib/quoting";
import { planLineItemReconciliation, toLineItemProperties } from "@/lib/adapters/hubspot";
import type { CatalogProduct, QuoteAdjustments, QuoteLine } from "@/types/merchant";

// Discounts and delayed billing starts, end to end through the pure layer.
// The shapes here are the ones the live portal actually carries: a 100%-comped
// install, a half-price weekly platform fee, and a platform line that doesn't
// start billing until the restaurant opens.

const p = (
  hubspotProductId: string,
  name: string,
  price: number,
  billingFrequency: CatalogProduct["billingFrequency"],
  productType: string,
): CatalogProduct => ({ hubspotProductId, name, price, billingFrequency, productType });

const PLATFORM_ID = "217526517443";
const INSTALL_ID = INCLUDED_SERVICE_PRODUCTS.find(s => s.name === "Onsite Installation")!.hubspotProductId;
const TRAINING_ID = INCLUDED_SERVICE_PRODUCTS.find(s => s.name === "System Onboarding and Training")!.hubspotProductId;
const WIFI_ID = INCLUDED_SERVICE_PRODUCTS.find(s => s.name === "AIO WiFi Network Package")!.hubspotProductId;
const POS_ID = "217445755632";

const CATALOG: CatalogProduct[] = [
  p(PLATFORM_ID, PLATFORM_TIER_PRODUCT_NAMES.small, 99, "weekly", "Software"),
  p("292286544587", PLATFORM_TIER_PRODUCT_NAMES.large, 199, "weekly", "Software"),
  p(POS_ID, "POS Unit", 749, "one_time", "inventory"),
  p(WIFI_ID, "AIO WiFi Network Package", 999, "one_time", "inventory"),
  p(INSTALL_ID, "Onsite Installation", 999, "one_time", "Service"),
  p(TRAINING_ID, "System Onboarding and Training", 499, "one_time", "Service"),
];

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  hubspotProductId: POS_ID, name: "POS Unit", qty: 1, unitPrice: 749,
  billingFrequency: "one_time", productType: "inventory", ...over,
});

describe("line arithmetic", () => {
  it("leaves an undiscounted line at list price", () => {
    const l = line({ qty: 2 });
    expect(lineListAmount(l)).toBe(1498);
    expect(lineNetAmount(l)).toBe(1498);
    expect(lineDiscountAmount(l)).toBe(0);
  });

  it("nets a percentage discount, matching HubSpot's calculated amount", () => {
    // The live shape: price 999 × qty 2 at 100% → pre_discount 1998, amount 0.
    const l = line({ hubspotProductId: "x", unitPrice: 999, qty: 2, discountPercent: 100 });
    expect(lineListAmount(l)).toBe(1998);
    expect(lineNetAmount(l)).toBe(0);
    expect(lineDiscountAmount(l)).toBe(1998);
  });

  it("halves a weekly platform fee to the 49.50 the portal shows", () => {
    const l = line({ unitPrice: 99, billingFrequency: "weekly", discountPercent: 50 });
    expect(lineNetAmount(l)).toBe(49.5);
  });

  it("rounds to cents so our totals can't drift from the rendered document", () => {
    // 33.3% off $99 is $66.033 — a float that would print as 66.03300000000002.
    const l = line({ unitPrice: 99, discountPercent: 33.3 });
    expect(lineNetAmount(l)).toBe(66.03);
    expect(lineDiscountAmount(l)).toBe(32.97);
  });
});

describe("quoteTotals", () => {
  it("sums NET amounts, one-time and recurring alike", () => {
    const totals = quoteTotals([
      line({ unitPrice: 999, discountPercent: 100 }),                                   // comped install
      line({ unitPrice: 499 }),                                                          // full-price training
      line({ unitPrice: 99, billingFrequency: "weekly", discountPercent: 50 }),          // half-price platform
    ]);
    expect(totals.oneTime).toBe(499);
    expect(totals.recurring).toEqual([{ frequency: "weekly", amount: 49.5 }]);
  });

  it("does not let a delayed start move the totals — it changes timing, not amount", () => {
    const base = line({ unitPrice: 99, billingFrequency: "weekly" });
    const delayed = { ...base, billingStart: { mode: "days", days: 60 } as const };
    expect(quoteTotals([delayed])).toEqual(quoteTotals([base]));
  });
});

describe("applyLineAdjustment", () => {
  it("puts a discount and a delay onto a recurring line", () => {
    const out = applyLineAdjustment(
      line({ billingFrequency: "weekly" }),
      { discountPercent: 25, billingStart: { mode: "days", days: 60 } }
    );
    expect(out.discountPercent).toBe(25);
    expect(out.billingStart).toEqual({ mode: "days", days: 60 });
  });

  it("strips a billing start from a one-time line — there is no schedule to delay", () => {
    const out = applyLineAdjustment(line(), { billingStart: { mode: "days", days: 60 } });
    expect(out.billingStart).toBeUndefined();
  });

  it("clears a zeroed discount rather than persisting a 0", () => {
    const out = applyLineAdjustment(line({ discountPercent: 40 }), { discountPercent: 0 });
    expect("discountPercent" in out).toBe(false);
  });

  it("leaves the line untouched when there is no adjustment", () => {
    const l = line({ discountPercent: 40 });
    expect(applyLineAdjustment(l, undefined)).toBe(l);
  });
});

describe("adjustmentBlockers", () => {
  it("passes a discount at exactly the cap", () => {
    expect(adjustmentBlockers([line({ discountPercent: 50 })], 50)).toEqual([]);
  });

  it("refuses a discount over the cap, naming both numbers and the fix", () => {
    const [msg] = adjustmentBlockers([line({ discountPercent: 75 })], 50);
    expect(msg).toContain("75%");
    expect(msg).toContain("50% limit");
    expect(msg).toContain("Admin → Margin policy");
  });

  it("refuses a percentage that isn't one", () => {
    expect(adjustmentBlockers([line({ discountPercent: 140 })], 100)).toHaveLength(1);
    expect(adjustmentBlockers([line({ discountPercent: -5 })], 100)).toHaveLength(1);
  });

  it("refuses a billing start date that isn't a real calendar date", () => {
    const bad = line({ billingFrequency: "weekly", billingStart: { mode: "date", date: "2026-02-31" } });
    expect(adjustmentBlockers([bad], 100)).toHaveLength(1);
    const alsoBad = line({ billingFrequency: "weekly", billingStart: { mode: "date", date: "11/01/2026" } });
    expect(adjustmentBlockers([alsoBad], 100)).toHaveLength(1);
  });

  it("accepts a real date and refuses an out-of-range day delay", () => {
    const ok = line({ billingFrequency: "weekly", billingStart: { mode: "date", date: "2026-11-01" } });
    expect(adjustmentBlockers([ok], 100)).toEqual([]);
    const tooLong = line({ billingFrequency: "weekly", billingStart: { mode: "days", days: MAX_BILLING_DELAY_DAYS + 1 } });
    expect(adjustmentBlockers([tooLong], 100)).toHaveLength(1);
    const zero = line({ billingFrequency: "weekly", billingStart: { mode: "days", days: 0 } });
    expect(adjustmentBlockers([zero], 100)).toHaveLength(1);
  });

  it("defaults the cap below 100, so an unseeded policy can't authorize giving the quote away", () => {
    expect(DEFAULT_MAX_DISCOUNT_PERCENT).toBeLessThan(100);
  });
});

describe("buildQuote with adjustments", () => {
  const picked = [toQuoteLine(CATALOG.find(c => c.hubspotProductId === POS_ID)!, 1)];

  it("comps a DERIVED install line — the discount reps actually write most", () => {
    const adjustments: QuoteAdjustments = { [INSTALL_ID]: { discountPercent: 100 } };
    const built = buildQuote("full_pos", picked, [], CATALOG, adjustments, 100);

    const install = built.quoteLines.find(l => l.hubspotProductId === INSTALL_ID)!;
    expect(install.discountPercent).toBe(100);
    expect(lineNetAmount(install)).toBe(0);
    // $999 install + $499 training + $999 wifi + $749 POS, less the comped install.
    expect(built.totals.oneTime).toBe(2247);
    expect(built.blockers).toEqual([]);
  });

  it("delays the DERIVED platform line until the restaurant opens", () => {
    const adjustments: QuoteAdjustments = {
      [PLATFORM_ID]: { billingStart: { mode: "date", date: "2026-11-01" } },
    };
    const built = buildQuote("full_pos", picked, [], CATALOG, adjustments, 100);
    const platform = built.quoteLines.find(l => l.hubspotProductId === PLATFORM_ID)!;
    expect(platform.billingStart).toEqual({ mode: "date", date: "2026-11-01" });
    // Still the full weekly figure — a delay is not a discount.
    expect(built.totals.recurring).toEqual([{ frequency: "weekly", amount: 99 }]);
  });

  it("blocks the whole quote when a discount is over the cap", () => {
    const built = buildQuote("full_pos", picked, [], CATALOG, { [POS_ID]: { discountPercent: 90 } }, 50);
    expect(built.blockers).toHaveLength(1);
    expect(built.blockers[0]).toContain("POS Unit");
  });

  it("applies nothing when no adjustments are passed", () => {
    const built = buildQuote("full_pos", picked, [], CATALOG);
    expect(built.quoteLines.every(l => l.discountPercent === undefined)).toBe(true);
    expect(built.quoteLines.every(l => l.billingStart === undefined)).toBe(true);
  });
});

describe("reopening a saved quote", () => {
  it("carries a derived line's adjustment back, which the picks deliberately drop", () => {
    const picked = [toQuoteLine(CATALOG.find(c => c.hubspotProductId === POS_ID)!, 1)];
    const saved = buildQuote("full_pos", picked, [], CATALOG, {
      [INSTALL_ID]: { discountPercent: 100 },
      [PLATFORM_ID]: { billingStart: { mode: "days", days: 60 } },
    }, 100).quoteLines;

    // The picks drop derived lines — that is their job, they get re-derived.
    expect(picksFromQuoteLines(saved).map(x => x.hubspotProductId)).toEqual([POS_ID]);

    // The adjustments must NOT, or the comped install silently returns to $999.
    const reopened = adjustmentsFromQuoteLines(saved);
    expect(reopened[INSTALL_ID]).toEqual({ discountPercent: 100 });
    expect(reopened[PLATFORM_ID]).toEqual({ billingStart: { mode: "days", days: 60 } });

    // And a round trip through buildQuote reproduces the same lines.
    const rebuilt = buildQuote("full_pos", picked, [], CATALOG, reopened, 100);
    expect(rebuilt.quoteLines).toEqual(saved);
  });

  it("records nothing for lines that were never adjusted", () => {
    expect(adjustmentsFromQuoteLines([line(), line({ discountPercent: 0 })])).toEqual({});
    expect(adjustmentsFromQuoteLines(null)).toEqual({});
  });
});

describe("toLineItemProperties", () => {
  it("sends the list price and the discount alongside it, never a pre-netted price", () => {
    const props = toLineItemProperties(line({ unitPrice: 999, qty: 2, discountPercent: 100 }));
    expect(props.price).toBe("999");
    expect(props.quantity).toBe("2");
    expect(props.hs_discount_percentage).toBe("100");
    // HubSpot calculates these — writing them is rejected and pointless.
    expect(props.amount).toBeUndefined();
    expect(props.hs_total_discount).toBeUndefined();
  });

  it("omits the discount property entirely on a full-price line", () => {
    expect(toLineItemProperties(line())).not.toHaveProperty("hs_discount_percentage");
  });

  it("writes the delay type discriminator with a custom date, or the delay is ignored", () => {
    const props = toLineItemProperties(line({
      billingFrequency: "weekly",
      billingStart: { mode: "date", date: "2026-11-01" },
    }));
    expect(props.hs_billing_start_delay_type).toBe("hs_recurring_billing_start_date");
    expect(props.hs_recurring_billing_start_date).toBe("2026-11-01");
    expect(props.hs_billing_start_delay_days).toBeUndefined();
  });

  it("writes the day-delay pair for the 60-day shape the portal favours", () => {
    const props = toLineItemProperties(line({
      billingFrequency: "monthly",
      billingStart: { mode: "days", days: 60 },
    }));
    expect(props.hs_billing_start_delay_type).toBe("hs_billing_start_delay_days");
    expect(props.hs_billing_start_delay_days).toBe("60");
    expect(props.hs_recurring_billing_start_date).toBeUndefined();
  });

  it("never emits a delay on a one-time line, even if one somehow rode along", () => {
    const props = toLineItemProperties({
      ...line(),
      billingStart: { mode: "days", days: 60 },
    });
    expect(props.hs_billing_start_delay_type).toBeUndefined();
  });

  it("still never emits hs_recurring_billing_period", () => {
    const props = toLineItemProperties(line({
      billingFrequency: "weekly", discountPercent: 50, billingStart: { mode: "days", days: 60 },
    }));
    expect(props).not.toHaveProperty("hs_recurring_billing_period");
  });
});

describe("draft reconciliation", () => {
  it("recreates the line item when only the discount changed", () => {
    const before = line({ unitPrice: 999 });
    const after = { ...before, discountPercent: 100 };
    const plan = planLineItemReconciliation(["li1"], [before], [after]);
    // Not reused: there is no line-item PATCH, so keeping li1 would leave the
    // DRAFT quote carrying the original full-price line.
    expect(plan.keep).toEqual([]);
    expect(plan.create).toEqual([{ nextIndex: 0, line: after }]);
    expect(plan.delete).toEqual(["li1"]);
  });

  it("recreates the line item when only the billing start changed", () => {
    const before = line({ billingFrequency: "weekly" });
    const after = { ...before, billingStart: { mode: "days", days: 60 } as const };
    const plan = planLineItemReconciliation(["li1"], [before], [after]);
    expect(plan.keep).toEqual([]);
    expect(plan.delete).toEqual(["li1"]);
  });

  it("still reuses an untouched line", () => {
    const l = line({ discountPercent: 50 });
    const plan = planLineItemReconciliation(["li1"], [l], [{ ...l }]);
    expect(plan.keep).toEqual([{ lineItemId: "li1", nextIndex: 0 }]);
    expect(plan.delete).toEqual([]);
  });
});

describe("describeBillingStart", () => {
  it("reads as prose for a customer", () => {
    expect(describeBillingStart({ mode: "date", date: "2026-11-01" })).toBe("Billing starts 2026-11-01");
    expect(describeBillingStart({ mode: "days", days: 60 })).toBe("Billing starts 60 days after checkout");
  });
});
