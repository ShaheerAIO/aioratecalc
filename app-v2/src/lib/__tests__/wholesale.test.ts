import { describe, it, expect } from "vitest";
import {
  WHOLESALE_PCT_BPS, commissionMargin, commissionMarginBreakdown,
  totalRevenue, totalTakeRate, wholesalePctFor,
} from "@/lib/wholesale";
import { RATE_MATRIX_TICKETS } from "@/lib/rateMatrix";

// The commission/ARR margin — product owner, 10/13 notes.md:
//   Total Revenue   = (CP Rate × MonthlyVolume) + ((MonthlyVolume ÷ AvgTicket) × TxnFee)
//   Total Take Rate = Total Revenue ÷ MonthlyVolume
//   Margin          = Total Take Rate % − Wholesale %
// This is a DIFFERENT margin from derivePricing's appliedTargetMargin — see
// wholesale.ts's module comment and processingArr.ts's for why.

describe("the wholesale table", () => {
  it("is one entry per RATE_MATRIX_TICKETS column, same ticket axis as §10.3", () => {
    expect(WHOLESALE_PCT_BPS).toHaveLength(RATE_MATRIX_TICKETS.length);
  });

  it("is the product owner's 10/13 figures, verbatim, in bps", () => {
    expect([...WHOLESALE_PCT_BPS]).toEqual([350, 287, 255, 236, 223, 208, 198, 185, 179]);
  });

  it("falls as the ticket rises", () => {
    for (let i = 1; i < WHOLESALE_PCT_BPS.length; i++) {
      expect(WHOLESALE_PCT_BPS[i]).toBeLessThan(WHOLESALE_PCT_BPS[i - 1]);
    }
  });
});

describe("wholesalePctFor", () => {
  it("reads the exact column for a ticket that lands exactly on one", () => {
    expect(wholesalePctFor(10)).toBeCloseTo(0.0350, 6);
    expect(wholesalePctFor(30)).toBeCloseTo(0.0223, 6);
    expect(wholesalePctFor(100)).toBeCloseTo(0.0179, 6);
  });

  // Same rule as matrixTicketIndex: a ticket BETWEEN two columns reads the
  // one at or below it — $22.40 reads the $20 column, never interpolated.
  it("reads a ticket between two columns as the column at or below it", () => {
    expect(wholesalePctFor(22.4)).toBeCloseTo(0.0255, 6); // the $20 column
    expect(wholesalePctFor(37)).toBeCloseTo(0.0223, 6);   // the $30 column
  });

  it("reads a ticket under the cheapest column as the $10 column", () => {
    expect(wholesalePctFor(5)).toBeCloseTo(0.0350, 6);
    expect(wholesalePctFor(0.01)).toBeCloseTo(0.0350, 6);
  });

  it("reads a ticket over the dearest column as the $100 column", () => {
    expect(wholesalePctFor(150)).toBeCloseTo(0.0179, 6);
    expect(wholesalePctFor(1_000_000)).toBeCloseTo(0.0179, 6);
  });
});

describe("totalRevenue", () => {
  it("is (CP Rate × Volume) + ((Volume ÷ AvgTicket) × TxnFee)", () => {
    // $100,000/mo at a $30 ticket is 3,333.33 transactions.
    const revenue = totalRevenue(0.0249, 100_000, 30, 0.15);
    expect(revenue).toBeCloseTo(2490 + (100_000 / 30) * 0.15, 6);
  });

  it("is zero transaction-fee revenue with no avg ticket to derive a count from", () => {
    expect(totalRevenue(0.0249, 100_000, 0, 0.15)).toBeCloseTo(0.0249 * 100_000, 6);
  });

  it("is zero with no volume", () => {
    expect(totalRevenue(0.0249, 0, 30, 0.15)).toBe(0);
  });
});

describe("totalTakeRate", () => {
  it("is revenue ÷ monthly volume", () => {
    expect(totalTakeRate(2990, 100_000)).toBeCloseTo(0.0299, 6);
  });

  it("is zero with no volume", () => {
    expect(totalTakeRate(2990, 0)).toBe(0);
  });
});

describe("commissionMargin", () => {
  it("is take rate minus the wholesale % at that ticket", () => {
    // 2.99% take rate against the $30 column's 2.23% wholesale.
    expect(commissionMargin(0.0299, 30)).toBeCloseTo(0.0299 - 0.0223, 6);
  });

  it("can go negative — a take rate thinner than wholesale is reported, not clamped", () => {
    expect(commissionMargin(0.01, 10)).toBeLessThan(0);
  });
});

describe("commissionMarginBreakdown", () => {
  it("chains all three formulas and agrees with calling them separately", () => {
    const b = commissionMarginBreakdown(0.0249, 100_000, 30, 0.15);
    expect(b.totalRevenue).toBeCloseTo(totalRevenue(0.0249, 100_000, 30, 0.15), 6);
    expect(b.takeRate).toBeCloseTo(totalTakeRate(b.totalRevenue, 100_000), 6);
    expect(b.wholesalePct).toBeCloseTo(wholesalePctFor(30), 6);
    expect(b.margin).toBeCloseTo(b.takeRate - b.wholesalePct, 10);
  });

  // The product owner's own 10/13 worked example: a $150.86 avg ticket (from
  // the pre-existing backfill dry run) reads the $100 column (1.79%
  // wholesale), and a typically-quoted ~2.5% CP rate plus the per-transaction
  // fee puts the take rate near 2.5%, for a margin well under 1% — nowhere
  // near the 8.83%-margin example the OLD (interchange-based) comment used to
  // cite, because that identity doesn't hold for this formula.
  it("the $150.86-ticket example reads the $100 wholesale column", () => {
    const b = commissionMarginBreakdown(0.0249, 500_000, 150.86, 0.15);
    expect(b.wholesalePct).toBeCloseTo(0.0179, 6);
    expect(b.margin).toBeGreaterThan(0);
    expect(b.margin).toBeLessThan(0.01);
  });
});
