import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { PACKAGES } from "@/lib/quotePackages";
import {
  COMPED_SERVICE_PRODUCT_IDS,
  DEFAULT_MAX_DISCOUNT_PERCENT,
  INCLUDED_SERVICE_PRODUCTS,
  MAX_BILLING_DELAY_DAYS,
  adjustmentBlockers,
  applyPackageComp,
  adjustmentsFromQuoteLines,
  amountDueAtCheckout,
  applyLineAdjustment,
  PRE_AUTH_PRODUCT,
  PROCESSING_DISCLOSURE_PRODUCT,
  checkoutAmountBlockers,
  buildQuote,
  isAllowedForQuoteType,
  describeBillingStart,
  discountQtyBlockers,
  lineDiscountAmount,
  lineListAmount,
  lineNetAmount,
  picksFromQuoteLines,
  quoteSanityBlockers,
  quoteTotals,
  splitPartialDiscount,
  toQuoteLine,
} from "@/lib/quoting";
import { planLineItemReconciliation, toLineItemProperties } from "@/lib/adapters/hubspot";
import type { CatalogProduct, QuoteAdjustments, QuoteLine } from "@/types/merchant";

// These tests are about discount and billing-start mechanics, so the free
// hardware kit is switched off for the file: left on, it zeroes the POS and
// terminal lines these tests price. It has its own file (quotePackages.test.ts).
beforeAll(() => { for (const pkg of PACKAGES) pkg.active = false; });

// Discounts and delayed billing starts, end to end through the pure layer.
// The shapes here are the ones the live portal actually carries: a 100%-comped
// install, a half-price recurring fee, and a platform line that doesn't start
// billing until the restaurant opens. The bare weekly lines below are not
// stale: nothing sellable bills weekly any more, but published quotes do.

const p = (
  hubspotProductId: string,
  name: string,
  price: number,
  billingFrequency: CatalogProduct["billingFrequency"],
  productType: string,
): CatalogProduct => ({ hubspotProductId, name, price, billingFrequency, productType });

const PLATFORM_ID = "335283119838";
const INSTALL_ID = INCLUDED_SERVICE_PRODUCTS.find(s => s.name === "Onsite Installation")!.hubspotProductId;
const TRAINING_ID = INCLUDED_SERVICE_PRODUCTS.find(s => s.name === "System Onboarding and Training")!.hubspotProductId;
const WIFI_ID = INCLUDED_SERVICE_PRODUCTS.find(s => s.name === "AIO Wifi Network Package - Unifi")!.hubspotProductId;
const POS_ID = "217445755632";
const AMS1_ID = "223511653105";

const CATALOG: CatalogProduct[] = [
  p(PLATFORM_ID, "All-in-One Platform", 399, "monthly", ""),
  p("335279520445", "All-in-One (Order & Pay only)", 299, "monthly", ""),
  p(POS_ID, "POS Unit", 749, "one_time", "inventory"),
  p(AMS1_ID, "Payment Terminal - AMS1", 300, "one_time", "inventory"),
  p(WIFI_ID, "AIO Wifi Network Package - Unifi", 698, "one_time", "inventory"),
  p(INSTALL_ID, "Onsite Installation", 999, "one_time", "Service"),
  p(TRAINING_ID, "System Onboarding and Training", 499, "one_time", "Service"),
  p(PRE_AUTH_PRODUCT.hubspotProductId, PRE_AUTH_PRODUCT.name, 0.5, "one_time", "Service"),
  // $0, and on every quote AIO processes for since 2026-10-14 — so it lands
  // on the end of every built line set in this file.
  p(PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId, PROCESSING_DISCLOSURE_PRODUCT.name, 0, "one_time", "AIO Payment Processing"),
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

  // The strip is load-bearing: a dated one-time line makes the HubSpot quote
  // unpublishable (400 NON_RECURRING_FUTURE_BILLED_LI_NOT_ALLOWED, live
  // 2026-10-12), so this must hold for the DATE mode too, not just for days.
  it("strips a billing start from a one-time line — there is no schedule to delay", () => {
    expect(applyLineAdjustment(line(), { billingStart: { mode: "days", days: 60 } }).billingStart)
      .toBeUndefined();
    expect(applyLineAdjustment(line(), { billingStart: { mode: "date", date: "2026-12-01" } }).billingStart)
      .toBeUndefined();
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
    expect(msg).toContain("Admin → Quote limits");
  });

  it("uses the product's own cap over the fallback, in both directions", () => {
    const id = line().hubspotProductId;
    // Raised for this product: 75% passes although the fallback is 50.
    expect(adjustmentBlockers([line({ discountPercent: 75 })], 50, undefined, { [id]: 80 })).toEqual([]);
    // Lowered for this product: 30% is refused although the fallback is 50.
    const [msg] = adjustmentBlockers([line({ discountPercent: 30 })], 50, undefined, { [id]: 20 });
    expect(msg).toContain("20% limit");
    expect(msg).toContain("this product");
    // Another product still follows the fallback.
    expect(adjustmentBlockers([line({ hubspotProductId: "other", discountPercent: 50 })], 50, undefined, { [id]: 20 })).toEqual([]);
  });

  it("holds a dollar discount to the per-product cap too", () => {
    const id = line().hubspotProductId;
    const l = line({ discountAmount: 300 }); // 40.05% of the $749 line
    expect(adjustmentBlockers([l], 100, undefined, { [id]: 40 })).toHaveLength(1);
    expect(adjustmentBlockers([l], 100, undefined, { [id]: 41 })).toEqual([]);
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

describe("quoteSanityBlockers", () => {
  const totals = (lines: QuoteLine[]) => quoteSanityBlockers(lines, quoteTotals(lines));

  it("says nothing about an ordinary quote", () => {
    expect(totals([line(), line({ unitPrice: 99, billingFrequency: "weekly" })])).toEqual([]);
  });

  it("refuses a negative price — the discount cap bounds a percentage, not the catalog", () => {
    const [msg] = totals([line({ unitPrice: -749 })]);
    expect(msg).toContain("POS Unit");
    expect(msg).toContain("negative");
  });

  it("refuses a quantity that isn't a whole number of at least one", () => {
    expect(totals([line({ qty: 0 })]).length).toBeGreaterThan(0);
    expect(totals([line({ qty: 1.5 })]).length).toBeGreaterThan(0);
  });

  it("refuses a quote that totals backwards, whichever side is negative", () => {
    const oneTime = totals([line({ unitPrice: -1 })]);
    expect(oneTime.some(b => b.includes("bill the customer backwards"))).toBe(true);
    const recurring = totals([line({ unitPrice: -99, billingFrequency: "weekly" })]);
    expect(recurring.some(b => b.includes("bill the customer backwards"))).toBe(true);
  });

  it("refuses a quote whose every line nets to $0", () => {
    const [msg] = totals([line({ discountPercent: 100 }), line({ unitPrice: 499, discountPercent: 100 })]);
    expect(msg).toContain("$0");
  });

  // A rate-only quote carries no lines at all, and IS a real thing to send —
  // the processing margin comes out of Adyen settlement, not a line item.
  it("leaves a quote with no lines alone", () => {
    expect(totals([])).toEqual([]);
  });

  // The 2-year marketing plan on 2026-10-07: $299/mo delayed 60 days, hardware
  // comped by the plan. Worth $299/mo, owes $0 today, and HubSpot answered the
  // publish with 400 MIN_TOTAL_NOT_REACHED after the draft was already built.
  describe("nothing due at checkout", () => {
    const plan = (over: Partial<QuoteLine> = {}) =>
      line({ name: "Plan", unitPrice: 299, billingFrequency: "monthly", ...over });
    const comped = line({ discountPercent: 100, coveredByPackage: "Plan" });
    const delayed = { mode: "days" as const, days: 60 };

    it("counts one-time lines and the first payment of an undelayed recurring line", () => {
      expect(amountDueAtCheckout([plan(), comped])).toBe(299);
      expect(amountDueAtCheckout([plan({ billingStart: delayed }), line()])).toBe(749);
    });

    it("counts nothing for a delayed recurring line", () => {
      expect(amountDueAtCheckout([plan({ billingStart: delayed }), comped])).toBe(0);
    });

    it("refuses a worth-something quote that owes nothing today", () => {
      const blockers = checkoutAmountBlockers([plan({ billingStart: delayed }), comped]);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain("Nothing is due at checkout");
    });

    it("lets it through once the delay comes off, or something is charged up front", () => {
      expect(checkoutAmountBlockers([plan(), comped])).toEqual([]);
      expect(checkoutAmountBlockers([plan({ billingStart: delayed }), line()])).toEqual([]);
      expect(checkoutAmountBlockers([])).toEqual([]);
    });

    it("sits at HubSpot's threshold: $0.50 is enough, $0.49 is not", () => {
      expect(checkoutAmountBlockers([line({ unitPrice: 0.5 })])).toEqual([]);
      expect(checkoutAmountBlockers([line({ unitPrice: 0.49 })])).toHaveLength(1);
    });
  });

  it("gates buildQuote, so a $0 quote can't be sent or published", () => {
    const pos = CATALOG.find(c => c.hubspotProductId === POS_ID)!;
    const adjustments: QuoteAdjustments = {
      [POS_ID]: { discountPercent: 100 },
      [PLATFORM_ID]: { discountPercent: 100 },
      [WIFI_ID]: { discountPercent: 100 },
      [AMS1_ID]: { discountPercent: 100 },
      // Charged at list since 2026-10-18, so a $0 quote gives these away too.
      [INSTALL_ID]: { discountPercent: 100 },
      [TRAINING_ID]: { discountPercent: 100 },
    };
    const built = buildQuote("all_in_one", [toQuoteLine(pos, 1)], [], CATALOG, adjustments, 100);
    // Only the $0.50 pre-authorization is left to charge, and it must not hide the $0 quote.
    expect(built.totals.oneTime).toBe(0.5);
    expect(built.blockers.some(b => b.includes("nets to $0"))).toBe(true);
  });
});

describe("buildQuote with no service comp (since 2026-10-18)", () => {
  const picked = [toQuoteLine(CATALOG.find(c => c.hubspotProductId === POS_ID)!, 1)];

  it("charges the install and the training at list, untouched", () => {
    const built = buildQuote("all_in_one", picked, [], CATALOG);
    expect(built.quoteLines.filter(l => l.discountPercent != null)).toEqual([]);
    // $698 wifi + $999 install + $499 training + $749 POS + $300 AMS1.
    expect(built.totals.oneTime).toBe(3245);
  });
});

describe("buildQuote with adjustments", () => {
  const picked = [toQuoteLine(CATALOG.find(c => c.hubspotProductId === POS_ID)!, 1)];
  // The standing service comp ended 2026-10-18 and the list is empty. The
  // mechanism stays for the next promotion, so this block exercises it with
  // the install and the training put back on it.
  beforeEach(() => { COMPED_SERVICE_PRODUCT_IDS.push(INSTALL_ID, TRAINING_ID); });
  afterEach(() => { COMPED_SERVICE_PRODUCT_IDS.length = 0; });

  it("comps a DERIVED install line — the discount reps actually write most", () => {
    const adjustments: QuoteAdjustments = { [INSTALL_ID]: { discountPercent: 100 } };
    const built = buildQuote("all_in_one", picked, [], CATALOG, adjustments, 100);

    const install = built.quoteLines.find(l => l.hubspotProductId === INSTALL_ID)!;
    expect(install.discountPercent).toBe(100);
    expect(lineNetAmount(install)).toBe(0);
    // $698 wifi + $749 POS + $300 AMS1 (one per POS). The install AND the
    // training are both comped — the install by this adjustment, the training
    // by standing AIO policy (see COMPED_SERVICE_PRODUCT_IDS).
    expect(built.totals.oneTime).toBe(1747);
    expect(built.blockers).toEqual([]);
  });

  it("delays the DERIVED platform line until the restaurant opens", () => {
    const adjustments: QuoteAdjustments = {
      [PLATFORM_ID]: { billingStart: { mode: "date", date: "2026-11-01" } },
    };
    const built = buildQuote("all_in_one", picked, [], CATALOG, adjustments, 100);
    const platform = built.quoteLines.find(l => l.hubspotProductId === PLATFORM_ID)!;
    expect(platform.billingStart).toEqual({ mode: "date", date: "2026-11-01" });
    // Still the full monthly figure — a delay is not a discount.
    expect(built.totals.recurring).toEqual([{ frequency: "monthly", amount: 399 }]);
  });

  it("blocks the whole quote when a discount is over the cap", () => {
    const built = buildQuote("all_in_one", picked, [], CATALOG, { [POS_ID]: { discountPercent: 90 } }, 50);
    expect(built.blockers).toHaveLength(1);
    expect(built.blockers[0]).toContain("POS Unit");
  });

  it("applies no REP adjustment when none is passed — only the standing comp", () => {
    const built = buildQuote("all_in_one", picked, [], CATALOG);
    // The install and the training carry a 100% discount with no adjustment at
    // all: that is AIO policy off the AE price sheet, not a rep's edit. Every
    // other line is untouched.
    expect(
      built.quoteLines.filter(l => l.discountPercent !== undefined).map(l => l.name).sort()
    ).toEqual(["Onsite Installation", "System Onboarding and Training"]);
    expect(built.quoteLines.every(l => l.billingStart === undefined)).toBe(true);
  });

  // The cap bounds what a REP may give away. The standing comp is not that,
  // and at the default 50% cap an un-exempted comp would refuse every quote.
  it("never blocks a quote on the standing comp, even at a low discount cap", () => {
    const built = buildQuote("all_in_one", picked, [], CATALOG, {}, 10);
    expect(built.blockers).toEqual([]);
  });

  it("lets a rep's explicit discount win over the standing comp", () => {
    const adjustments: QuoteAdjustments = { [INSTALL_ID]: { discountPercent: 50 } };
    const built = buildQuote("all_in_one", picked, [], CATALOG, adjustments, 100);
    const install = built.quoteLines.find(l => l.hubspotProductId === INSTALL_ID)!;
    expect(install.discountPercent).toBe(50);
  });

  // The cap bounds rep discretion, and a figure the rep chose on a comped line
  // is still rep discretion — only the policy 100% is exempt.
  it("still caps a rep's own over-limit discount on a comped line", () => {
    const adjustments: QuoteAdjustments = { [INSTALL_ID]: { discountPercent: 80 } };
    const built = buildQuote("all_in_one", picked, [], CATALOG, adjustments, 50);
    expect(built.blockers.join(" ")).toMatch(/Onsite Installation.*80%/);
  });

  // The failure this is here to prevent: a rep touches an unrelated control on
  // a comped line and silently puts $999 back on the quote, because
  // applyLineAdjustment clears discountPercent when an adjustment carries none.
  it("keeps the comp when a rep only delays the billing start on that line", () => {
    const adjustments: QuoteAdjustments = {
      [INSTALL_ID]: { billingStart: { mode: "days", days: 30 } },
    };
    const built = buildQuote("all_in_one", picked, [], CATALOG, adjustments, 100);
    const install = built.quoteLines.find(l => l.hubspotProductId === INSTALL_ID)!;
    expect(install.discountPercent).toBe(100);
    expect(lineNetAmount(install)).toBe(0);
  });
});

describe("reopening a saved quote", () => {
  it("carries a derived line's adjustment back, which the picks deliberately drop", () => {
    const picked = [toQuoteLine(CATALOG.find(c => c.hubspotProductId === POS_ID)!, 1)];
    const saved = buildQuote("all_in_one", picked, [], CATALOG, {
      [INSTALL_ID]: { discountPercent: 100 },
      [PLATFORM_ID]: { billingStart: { mode: "days", days: 60 } },
    }, 100).quoteLines;

    // The picks drop derived lines — that is their job, they get re-derived.
    // The POS's AMS1 is a pick like any other, so it comes back.
    expect(picksFromQuoteLines(saved, "all_in_one").map(x => x.hubspotProductId)).toEqual([POS_ID, AMS1_ID]);

    // The adjustments must NOT, or the comped install silently returns to $999.
    const reopened = adjustmentsFromQuoteLines(saved);
    expect(reopened[INSTALL_ID]).toEqual({ discountPercent: 100 });
    expect(reopened[PLATFORM_ID]).toEqual({ billingStart: { mode: "days", days: 60 } });

    // And a round trip through buildQuote reproduces the same lines.
    const rebuilt = buildQuote("all_in_one", picked, [], CATALOG, reopened, 100);
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
    expect(toLineItemProperties(line())).not.toHaveProperty("discount");
  });

  // HubSpot's `discount` is PER UNIT — proven live by
  // scripts/probe-cash-discount.ts, because the portal couldn't answer it:
  // all 166 line items carrying one have quantity 1, where per-unit and
  // per-line agree. price 100 × qty 3 with discount 10 read back
  // amount 270.00 / hs_total_discount 30.00.
  describe("a cash discount", () => {
    it("divides the LINE total by quantity, because HubSpot's property is per-unit", () => {
      const props = toLineItemProperties(line({ unitPrice: 749, qty: 3, discountAmount: 747 }));
      expect(props.price).toBe("749");
      expect(props.quantity).toBe("3");
      expect(props.discount).toBe("249");
      // Never both levers: a line carrying each would bill one figure and
      // display the other.
      expect(props).not.toHaveProperty("hs_discount_percentage");
    });

    it("keeps six decimals on a quantity that doesn't divide evenly", () => {
      // $100 across 3 units. HubSpot keeps all six and rounds the TOTAL, not
      // the per-unit figure, so this bills exactly $100 off — the same probe
      // confirmed $1,000 off 7 × $999.99 as hs_total_discount 1000.00.
      // Rounded to 2dp here instead, it would take off $99.99.
      const props = toLineItemProperties(line({ unitPrice: 749, qty: 3, discountAmount: 100 }));
      expect(props.discount).toBe("33.333333");
    });

    it("sends it plainly on a single-unit line", () => {
      expect(toLineItemProperties(line({ unitPrice: 749, qty: 1, discountAmount: 100 })).discount).toBe("100");
    });

    it("wins over a percentage if a line somehow carried both", () => {
      // `applyLineAdjustment` guarantees it can't, so this is the boundary
      // backstop: one property, never two.
      const props = toLineItemProperties(line({ unitPrice: 100, qty: 1, discountAmount: 10, discountPercent: 50 }));
      expect(props.discount).toBe("10");
      expect(props).not.toHaveProperty("hs_discount_percentage");
    });
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

  // NOT cosmetic. HubSpot refuses to publish a payment-enabled quote carrying
  // a dated one-time line — 400 NON_RECURRING_FUTURE_BILLED_LI_NOT_ALLOWED,
  // proven live 2026-10-12 — and its own draft hs_quote_amount defers the line
  // happily, so nothing short of the publish call exposes it.
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

// ── Scoping a discount to part of a line ────────────────────────────────────
//
// "One of the three POS units is free." The alternative is 33.3333% across the
// line, which bills $1,498.07 rather than $1,498.00 at two decimal places — on
// a document that cannot be amended after publish.

describe("splitPartialDiscount", () => {
  const pos = (qty: number, over: Partial<QuoteLine> = {}): QuoteLine => ({
    ...toQuoteLine(CATALOG.find(c => c.hubspotProductId === POS_ID)!, qty),
    ...over,
  });

  it("splits the line into the discounted units and the rest", () => {
    const [discounted, rest] = splitPartialDiscount(pos(3, { discountPercent: 100 }), { discountPercent: 100, discountQty: 1 });
    expect(discounted).toMatchObject({ qty: 1, discountPercent: 100 });
    expect(rest.qty).toBe(2);
    expect(rest.discountPercent).toBeUndefined();
  });

  it("gives the exact money a percentage can't", () => {
    const lines = splitPartialDiscount(pos(3, { discountPercent: 100 }), { discountPercent: 100, discountQty: 1 });
    const net = lines.reduce((sum, l) => sum + lineNetAmount(l), 0);
    expect(net).toBe(1498);
    // What the whole-line percentage would have billed instead.
    expect(lineNetAmount(pos(3, { discountPercent: 33.33 }))).toBe(1498.07);
  });

  it("leaves the line alone when the discount covers all of it", () => {
    const l = pos(3, { discountPercent: 50 });
    expect(splitPartialDiscount(l, { discountPercent: 50, discountQty: 3 })).toEqual([l]);
    expect(splitPartialDiscount(l, { discountPercent: 50 })).toEqual([l]);
  });

  it("clamps a stale quantity left over from a bigger line rather than refusing", () => {
    const l = pos(2, { discountPercent: 50 });
    expect(splitPartialDiscount(l, { discountPercent: 50, discountQty: 5 })).toEqual([l]);
  });

  it("does nothing without a discount to scope", () => {
    const l = pos(3);
    expect(splitPartialDiscount(l, { discountQty: 1 })).toEqual([l]);
  });

  it("never splits a package-covered line — it is wholly paid for", () => {
    const l = pos(3, { discountPercent: 100, coveredByPackage: "QSR Kit" });
    expect(splitPartialDiscount(l, { discountPercent: 100, discountQty: 1 })).toEqual([l]);
  });
});

describe("discountQtyBlockers", () => {
  const lines = [toQuoteLine(CATALOG.find(c => c.hubspotProductId === POS_ID)!, 3)];

  it("passes a whole positive number", () => {
    expect(discountQtyBlockers({ [POS_ID]: { discountPercent: 50, discountQty: 2 } }, lines)).toEqual([]);
    expect(discountQtyBlockers({ [POS_ID]: { discountPercent: 50 } }, lines)).toEqual([]);
  });

  it("refuses a fraction or a zero, and names the product", () => {
    const [msg] = discountQtyBlockers({ [POS_ID]: { discountQty: 1.5 } }, lines);
    expect(msg).toContain("POS Unit");
    expect(discountQtyBlockers({ [POS_ID]: { discountQty: 0 } }, lines)).toHaveLength(1);
    expect(discountQtyBlockers({ [POS_ID]: { discountQty: -1 } }, lines)).toHaveLength(1);
  });
});

describe("a scoped discount through buildQuote", () => {
  const picked = [toQuoteLine(CATALOG.find(c => c.hubspotProductId === POS_ID)!, 3)];
  const adjustments: QuoteAdjustments = { [POS_ID]: { discountPercent: 100, discountQty: 1 } };

  it("puts two POS lines on the quote and charges for two units", () => {
    const built = buildQuote("all_in_one", picked, [], CATALOG, adjustments, 100);
    const pos = built.quoteLines.filter(l => l.hubspotProductId === POS_ID);
    expect(pos.map(l => [l.qty, l.discountPercent ?? null])).toEqual([[1, 100], [2, null]]);
    expect(pos.reduce((sum, l) => sum + lineNetAmount(l), 0)).toBe(1498);
  });

  it("counts ordering points off the picks, so splitting can't move the platform tier", () => {
    const split = buildQuote("all_in_one", picked, [], CATALOG, adjustments, 100);
    const whole = buildQuote("all_in_one", picked, [], CATALOG, {}, 100);
    expect(split.orderPoints.total).toBe(3);
    expect(split.platform.productName).toBe(whole.platform.productName);
  });

  it("refuses a scoped discount over the cap, same as any other", () => {
    const built = buildQuote("all_in_one", picked, [], CATALOG, adjustments, 50);
    expect(built.blockers.join(" ")).toMatch(/POS Unit.*100%/);
  });

  it("round-trips: the quantity is recovered, not widened to the whole line", () => {
    const saved = buildQuote("all_in_one", picked, [], CATALOG, adjustments, 100).quoteLines;

    expect(picksFromQuoteLines(saved, "all_in_one")).toContainEqual({ hubspotProductId: POS_ID, qty: 3 });
    const reopened = adjustmentsFromQuoteLines(saved);
    expect(reopened[POS_ID]).toEqual({ discountPercent: 100, discountQty: 1 });

    expect(buildQuote("all_in_one", picked, [], CATALOG, reopened, 100).quoteLines).toEqual(saved);
  });

  it("does not invent a quantity when the discount covered the whole line", () => {
    const saved = buildQuote("all_in_one", picked, [], CATALOG, { [POS_ID]: { discountPercent: 40 } }, 100).quoteLines;
    expect(adjustmentsFromQuoteLines(saved)[POS_ID]).toEqual({ discountPercent: 40 });
  });
});

// Several units on one line, each treated differently: one free, one whose
// billing starts later. The line splits by what the units came out as, never
// into a line per unit, and reopens the way it was saved.
describe("adjusting each unit separately", () => {
  const SUB_ID = "999000111";
  const catalog = [...CATALOG, p(SUB_ID, "Kitchen Display Subscription", 50, "monthly", "software")];
  const sub = catalog.find(c => c.hubspotProductId === SUB_ID)!;
  const posProduct = catalog.find(c => c.hubspotProductId === POS_ID)!;
  const subQty = (qty: number) => [toQuoteLine(sub, qty)];
  const subLines = (lines: QuoteLine[]) => lines.filter(l => l.hubspotProductId === SUB_ID);

  it("groups identical units and splits the rest", () => {
    const built = buildQuote("all_in_one", subQty(3), [], catalog, {
      [SUB_ID]: { units: [{}, { billingStart: { mode: "days", days: 60 } }, { billingStart: { mode: "days", days: 60 } }] },
    }, 100);
    expect(subLines(built.quoteLines).map(l => [l.qty, l.billingStart ?? null])).toEqual([
      [1, null],
      [2, { mode: "days", days: 60 }],
    ]);
  });

  it("discounts and delays different units independently", () => {
    const built = buildQuote("all_in_one", subQty(3), [], catalog, {
      [SUB_ID]: { units: [{ discountPercent: 100 }, { billingStart: { mode: "days", days: 30 } }, {}] },
    }, 100);
    expect(subLines(built.quoteLines).map(l => [l.qty, l.discountPercent ?? null, l.billingStart?.mode ?? null])).toEqual([
      [1, 100, null],
      [1, null, "days"],
      [1, null, null],
    ]);
  });

  it("conserves quantity and bills the right money", () => {
    const built = buildQuote("all_in_one", subQty(3), [], catalog, {
      [SUB_ID]: { units: [{ discountPercent: 100 }, {}, {}] },
    }, 100);
    const lines = subLines(built.quoteLines);
    expect(lines.reduce((s, l) => s + l.qty, 0)).toBe(3);
    expect(lines.reduce((s, l) => s + lineNetAmount(l), 0)).toBe(100);
  });

  it("replaces the line-level edits instead of stacking on them", () => {
    const built = buildQuote("all_in_one", subQty(2), [], catalog, {
      [SUB_ID]: { discountPercent: 50, units: [{}, {}] },
    }, 100);
    expect(subLines(built.quoteLines)).toHaveLength(1);
    expect(subLines(built.quoteLines)[0].discountPercent).toBeUndefined();
  });

  it("leaves a unit past the end of the array unadjusted", () => {
    const built = buildQuote("all_in_one", subQty(3), [], catalog, {
      [SUB_ID]: { units: [{ discountPercent: 100 }] },
    }, 100);
    expect(subLines(built.quoteLines).map(l => [l.qty, l.discountPercent ?? null])).toEqual([[1, 100], [2, null]]);
  });

  it("drops a one-time line's billing start, same as the whole-line path", () => {
    const built = buildQuote("all_in_one", [toQuoteLine(posProduct, 2)], [], catalog, {
      [POS_ID]: { units: [{ discountPercent: 100 }, { billingStart: { mode: "days", days: 60 } }] },
    }, 100);
    const pos = built.quoteLines.filter(l => l.hubspotProductId === POS_ID);
    expect(pos.every(l => l.billingStart === undefined)).toBe(true);
    expect(pos.map(l => [l.qty, l.discountPercent ?? null])).toEqual([[1, 100], [1, null]]);
  });

  it("still enforces the discount cap and date validity per unit", () => {
    const over = buildQuote("all_in_one", subQty(2), [], catalog, {
      [SUB_ID]: { units: [{ discountPercent: 80 }, {}] },
    }, 50);
    expect(over.blockers.join(" ")).toMatch(/Kitchen Display Subscription.*80%/);

    const badDate = buildQuote("all_in_one", subQty(2), [], catalog, {
      [SUB_ID]: { units: [{}, { billingStart: { mode: "date", date: "2026-02-31" } }] },
    }, 100);
    expect(badDate.blockers.join(" ")).toMatch(/billing start date/);
  });

  it("survives junk from the browser", () => {
    expect(() =>
      buildQuote("all_in_one", subQty(2), [], catalog, {
        [SUB_ID]: { units: [null, "x"] as never },
      }, 100)
    ).not.toThrow();
  });

  it("round-trips mixed billing starts as per-unit edits", () => {
    const adjustments: QuoteAdjustments = {
      [SUB_ID]: { units: [{ discountPercent: 100 }, { billingStart: { mode: "days", days: 60 } }, {}] },
    };
    const saved = buildQuote("all_in_one", subQty(3), [], catalog, adjustments, 100).quoteLines;
    expect(picksFromQuoteLines(saved, "all_in_one")).toContainEqual({ hubspotProductId: SUB_ID, qty: 3 });

    const reopened = adjustmentsFromQuoteLines(saved);
    expect(reopened[SUB_ID].units).toHaveLength(3);
    expect(buildQuote("all_in_one", subQty(3), [], catalog, reopened, 100).quoteLines).toEqual(saved);
  });

  it("still reopens a simple '1 of 3 free' the old way", () => {
    const saved = buildQuote("all_in_one", subQty(3), [], catalog, {
      [SUB_ID]: { discountPercent: 100, discountQty: 1 },
    }, 100).quoteLines;
    expect(adjustmentsFromQuoteLines(saved)[SUB_ID]).toEqual({ discountPercent: 100, discountQty: 1 });
  });
});

describe("the pre-authorization charge", () => {
  const pos = CATALOG.find(c => c.hubspotProductId === POS_ID)!;
  const preAuthLines = (lines: QuoteLine[]) =>
    lines.filter(l => l.hubspotProductId === PRE_AUTH_PRODUCT.hubspotProductId);
  // A quote that owes nothing today: the platform starts in 60 days and the
  // hardware and services are given away (install and training are charged
  // at list since 2026-10-18, so they have to be given away explicitly).
  const delayedAll: QuoteAdjustments = {
    [PLATFORM_ID]: { billingStart: { mode: "days", days: 60 } },
    [POS_ID]: { discountPercent: 100 },
    [WIFI_ID]: { discountPercent: 100 },
    [AMS1_ID]: { discountPercent: 100 },
    [INSTALL_ID]: { discountPercent: 100 },
    [TRAINING_ID]: { discountPercent: 100 },
  };
  const build = (adj: QuoteAdjustments, catalog = CATALOG) =>
    buildQuote("all_in_one", [toQuoteLine(pos, 1)], [], catalog, adj, 100);

  it("is added when nothing else is due at checkout, making the quote sendable", () => {
    const built = build(delayedAll);
    expect(preAuthLines(built.quoteLines)).toHaveLength(1);
    expect(built.totals.oneTime).toBe(0.5);
    expect(built.blockers).toEqual([]);
  });

  it("is left off a quote that already collects something at checkout", () => {
    expect(preAuthLines(build({ [PLATFORM_ID]: { billingStart: { mode: "days", days: 60 } } }).quoteLines)).toHaveLength(0);
    expect(preAuthLines(build({}).quoteLines)).toHaveLength(0);
  });

  it("goes away again when the rep undoes the delay", () => {
    const { [PLATFORM_ID]: _undone, ...rest } = delayedAll;
    expect(preAuthLines(build(rest).quoteLines)).toHaveLength(0);
  });

  it("can't be discounted, delayed or resized by an adjustment", () => {
    const id = PRE_AUTH_PRODUCT.hubspotProductId;
    const built = build({ ...delayedAll, [id]: { discountPercent: 100, billingStart: { mode: "days", days: 30 } } });
    const [line] = preAuthLines(built.quoteLines);
    expect(line.discountPercent).toBeUndefined();
    expect(line.billingStart).toBeUndefined();
    expect(line.qty).toBe(1);
    expect(line.unitPrice).toBe(0.5);
  });

  it("is never pickable, and never read back as a pick", () => {
    const preAuth = CATALOG.find(c => c.hubspotProductId === PRE_AUTH_PRODUCT.hubspotProductId)!;
    expect(isAllowedForQuoteType(preAuth, "all_in_one")).toBe(false);
    const built = build(delayedAll);
    expect(picksFromQuoteLines(built.quoteLines, "all_in_one").some(
      pick => pick.hubspotProductId === PRE_AUTH_PRODUCT.hubspotProductId
    )).toBe(false);
    expect(adjustmentsFromQuoteLines(built.quoteLines)[PRE_AUTH_PRODUCT.hubspotProductId]).toBeUndefined();
  });

  it("does not rescue a quote that nets to $0 on its real lines", () => {
    const built = build({ ...delayedAll, [PLATFORM_ID]: { discountPercent: 100, billingStart: { mode: "days", days: 60 } } });
    expect(built.blockers.some(b => b.includes("nets to $0"))).toBe(true);
  });

  it("blocks, naming the product, when it is missing from the catalog", () => {
    const withoutPreAuth = CATALOG.filter(c => c.hubspotProductId !== PRE_AUTH_PRODUCT.hubspotProductId);
    const built = build(delayedAll, withoutPreAuth);
    expect(built.blockers.some(b => b.includes(PRE_AUTH_PRODUCT.name))).toBe(true);
  });

  it("never appears on a rate-only quote", () => {
    const built = buildQuote("all_in_one", [], [], CATALOG, {}, 100);
    expect(preAuthLines(built.quoteLines)).toHaveLength(0);
  });
});

// ── The cash lever, through the engine ──────────────────────────────────────
// Added 2026-10-14 when the dollar control stopped being a percentage in
// disguise. The thing worth pinning is that a rep's figure survives intact:
// the arithmetic subtracts it, the cap still bounds it, and nothing anywhere
// converts it into a percentage that can't be billed.
describe("a cash discount through the engine", () => {
  const cash = (over: Partial<QuoteLine>) => line({ unitPrice: 749, qty: 3, ...over });

  it("subtracts exactly, at a quantity a percentage could not express", () => {
    const l = cash({ discountAmount: 100 });
    expect(lineListAmount(l)).toBe(2247);
    expect(lineNetAmount(l)).toBe(2147);
    expect(lineDiscountAmount(l)).toBe(100);
  });

  it("wins over a percentage on the same line, matching the HubSpot boundary", () => {
    expect(lineNetAmount(cash({ discountAmount: 100, discountPercent: 50 }))).toBe(2147);
  });

  it("never bills backwards on a stale amount larger than the line", () => {
    // The rep set $5,000 off and then lowered the quantity. `lineNetAmount`
    // floors at zero; `adjustmentBlockers` is what actually reports it.
    expect(lineNetAmount(cash({ qty: 1, discountAmount: 5000 }))).toBe(0);
  });

  it("is held to the SAME admin cap as a percentage, converted", () => {
    // Without this the dollar box walks straight around the limit: $700 off
    // a $749 line is 93%, and the percentage check never looks at it.
    const blockers = adjustmentBlockers([cash({ qty: 1, discountAmount: 700 })], 50);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("over the 50% limit");
  });

  it("passes the cap when it is genuinely under it", () => {
    expect(adjustmentBlockers([cash({ qty: 1, discountAmount: 300 })], 50)).toEqual([]);
  });

  it("REFUSES an amount larger than the line rather than making it free", () => {
    // Unlike `discountQty`, which clamps: a quantity past the line can only
    // mean "all of them", but a discount past the price is a typo or a line
    // the rep shrank, and silently zeroing it is worth more than $0.
    const blockers = adjustmentBlockers([cash({ qty: 1, discountAmount: 5000 })], 100);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("more than the line's");
  });

  it("round-trips through a reopen as cash, not as a percentage", () => {
    const saved = [cash({ discountAmount: 100 })];
    expect(adjustmentsFromQuoteLines(saved)[POS_ID]).toEqual({ discountAmount: 100 });
  });

  it("splits by quantity like a percentage does, and the remainder is at list", () => {
    const [covered, rest] = splitPartialDiscount(cash({ discountAmount: 100 }), { discountQty: 1 });
    expect(covered.qty).toBe(1);
    expect(covered.discountAmount).toBe(100);
    expect(rest.qty).toBe(2);
    // The whole figure left on the remainder would take $100 off twice.
    expect(rest.discountAmount).toBeUndefined();
    expect(lineNetAmount(covered) + lineNetAmount(rest)).toBe(2147);
  });

  it("is cleared by a policy comp, which would otherwise be outranked", () => {
    // `lineNetAmount` reads the cash lever FIRST, so a leftover amount on a
    // comped line would quietly beat the 100%.
    const comped = applyPackageComp(cash({ discountAmount: 100, coveredByPackage: "QSR Kit" }));
    expect(comped.discountPercent).toBe(100);
    expect(comped.discountAmount).toBeUndefined();
    expect(lineNetAmount(comped)).toBe(0);
  });
});
