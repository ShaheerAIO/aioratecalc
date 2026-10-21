import { describe, it, expect, vi, beforeEach } from "vitest";

// The admin-editable margin table: validation, the fallback to MARGIN_REQS,
// and the threading through derivePricingForRole.

vi.mock("server-only", () => ({}));
// A plain closure, not a vi.fn: vitest fails a test when a spy it owns throws,
// even if the code under test catches it — and catching is the point here.
let readImpl: () => Promise<unknown[]> = async () => [];
const select = {
  mockReset: () => { readImpl = async () => []; },
  mockResolvedValue: (v: unknown[]) => { readImpl = async () => v; },
  mockFailWith: (e: Error) => { readImpl = () => { throw e; }; },
};
vi.mock("@/lib/db/client", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => readImpl() }) }) }) },
}));

const { marginReqsProblems, MAX_MARGIN_BPS } = await import("@/lib/marginPolicy");
const { loadMarginReqs, loadMarginReqsBps, defaultMarginReqsBps } = await import("@/lib/marginReqsLoader");
const { MARGIN_REQS, getMarginFloor, derivePricingForRole } = await import("@/lib/pricing");

const rows = () => defaultMarginReqsBps().map(r => ({ ...r }));

describe("marginReqsProblems", () => {
  it("accepts the shipped table", () => {
    expect(marginReqsProblems(rows())).toEqual([]);
  });

  it("refuses the wrong number of rows", () => {
    expect(marginReqsProblems(rows().slice(1))).toHaveLength(1);
  });

  it("refuses min > desired, desired > max, negatives, fractions and over-ceiling", () => {
    const bad = (patch: Partial<{ minBps: number; desiredBps: number; maxBps: number }>) => {
      const r = rows();
      r[2] = { ...r[2], ...patch };
      return marginReqsProblems(r);
    };
    expect(bad({ minBps: 60 })).toHaveLength(1);           // desired is 53
    expect(bad({ maxBps: 40 })).toHaveLength(1);
    expect(bad({ minBps: -1 })).toHaveLength(1);
    expect(bad({ desiredBps: 30.5 })).toHaveLength(1);
    expect(bad({ maxBps: MAX_MARGIN_BPS + 1 })).toHaveLength(1);
    expect(bad({ minBps: 0, desiredBps: 0, maxBps: 0 })).toEqual([]); // equal is allowed
  });
});

describe("loadMarginReqs", () => {
  beforeEach(() => select.mockReset());

  it("falls back to MARGIN_REQS when no row exists", async () => {
    select.mockResolvedValue([]);
    expect(await loadMarginReqs()).toEqual(MARGIN_REQS);
  });

  it("falls back when the read fails (unmigrated database)", async () => {
    select.mockFailWith(new Error('relation "margin_reqs_policy" does not exist'));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadMarginReqs()).toEqual(MARGIN_REQS);
    spy.mockRestore();
  });

  it("falls back when the saved rows are malformed", async () => {
    select.mockResolvedValue([{ rows: [{ minBps: 1, desiredBps: 2, maxBps: 3 }] }]);
    expect(await loadMarginReqsBps()).toEqual(defaultMarginReqsBps());
  });

  it("round-trips the defaults exactly (bps -> fraction equals the literals)", async () => {
    select.mockResolvedValue([{ rows: rows() }]);
    expect(await loadMarginReqs()).toEqual(MARGIN_REQS);
  });

  it("uses the saved values, keeping the fixed bands and reference ARR from code", async () => {
    const saved = rows();
    saved[0] = { minBps: 90, desiredBps: 110, maxBps: 210 };
    select.mockResolvedValue([{ rows: saved }]);
    const reqs = await loadMarginReqs();
    expect(reqs[0]).toEqual({ ...MARGIN_REQS[0], minMargin: 0.009, desiredMargin: 0.011, maxMargin: 0.021 });
    expect(reqs.map(r => r.maxVol)).toEqual(MARGIN_REQS.map(r => r.maxVol));
    expect(getMarginFloor(10_000, reqs).minMargin).toBe(0.009);
  });
});

describe("derivePricingForRole with a saved table", () => {
  const analysis = {
    totalVolume: 20_000, totalTransactions: 800, interchangeRate: 0.018,
    averageTicket: 25, cardPresentPct: 0.95, cardNotPresentPct: 0.05,
  };
  const fees = { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 };
  const padding = { paddingPct: 0, paddingMinMrrAdd: 0, paddingAdyenCostHide: true };
  const price = (reqs?: Parameters<typeof derivePricingForRole>[8]) =>
    derivePricingForRole(analysis, null, "2-tier", fees, "admin", null, padding, null, reqs);

  it("defaults to MARGIN_REQS when no table is passed", () => {
    expect(price().desiredMargin).toBe(MARGIN_REQS[0].desiredMargin);
  });

  it("reads the passed table for floor, desired and max", () => {
    const reqs = MARGIN_REQS.map(r => ({ ...r, minMargin: 0.02, desiredMargin: 0.025, maxMargin: 0.03 }));
    const p = price(reqs);
    expect(p.desiredMargin).toBe(0.025);
    expect(p.maxMargin).toBe(0.03);
    expect(p.marginFloor).toBeCloseTo(20_000 * 0.02, 6);
    expect(p.belowMarginFloor).toBe(true); // the default 2.49% rate leaves < 2% over interchange here
  });
});
