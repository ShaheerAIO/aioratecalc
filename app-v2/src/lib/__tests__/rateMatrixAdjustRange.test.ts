// getSuggestedRatesAction's adjustBpsRange — 2026-10-21, product owner: "there
// doesnt seem to be a limit on how much i can adjust the bps. It should cap
// based on the min and max margin". Judged on Cole's commission margin, the same
// for reps and admins (no rep padding since 2026-10-23); only whole bps leave
// the server.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MARGIN_REQS } from "@/lib/pricing";
import { commissionMarginBreakdown } from "@/lib/wholesale";

const role = vi.hoisted(() => ({ current: "rep" as "rep" | "admin" }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/auth/getEffectiveRole", () => ({
  getEffectiveRole: async () => ({ role: role.current, userId: "u1" }),
}));
vi.mock("@/lib/marginReqsLoader", () => ({
  loadMarginReqs: async () => MARGIN_REQS,
  loadMarginReqsBps: async () => [],
}));
// No saved rate card: the action falls back to DEFAULT_RATE_MATRIX.
vi.mock("drizzle-orm", () => ({ eq: () => null }));
vi.mock("@/lib/db/schema", () => ({ marginReqsPolicy: {}, rateMatrixPolicy: { isActive: 1 } }));

import { getSuggestedRatesAction } from "@/lib/actions/rateMatrix";

const VOL = 110_000, TICKET = 22;

async function range(monthlyVolume = VOL, avgTicket = TICKET) {
  const s = await getSuggestedRatesAction({ monthlyVolume, avgTicket });
  return { s: s!, r: s!.adjustBpsRange };
}

describe("getSuggestedRatesAction adjustBpsRange", () => {
  beforeEach(() => { role.current = "rep"; });

  it("is whole bps, and the extremes land exactly on the margin bounds the pricing judges", async () => {
    role.current = "admin";
    const { s, r } = await range();
    expect(Number.isInteger(r.min) && Number.isInteger(r.max)).toBe(true);
    const tier = MARGIN_REQS.find(t => VOL <= t.maxVol)!;
    // Cole's commission margin (Total Take Rate − Wholesale %), the source of truth.
    const marginAt = (bps: number) => commissionMarginBreakdown(
      s.rates.cardPresentRate + bps / 10000, VOL, TICKET, s.rates.perTransactionFee
    ).margin;
    expect(marginAt(r.min)).toBeGreaterThanOrEqual(tier.minMargin - 1e-9);
    expect(marginAt(r.min - 1)).toBeLessThan(tier.minMargin);
    expect(marginAt(r.max)).toBeLessThanOrEqual(tier.maxMargin + 1e-9);
    expect(marginAt(r.max + 1)).toBeGreaterThan(tier.maxMargin);
  });

  it("gives a rep and an admin the same range — there is no rep padding", async () => {
    role.current = "admin";
    const admin = (await range()).r;
    role.current = "rep";
    expect((await range()).r).toEqual(admin);
  });

  it("contains zero, so the card's own rate is always quotable ($75k at $28: was -71 to -16)", async () => {
    role.current = "admin";
    const { r } = await range(75_000, 28);
    // Card 2.49% + $0.15 → margin 0.5657%; tier min 0.27%, max 0.80%.
    expect(r).toEqual({ min: -29, max: 23 });
  });
});
