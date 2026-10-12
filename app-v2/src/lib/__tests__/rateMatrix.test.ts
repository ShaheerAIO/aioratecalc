import { describe, it, expect } from "vitest";
import {
  DEFAULT_RATE_MATRIX, MATRIX_COLS, MATRIX_ROWS, MAX_RATE_BPS,
  RATE_MATRIX_TICKETS, RATE_MATRIX_VOLUME_BANDS, VOLUME_BAND_LABELS,
  lookupCardPresentRate, matrixTicketIndex, matrixVolumeIndex, rateMatrixProblems,
} from "@/lib/rateMatrix";
import { MARGIN_REQS } from "@/lib/pricing";

// The card-present rate card (pricing guide §10.3), the lookup that reads it,
// and the validator that stands between an admin's typing and every quote.

describe("the shipped card", () => {
  it("is 9 volume bands by 9 ticket columns", () => {
    expect(MATRIX_ROWS).toBe(9);
    expect(MATRIX_COLS).toBe(9);
    expect(DEFAULT_RATE_MATRIX.cardPresentBps).toHaveLength(MATRIX_ROWS);
    for (const row of DEFAULT_RATE_MATRIX.cardPresentBps) expect(row).toHaveLength(MATRIX_COLS);
    expect(VOLUME_BAND_LABELS).toHaveLength(MATRIX_ROWS);
  });

  // Load-bearing: the matrix prices off a volume tier's DESIRED margin and the
  // floor check runs against that same tier's MINIMUM. Bands that drifted
  // apart would price off one tier and refuse against another.
  it("uses exactly the volume bands MARGIN_REQS does", () => {
    expect([...RATE_MATRIX_VOLUME_BANDS]).toEqual(MARGIN_REQS.map(t => t.maxVol));
  });

  it("validates", () => {
    expect(rateMatrixProblems(DEFAULT_RATE_MATRIX)).toEqual([]);
  });

  // Both directions of the guide's own formula: the rate falls as volume
  // rises (bigger merchants need less margin) and as the ticket rises (the
  // per-transaction shortfall is spread over more dollars).
  it("falls along both axes", () => {
    const grid = DEFAULT_RATE_MATRIX.cardPresentBps;
    for (let r = 1; r < MATRIX_ROWS; r++) {
      for (let c = 0; c < MATRIX_COLS; c++) expect(grid[r][c]).toBeLessThan(grid[r - 1][c]);
    }
    for (let r = 0; r < MATRIX_ROWS; r++) {
      for (let c = 1; c < MATRIX_COLS; c++) expect(grid[r][c]).toBeLessThan(grid[r][c - 1]);
    }
  });

  // §10.5: at $0.15/txn exactly one cell exceeds the 3.30% card-not-present
  // rate — $0–25K at a $10 ticket. If an edit ever breaks that, the card is
  // telling a merchant that taking the card in person costs more than online.
  it("crosses the CNP rate in exactly the one cell the guide names", () => {
    const over = DEFAULT_RATE_MATRIX.cardPresentBps
      .flatMap((row, r) => row.map((bps, c) => ({ r, c, bps })))
      .filter(cell => cell.bps > DEFAULT_RATE_MATRIX.cardNotPresentBps);
    expect(over).toEqual([{ r: 0, c: 0, bps: 333 }]);
  });
});

describe("matrixVolumeIndex", () => {
  it("puts a volume in the band whose upper bound it is at or under", () => {
    expect(matrixVolumeIndex(0)).toBe(0);
    expect(matrixVolumeIndex(25000)).toBe(0);
    expect(matrixVolumeIndex(25001)).toBe(1);
    expect(matrixVolumeIndex(100000)).toBe(3);
    expect(matrixVolumeIndex(200000)).toBe(7);
  });

  it("puts anything past the last bound in the open-ended top band", () => {
    expect(matrixVolumeIndex(200001)).toBe(8);
    expect(matrixVolumeIndex(50_000_000)).toBe(8);
  });
});

describe("matrixTicketIndex", () => {
  // A column is read as the band STARTING at it, so a real ticket lands on
  // the dearer of its two neighbours — the direction §12 rounds.
  it("reads the column at or below the ticket", () => {
    expect(matrixTicketIndex(10)).toBe(0);
    expect(matrixTicketIndex(14.99)).toBe(0);
    expect(matrixTicketIndex(15)).toBe(1);
    expect(matrixTicketIndex(22.4)).toBe(2);   // the $20 column
    expect(matrixTicketIndex(74)).toBe(6);     // the $50 column
    expect(matrixTicketIndex(75)).toBe(7);
  });

  it("clamps a ticket under the cheapest column onto it", () => {
    expect(matrixTicketIndex(4)).toBe(0);
    expect(matrixTicketIndex(0.5)).toBe(0);
  });

  it("clamps a ticket past the dearest column onto it", () => {
    expect(matrixTicketIndex(100)).toBe(MATRIX_COLS - 1);
    expect(matrixTicketIndex(900)).toBe(MATRIX_COLS - 1);
  });
});

describe("lookupCardPresentRate", () => {
  it("reads the published cell", () => {
    // $60K/mo at a $25 ticket -> row "$50K – $75K", column $25 -> 2.29%.
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, 60000, 25)).toBeCloseTo(0.0229, 6);
    // The dearest corner.
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, 10000, 10)).toBeCloseTo(0.0333, 6);
    // The cheapest.
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, 500000, 120)).toBeCloseTo(0.0181, 6);
  });

  // Null rather than the dearest corner: "nobody has measured this merchant"
  // is a real state, and the caller's own answer for it is the flat standard
  // rate, not the $0–25K / $10-ticket cell.
  it("returns null with no basis", () => {
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, 0, 25)).toBeNull();
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, 60000, 0)).toBeNull();
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, -1, -1)).toBeNull();
  });

  it("survives a saved grid with a missing row rather than throwing", () => {
    const broken = { ...DEFAULT_RATE_MATRIX, cardPresentBps: [] };
    expect(lookupCardPresentRate(broken, 60000, 25)).toBeNull();
  });
});

describe("rateMatrixProblems", () => {
  const edit = (r: number, c: number, bps: number) => {
    const grid = DEFAULT_RATE_MATRIX.cardPresentBps.map(row => [...row]);
    grid[r][c] = bps;
    return { ...DEFAULT_RATE_MATRIX, cardPresentBps: grid };
  };

  it("refuses an empty cell, which is what a cleared box reads as", () => {
    const problems = rateMatrixProblems(edit(2, 3, 0));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("$50K – $75K");
    expect(problems[0]).toContain("$25");
  });

  it("refuses a negative rate", () => {
    expect(rateMatrixProblems(edit(0, 0, -5))).toHaveLength(1);
  });

  // The same typo ceiling MAX_PLAUSIBLE_CARD_RATE puts on a rep's rate box —
  // 20.00% where 2.00% was meant.
  it("refuses a decimal point in the wrong place", () => {
    expect(rateMatrixProblems(edit(0, 0, 2000))).toHaveLength(1);
    expect(rateMatrixProblems(edit(0, 0, MAX_RATE_BPS))).toEqual([]);
    expect(rateMatrixProblems(edit(0, 0, MAX_RATE_BPS + 1))).toHaveLength(1);
  });

  it("refuses a fractional basis point", () => {
    expect(rateMatrixProblems(edit(1, 1, 272.5))).toHaveLength(1);
  });

  it("reports every bad cell, not just the first", () => {
    const grid = DEFAULT_RATE_MATRIX.cardPresentBps.map(row => [...row]);
    grid[0][0] = 0;
    grid[8][8] = 9999;
    expect(rateMatrixProblems({ ...DEFAULT_RATE_MATRIX, cardPresentBps: grid })).toHaveLength(2);
  });

  it("refuses a grid of the wrong shape outright", () => {
    expect(rateMatrixProblems({ ...DEFAULT_RATE_MATRIX, cardPresentBps: [[249]] })).toHaveLength(1);
    const short = DEFAULT_RATE_MATRIX.cardPresentBps.map(row => row.slice(0, 3));
    expect(rateMatrixProblems({ ...DEFAULT_RATE_MATRIX, cardPresentBps: short })).toHaveLength(MATRIX_ROWS);
  });

  it("checks the two scalars too", () => {
    expect(rateMatrixProblems({ ...DEFAULT_RATE_MATRIX, cardNotPresentBps: 0 })).toHaveLength(1);
    expect(rateMatrixProblems({ ...DEFAULT_RATE_MATRIX, cardNotPresentBps: 2000 })).toHaveLength(1);
    expect(rateMatrixProblems({ ...DEFAULT_RATE_MATRIX, perTransactionFeeCents: -1 })).toHaveLength(1);
    expect(rateMatrixProblems({ ...DEFAULT_RATE_MATRIX, perTransactionFeeCents: 0 })).toEqual([]);
    expect(rateMatrixProblems({ ...DEFAULT_RATE_MATRIX, perTransactionFeeCents: 10 })).toEqual([]);
  });
});

describe("every published cell", () => {
  it("is a whole basis point, so a two-decimal percentage is exact", () => {
    for (const row of DEFAULT_RATE_MATRIX.cardPresentBps) {
      for (const bps of row) expect(Number.isInteger(bps)).toBe(true);
    }
  });

  it("is reachable by some (volume, ticket) pair", () => {
    const seen = new Set<string>();
    for (const vol of [1, 25000, 40000, 60000, 90000, 110000, 140000, 160000, 190000, 400000]) {
      for (const t of RATE_MATRIX_TICKETS) seen.add(`${matrixVolumeIndex(vol)}:${matrixTicketIndex(t)}`);
    }
    expect(seen.size).toBe(MATRIX_ROWS * MATRIX_COLS);
  });
});
