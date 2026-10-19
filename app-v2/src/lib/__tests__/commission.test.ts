import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ACTIVATION_COMMISSION_BPS,
  DEFAULT_HARDWARE_COMMISSION_POLICY,
  SIGNING_COMMISSION_BPS,
  commissionFromTotalArr,
  estimatedRecurringArrFromQuoteLines,
  hardwareCommission,
  commissionRateToBps,
  isPolicyComped,
  lineHardwareCommission,
  quoteHardwareCommission,
  sumArrOrNull,
} from "@/lib/commission";
import { COMPED_SERVICE_PRODUCT_IDS, PRE_AUTH_PRODUCT, PROCESSING_DISCLOSURE_PRODUCT } from "@/lib/quoting";
import type { QuoteLine } from "@/types/merchant";

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  hubspotProductId: "335283119838",
  name: "All-in-One Platform",
  qty: 1,
  unitPrice: 399,
  billingFrequency: "monthly",
  productType: "Software",
  ...over,
});

describe("the processing-commission split", () => {
  it("is 5%/5%, matching HubSpot's own existing split", () => {
    expect(SIGNING_COMMISSION_BPS).toBe(500);
    expect(ACTIVATION_COMMISSION_BPS).toBe(500);
  });
});

describe("commissionFromTotalArr", () => {
  it("splits total ARR 5%/5%, and totals them", () => {
    const c = commissionFromTotalArr(100_000);
    expect(c.totalArr).toBe(100_000);
    expect(c.signingCommission).toBe(5_000);
    expect(c.activationCommission).toBe(5_000);
    expect(c.total).toBe(10_000);
  });

  it("omits rather than zeroes when there's no ARR to split", () => {
    const c = commissionFromTotalArr(null);
    expect(c.totalArr).toBeNull();
    expect(c.signingCommission).toBeNull();
    expect(c.activationCommission).toBeNull();
    expect(c.total).toBeNull();
  });

  it("omits on a non-finite ARR rather than propagating NaN/Infinity", () => {
    expect(commissionFromTotalArr(NaN).total).toBeNull();
    expect(commissionFromTotalArr(Infinity).total).toBeNull();
  });

  it("rounds each half to the nearest dollar", () => {
    // $333.33 total ARR -> 5% = $16.6665, rounds to $17.
    const c = commissionFromTotalArr(333.33);
    expect(c.signingCommission).toBe(17);
    expect(c.activationCommission).toBe(17);
  });
});

describe("sumArrOrNull", () => {
  it("is null+null -> null", () => {
    expect(sumArrOrNull(null, null)).toBeNull();
  });

  it("passes either side through alone", () => {
    expect(sumArrOrNull(100, null)).toBe(100);
    expect(sumArrOrNull(null, 200)).toBe(200);
  });

  it("sums both when both exist, including a case neither is null but one is 0", () => {
    expect(sumArrOrNull(100, 200)).toBe(300);
    expect(sumArrOrNull(0, 200)).toBe(200);
  });
});

describe("estimatedRecurringArrFromQuoteLines — DISPLAY ESTIMATE ONLY, never the writeback basis", () => {
  it("is null with no lines", () => {
    expect(estimatedRecurringArrFromQuoteLines([])).toBeNull();
  });

  it("annualises the recurring (monthly-equivalent) side only, excluding one-time hardware", () => {
    const lines = [
      line({ billingFrequency: "monthly", unitPrice: 399 }), // platform fee
      line({ hubspotProductId: "hw-1", name: "POS Unit", billingFrequency: "one_time", unitPrice: 749, productType: "Hardware" }),
    ];
    // $399/mo * 12 = $4,788/yr. The one-time hardware sale contributes nothing.
    // (A live equivalent deal's real `saas_revenue` is $4,788.50 — this
    // estimate is proven to miss the $0.50 pre-auth line; see
    // lib/billing/commissionWriteback.ts, which does NOT use this function.)
    expect(estimatedRecurringArrFromQuoteLines(lines)).toBe(4788);
  });

  it("respects a line discount", () => {
    const lines = [line({ billingFrequency: "monthly", unitPrice: 399, discountPercent: 50 })];
    expect(estimatedRecurringArrFromQuoteLines(lines)).toBe(Math.round(399 * 0.5 * 12));
  });

  it("is null when every line is one-time (a pure hardware sale, no recurring ARR)", () => {
    const lines = [line({ billingFrequency: "one_time", unitPrice: 749 })];
    expect(estimatedRecurringArrFromQuoteLines(lines)).toBeNull();
  });
});

describe("hardwareCommission — the data-gap guard", () => {
  it("is unset by default, contributing exactly zero regardless of margin", () => {
    expect(DEFAULT_HARDWARE_COMMISSION_POLICY.hardwareCommissionBps).toBeNull();
    expect(hardwareCommission(10_000, DEFAULT_HARDWARE_COMMISSION_POLICY)).toBe(0);
  });

  it("is zero with a rate configured but zero margin — there is no cost data to produce a margin from", () => {
    // This is the honest state of every real call site today: a rate CAN be
    // set, but nothing in this codebase can supply a non-zero margin to
    // multiply it by (see this function's own doc comment).
    expect(hardwareCommission(0, { hardwareCommissionBps: 1000 })).toBe(0);
  });

  it("once a rate is set, applies it to whatever margin it's given", () => {
    // Demonstrates the formula is correct and ready — the only thing missing
    // in production is a non-zero hardwareMargin input.
    expect(hardwareCommission(1000, { hardwareCommissionBps: 1000 })).toBeCloseTo(100, 6); // 10% of $1,000
  });

  it("can go negative — a negative hardware margin (a loss-leader deal) produces a negative commission", () => {
    expect(hardwareCommission(-500, { hardwareCommissionBps: 1000 })).toBeCloseTo(-50, 6);
  });
});

// ── Per-product hardware commission (2026-10-13), the replacement design ──

describe("commissionRateToBps", () => {
  // HubSpot stores the rate as a DECIMAL FRACTION despite labelling the
  // property "Rep Commission %" — confirmed by the product owner 2026-10-14
  // against the real values. The live catalog's hardware rate is 0.6, and
  // reading that as 0.6% would pay an AE $4.53 on a Mega Kiosk whose margin
  // is $755, instead of $453.
  it("reads the stored value as a fraction: 0.6 is 60%", () => {
    expect(commissionRateToBps(0.6)).toBe(6000);
    expect(commissionRateToBps(0.1)).toBe(1000);
    expect(commissionRateToBps(0.45)).toBe(4500);
    expect(commissionRateToBps(0.05)).toBe(500);
    expect(commissionRateToBps(1)).toBe(10000);
    expect(commissionRateToBps(0)).toBe(0);
  });

  it("is null, not 0, when the property is unset", () => {
    expect(commissionRateToBps(null)).toBeNull();
  });

  it("is null on a non-finite input rather than propagating NaN/Infinity", () => {
    expect(commissionRateToBps(NaN)).toBeNull();
    expect(commissionRateToBps(Infinity)).toBeNull();
  });
});

describe("isPolicyComped", () => {
  const INSTALL = "223452690133"; // Onsite Installation
  // The service comp ended 2026-10-18 and the list is empty; the mechanism is
  // kept for the next promotion, so it is exercised with the install on it.
  beforeEach(() => { COMPED_SERVICE_PRODUCT_IDS.push(INSTALL); });
  afterEach(() => { COMPED_SERVICE_PRODUCT_IDS.length = 0; });

  it("is true for a package/plan-covered line", () => {
    expect(isPolicyComped(hwLine({ coveredByPackage: "QSR Kit", discountPercent: 100 }))).toBe(true);
  });

  it("is true for a comped service sitting at exactly $0", () => {
    const install = hwLine({
      hubspotProductId: INSTALL, name: "Onsite Installation",
      qty: 1, unitPrice: 999, discountPercent: 100,
    });
    expect(isPolicyComped(install)).toBe(true);
  });

  it("is FALSE for that same service when a rep discounted it only partway", () => {
    // Still AIO's product, but the money on it is now the rep's decision, so
    // it is theirs to lose — the case the never-clamp rule is actually for.
    const install = hwLine({
      hubspotProductId: INSTALL, name: "Onsite Installation",
      qty: 1, unitPrice: 999, discountPercent: 50,
    });
    expect(isPolicyComped(install)).toBe(false);
  });

  it("is FALSE for an ordinary line a rep discounted 100%", () => {
    expect(isPolicyComped(hwLine({ discountPercent: 100 }))).toBe(false);
  });
});

const hwLine = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  hubspotProductId: "hw-1",
  name: "POS Unit",
  qty: 2,
  unitPrice: 500,
  billingFrequency: "one_time",
  productType: "Hardware",
  ...over,
});

describe("lineHardwareCommission", () => {
  it("computes ((qty*netPrice) - (qty*cost)) * rate for a plain line", () => {
    // 2 units at $500 = $1,000 net. Cost $300/unit = $600 total. Margin $400.
    const result = lineHardwareCommission(
      hwLine({ costToRep: 300, repCommissionBps: 1000, rsmCommissionBps: 500 }) // 10% / 5%
    );
    expect(result.rep).toBeCloseTo(40, 6); // 10% of $400
    expect(result.rsm).toBeCloseTo(20, 6); // 5% of $400
  });

  it("respects a line discount — margin is computed off the DISCOUNTED net amount", () => {
    // 2 units at $500 list, 50% off -> $500 net. Cost $300/unit = $600 total.
    // Margin is NEGATIVE here, which is the next test's point, so use a
    // smaller cost to keep this one a plain positive-margin discount case.
    const result = lineHardwareCommission(
      hwLine({ costToRep: 100, discountPercent: 50, repCommissionBps: 1000 })
    );
    // net = 500*2*0.5 = 500; cost = 100*2 = 200; margin = 300; 10% = 30
    expect(result.rep).toBeCloseTo(30, 6);
  });

  it("earns NOTHING on hardware AIO comps itself — not a negative (2026-10-14)", () => {
    // The in-plan QSR Kit hardware sits at 100% off by AIO's decision, not the
    // rep's. Counting its full cost against them put -$1,635.90 on a kit quote.
    const result = lineHardwareCommission(
      hwLine({ costToRep: 300, discountPercent: 100, coveredByPackage: "QSR Kit", repCommissionBps: 1000 })
    );
    expect(result.status).toBe("included");
    expect(result.rep).toBeNull();
    expect(result.rsm).toBeNull();
  });

  it("STILL goes negative, unclamped, when the REP discounts below AIO's cost", () => {
    // What "Cost to Rep" means in HubSpot: "Minimum Price rep can discount to
    // before eating into commissions." 2 units at $500 list, 90% off -> $100
    // net; cost $600; margin -$500; 10% = -$50.
    const result = lineHardwareCommission(
      hwLine({ costToRep: 300, discountPercent: 90, repCommissionBps: 1000 })
    );
    expect(result.status).toBe("computed");
    expect(result.rep).toBeCloseTo(-50, 6);
  });

  it("reports WHY there is no figure, so an unpriced product can't read as a zero one", () => {
    expect(lineHardwareCommission(hwLine({ costToRep: null })).status).toBe("no_cost");
    expect(lineHardwareCommission(hwLine({ costToRep: 300 })).status).toBe("no_rate");
    expect(lineHardwareCommission(hwLine({ billingFrequency: "monthly" })).status).toBe("recurring");
    expect(lineHardwareCommission(hwLine({ costToRep: 0, repCommissionBps: 6000 })).status).toBe("computed");
  });

  it("contributes nothing (null) when cost is missing, even with a rate set", () => {
    const result = lineHardwareCommission(hwLine({ costToRep: null, repCommissionBps: 1000 }));
    expect(result.rep).toBeNull();
    expect(result.rsm).toBeNull();
  });

  it("contributes nothing (null) when the rate is missing, even with a cost set", () => {
    const result = lineHardwareCommission(hwLine({ costToRep: 300, repCommissionBps: null, rsmCommissionBps: null }));
    expect(result.rep).toBeNull();
    expect(result.rsm).toBeNull();
  });

  it("a literal 0 cost is honoured as a real zero, not treated as missing", () => {
    const result = lineHardwareCommission(hwLine({ costToRep: 0, repCommissionBps: 1000 }));
    // net = 1000; cost = 0; margin = 1000; 10% = 100.
    expect(result.rep).toBeCloseTo(100, 6);
  });

  it("excludes a RECURRING line regardless of cost/rate", () => {
    const result = lineHardwareCommission(
      hwLine({ billingFrequency: "monthly", costToRep: 300, repCommissionBps: 1000 })
    );
    expect(result.rep).toBeNull();
    expect(result.rsm).toBeNull();
  });
});

describe("quoteHardwareCommission", () => {
  it("sums rep/rsm across qualifying lines and lists the per-line rep figures", () => {
    const lines = [
      hwLine({ hubspotProductId: "a", costToRep: 100, repCommissionBps: 1000, unitPrice: 500, qty: 1 }), // margin 400 -> rep 40
      hwLine({ hubspotProductId: "b", costToRep: 50, repCommissionBps: 2000, unitPrice: 250, qty: 1 }),  // margin 200 -> rep 40
    ];
    const result = quoteHardwareCommission(lines);
    expect(result.rep).toBeCloseTo(80, 6);
    expect(result.perLine.map(l => l.hubspotProductId)).toEqual(["a", "b"]);
    expect(result.perLine.every(l => typeof l.rep === "number")).toBe(true);
  });

  it("reports a one-time line with no cost in missingCost", () => {
    const lines = [hwLine({ costToRep: null, repCommissionBps: 1000 })];
    const result = quoteHardwareCommission(lines);
    expect(result.missingCost).toEqual(["POS Unit"]);
    expect(result.rep).toBe(0);
  });

  it("reports a RECURRING line carrying a rate in recurringWithRate, and excludes it from the totals", () => {
    const lines = [
      hwLine({ billingFrequency: "monthly", unitPrice: 399, costToRep: 50, repCommissionBps: 1000, name: "All-in-One Platform" }),
    ];
    const result = quoteHardwareCommission(lines);
    expect(result.recurringWithRate).toEqual(["All-in-One Platform"]);
    expect(result.missingCost).toEqual([]);
    expect(result.rep).toBe(0);
    expect(result.perLine).toEqual([]);
  });

  it("a plain one-time line with cost but no rate contributes nothing and isn't flagged as missingCost", () => {
    const lines = [hwLine({ costToRep: 300, repCommissionBps: null, rsmCommissionBps: null })];
    const result = quoteHardwareCommission(lines);
    expect(result.missingCost).toEqual([]);
    expect(result.rep).toBe(0);
    expect(result.perLine[0].rep).toBeNull();
  });

  it("leaves comped hardware out of missingCost — there is no cost to go and fill in", () => {
    const lines = [
      hwLine({ costToRep: null, coveredByPackage: "QSR Kit", discountPercent: 100 }),
      hwLine({ hubspotProductId: "b", name: "Customer Facing Display", costToRep: null }),
    ];
    const result = quoteHardwareCommission(lines);
    expect(result.missingCost).toEqual(["Customer Facing Display"]);
    expect(result.rep).toBe(0);
  });

  it("leaves the rate disclosure and the pre-auth out of missingCost — they were never a sale", () => {
    // Both are derived, untouchable and will never carry a cost; before
    // 2026-10-16 they read as `no_cost`, so the AE's quote printed "n/a"
    // beside them and the admin gaps panel listed them as data to go and fix.
    const lines = [
      hwLine({
        hubspotProductId: PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId,
        name: PROCESSING_DISCLOSURE_PRODUCT.name, qty: 1, unitPrice: 0, costToRep: null,
      }),
      hwLine({
        hubspotProductId: PRE_AUTH_PRODUCT.hubspotProductId,
        name: PRE_AUTH_PRODUCT.name, qty: 1, unitPrice: 0.5, costToRep: null,
      }),
      hwLine({ hubspotProductId: "b", name: "Customer Facing Display", costToRep: null }),
    ];
    const result = quoteHardwareCommission(lines);
    expect(result.perLine.map(l => l.status)).toEqual(["not_commissionable", "not_commissionable", "no_cost"]);
    expect(result.missingCost).toEqual(["Customer Facing Display"]);
  });

  it("is all zero/empty for an empty quote", () => {
    const result = quoteHardwareCommission([]);
    expect(result).toEqual({ rep: 0, rsm: 0, perLine: [], missingCost: [], recurringWithRate: [] });
  });
});
