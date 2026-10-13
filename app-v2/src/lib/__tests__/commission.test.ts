import { describe, it, expect } from "vitest";
import {
  ACTIVATION_COMMISSION_BPS,
  DEFAULT_HARDWARE_COMMISSION_POLICY,
  SIGNING_COMMISSION_BPS,
  commissionFromTotalArr,
  estimatedRecurringArrFromQuoteLines,
  hardwareCommission,
  sumArrOrNull,
} from "@/lib/commission";
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
