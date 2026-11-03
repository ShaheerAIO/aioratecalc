// The limits an admin may approve on a single quote (2026-11-02): CP rate,
// CNP rate, per-product discount caps and unit caps. Pure layer only.
import { describe, it, expect } from "vitest";
import { overrideFingerprint, rateOverrides, type RateOverrideInput } from "@/lib/quoteOverrides";
import { adjustmentBlockers, COMPED_SERVICE_PRODUCT_IDS } from "@/lib/quoting";
import { adjustBpsRangeFor, commissionMarginBreakdown } from "@/lib/wholesale";
import { DEFAULT_QUOTE_RATES, type QuoteLine, type QuoteOverride } from "@/types/merchant";

const CLEAR: RateOverrideInput = {
  pricing: { belowMarginFloor: false, belowMonthlyRevenueFloor: false, monthlyProcessingRevenue: 250 },
  cardPresentBps: 249,
  cpAdjustmentBps: 0,
  adjustBpsRange: { min: -29, max: 23 },
  cardNotPresentBps: 330,
  policyCardNotPresentBps: 330,
};

describe("rateOverrides", () => {
  it("is empty when every rate is within policy", () => {
    expect(rateOverrides(CLEAR)).toEqual([]);
  });

  it("flags a CP rate below the margin floor without stating the floor", () => {
    const [o, ...rest] = rateOverrides({ ...CLEAR, pricing: { ...CLEAR.pricing!, belowMarginFloor: true } });
    expect(rest).toEqual([]);
    expect(o).toMatchObject({ kind: "cp_rate", value: 249 });
    expect(o.message).toBe("Card-present rate 2.49% is below the minimum margin");
  });

  it("flags a CP rate under the $10/mo revenue floor, naming the dollars", () => {
    const [o, ...rest] = rateOverrides({
      ...CLEAR,
      pricing: { belowMarginFloor: false, belowMonthlyRevenueFloor: true, monthlyProcessingRevenue: 6.2 },
    });
    expect(rest).toEqual([]);
    expect(o.kind).toBe("cp_rate");
    expect(o.message).toMatch(/\$6\.20 a month, under the \$10\.00 minimum/);
  });

  it("flags a CP adjustment outside the range on both sides", () => {
    expect(rateOverrides({ ...CLEAR, cpAdjustmentBps: -30 })).toEqual([
      expect.objectContaining({ kind: "cp_rate", value: -30, limit: -29 }),
    ]);
    expect(rateOverrides({ ...CLEAR, cpAdjustmentBps: 24 })).toEqual([
      expect.objectContaining({ kind: "cp_rate", value: 24, limit: 23 }),
    ]);
    // The bounds themselves are inside.
    expect(rateOverrides({ ...CLEAR, cpAdjustmentBps: -29 })).toEqual([]);
    expect(rateOverrides({ ...CLEAR, cpAdjustmentBps: 23 })).toEqual([]);
  });

  it("skips the range check when there is no rate-card cell to measure from", () => {
    expect(rateOverrides({ ...CLEAR, cpAdjustmentBps: null, adjustBpsRange: null })).toEqual([]);
  });

  it("flags ANY CNP rate other than the policy's, in either direction", () => {
    expect(rateOverrides({ ...CLEAR, cardNotPresentBps: 310 })).toEqual([
      { kind: "cnp_rate", message: "Card-not-present rate 3.10% differs from the 3.30% policy rate", value: 310, limit: 330 },
    ]);
    expect(rateOverrides({ ...CLEAR, cardNotPresentBps: 331 })).toEqual([
      expect.objectContaining({ kind: "cnp_rate", value: 331, limit: 330 }),
    ]);
  });

  it("says nothing about the floors when there is no pricing basis", () => {
    expect(rateOverrides({ ...CLEAR, pricing: null })).toEqual([]);
  });
});

describe("adjustBpsRangeFor", () => {
  const tier = { minMargin: 0.0027, maxMargin: 0.008 };

  it("puts the bounds exactly on the tier's min / max commission margin, in whole bps", () => {
    const r = adjustBpsRangeFor(0.0249, 75_000, 28, 0.15, tier);
    const marginAt = (bps: number) => commissionMarginBreakdown(0.0249 + bps / 10000, 75_000, 28, 0.15).margin;
    expect(marginAt(r.min)).toBeGreaterThanOrEqual(tier.minMargin - 1e-9);
    expect(marginAt(r.min - 1)).toBeLessThan(tier.minMargin);
    expect(marginAt(r.max)).toBeLessThanOrEqual(tier.maxMargin + 1e-9);
    expect(marginAt(r.max + 1)).toBeGreaterThan(tier.maxMargin);
  });

  it("collapses to the upper bound when no whole bp fits between them", () => {
    const r = adjustBpsRangeFor(0.0249, 75_000, 28, 0.15, { minMargin: 0.00505, maxMargin: 0.00505 });
    expect(r.min).toBe(r.max);
  });
});

const POS_ID = "217445755632";
const pos = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  hubspotProductId: POS_ID, name: "POS Unit", qty: 1, unitPrice: 749,
  billingFrequency: "one_time", productType: "inventory", ...over,
});

describe("adjustmentBlockers with an overrides sink", () => {
  it("sends an over-cap PERCENT discount to the sink, not the blockers", () => {
    const sink: QuoteOverride[] = [];
    expect(adjustmentBlockers([pos({ discountPercent: 60 })], 50, undefined, {}, null, sink)).toEqual([]);
    expect(sink).toEqual([{
      kind: "discount", productId: POS_ID, productName: "POS Unit",
      message: "POS Unit: 60% off (cap 50%)", value: 60, limit: 50,
    }]);
  });

  it("sends an over-cap CASH discount to the sink, converted against list", () => {
    const sink: QuoteOverride[] = [];
    expect(adjustmentBlockers([pos({ qty: 2, discountAmount: 1000 })], 50, undefined, { [POS_ID]: 40 }, null, sink))
      .toEqual([]);
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ kind: "discount", limit: 40 });
    expect(sink[0].value).toBeCloseTo((1000 / 1498) * 100, 6);
    expect(sink[0].message).toBe("POS Unit: $1,000.00 off $1,498.00, 66.8% (cap 40%)");
  });

  it("refuses over-cap as before when no sink is passed", () => {
    expect(adjustmentBlockers([pos({ discountPercent: 60 })], 50)).toEqual([
      expect.stringMatching(/discounted 60%, over the 50% limit/),
    ]);
  });

  it("produces neither for a comped service at exactly 100%, or the first-kiosk unit", () => {
    const sink: QuoteOverride[] = [];
    const comped = pos({ hubspotProductId: COMPED_SERVICE_PRODUCT_IDS[0], name: "Onsite Installation", discountPercent: 100 });
    const kiosk = pos({ hubspotProductId: "222497165009", name: "Kiosk", firstKiosk: true, discountPercent: 80 });
    const covered = pos({ coveredByPackage: "qsr-kit", discountPercent: 100 });
    expect(adjustmentBlockers([comped, kiosk, covered], 50, undefined, {}, null, sink)).toEqual([]);
    expect(sink).toEqual([]);
  });

  it("keeps 0–100, more-than-the-line and the delay ceiling as blockers", () => {
    const sink: QuoteOverride[] = [];
    const blockers = adjustmentBlockers([
      pos({ discountPercent: 140 }),
      pos({ discountAmount: 800 }),
      pos({ billingFrequency: "monthly", billingStart: { mode: "days", days: 120 } }),
    ], 50, 90, {}, null, sink);
    expect(blockers).toHaveLength(3);
    expect(sink).toEqual([]);
  });
});

describe("overrideFingerprint", () => {
  const lines = [pos({ qty: 2, discountPercent: 60 })];
  const rates = { ...DEFAULT_QUOTE_RATES };
  const overrides: QuoteOverride[] = [
    { kind: "discount", productId: POS_ID, productName: "POS Unit", message: "POS Unit: 60% off (cap 50%)", value: 60, limit: 50 },
  ];
  const fp = overrideFingerprint(lines, rates, overrides);

  it("is a stable sha256 for identical input, whatever the key order", () => {
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(overrideFingerprint(structuredClone(lines), structuredClone(rates), structuredClone(overrides))).toBe(fp);
    const reordered = lines.map(l => Object.fromEntries(Object.entries(l).reverse()) as QuoteLine);
    expect(overrideFingerprint(reordered, rates, overrides)).toBe(fp);
  });

  it("changes when a line's quantity changes", () => {
    expect(overrideFingerprint([{ ...lines[0], qty: 3 }], rates, overrides)).not.toBe(fp);
  });

  it("changes when a rate changes", () => {
    expect(overrideFingerprint(lines, { ...rates, cardPresentRate: rates.cardPresentRate + 0.0001 }, overrides)).not.toBe(fp);
    expect(overrideFingerprint(lines, null, overrides)).not.toBe(fp);
  });

  it("changes when the overrides differ", () => {
    expect(overrideFingerprint(lines, rates, [{ ...overrides[0], value: 61 }])).not.toBe(fp);
    expect(overrideFingerprint(lines, rates, [])).not.toBe(fp);
  });
});
