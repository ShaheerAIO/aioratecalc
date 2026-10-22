// getSuggestedRatesAction's adjustBpsRange — 2026-10-21, product owner: "there
// doesnt seem to be a limit on how much i can adjust the bps. It should cap
// based on the min and max margin". A rep's lower bound uses the PADDED floor,
// an admin's the true minimum; only whole bps ever leave the server.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MARGIN_REQS, derivePricing, getPaddedFloorRate, analysisFromQuoteConfig } from "@/lib/pricing";
import type { QuoteConfig } from "@/types/merchant";

const role = vi.hoisted(() => ({ current: "rep" as "rep" | "admin" }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/getEffectiveRole", () => ({
  getEffectiveRole: async () => ({ role: role.current, userId: "u1" }),
}));
vi.mock("@/lib/marginReqsLoader", () => ({
  loadMarginReqs: async () => MARGIN_REQS,
  loadMarginReqsBps: async () => [],
}));
vi.mock("@/lib/actions/pricing", () => ({
  getActivePaddingPolicy: async () => ({ paddingPct: 0.5, paddingMinMrrAdd: 0, paddingAdyenCostHide: true }),
}));
// No saved rate card: the action falls back to DEFAULT_RATE_MATRIX.
vi.mock("drizzle-orm", () => ({ eq: () => null }));
vi.mock("@/lib/db/schema", () => ({ marginReqsPolicy: {}, rateMatrixPolicy: { isActive: 1 } }));

import { getSuggestedRatesAction } from "@/lib/actions/rateMatrix";

const VOL = 110_000, TICKET = 22;

async function range() {
  const s = await getSuggestedRatesAction({ monthlyVolume: VOL, avgTicket: TICKET });
  return { s: s!, r: s!.adjustBpsRange };
}

describe("getSuggestedRatesAction adjustBpsRange", () => {
  beforeEach(() => { role.current = "rep"; });

  it("is whole bps, and the extremes land exactly on the margin bounds the pricing judges", async () => {
    role.current = "admin";
    const { s, r } = await range();
    expect(Number.isInteger(r.min) && Number.isInteger(r.max)).toBe(true);
    const tier = MARGIN_REQS.find(t => VOL <= t.maxVol)!;
    const marginAt = (bps: number) => {
      const rates = { ...s.rates, cardPresentRate: s.rates.cardPresentRate + bps / 10000 };
      const a = analysisFromQuoteConfig({ monthlyVolume: VOL, avgTicket: TICKET } as QuoteConfig);
      return derivePricing(a, rates, "2-tier", { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 }).appliedTargetMargin;
    };
    expect(marginAt(r.min)).toBeGreaterThanOrEqual(tier.minMargin - 1e-9);
    expect(marginAt(r.min - 1)).toBeLessThan(tier.minMargin);
    expect(marginAt(r.max)).toBeLessThanOrEqual(tier.maxMargin + 1e-9);
    expect(marginAt(r.max + 1)).toBeGreaterThan(tier.maxMargin);
  });

  it("gives a rep a tighter lower bound (padded floor) than an admin, same upper bound", async () => {
    role.current = "admin";
    const admin = (await range()).r;
    role.current = "rep";
    const rep = (await range()).r;
    const tier = MARGIN_REQS.find(t => VOL <= t.maxVol)!;
    expect(getPaddedFloorRate(tier.minMargin, { paddingPct: 0.5, paddingMinMrrAdd: 0, paddingAdyenCostHide: true }))
      .toBeGreaterThan(tier.minMargin);
    expect(rep.min).toBeGreaterThan(admin.min);
    expect(rep.max).toBe(admin.max);
  });
});
