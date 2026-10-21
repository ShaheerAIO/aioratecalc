import { describe, it, expect } from "vitest";
import {
  DEFAULT_RATE_MATRIX, MATRIX_COLS, MATRIX_ROWS, MAX_RATE_BPS,
  RATE_MATRIX_TICKETS, RATE_MATRIX_VOLUME_BANDS, TICKET_COLUMN_LABELS, VOLUME_BAND_LABELS,
  lookupCardPresentRate, matrixTicketIndex, matrixVolumeIndex, rateMatrixProblems,
} from "@/lib/rateMatrix";
import { MARGIN_REQS } from "@/lib/pricing";
import { averageTicketOf } from "@/types/merchant";

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

  // Volume: bigger merchants need less margin, so the rate falls down every
  // column. Ticket: the Oct 2026 wholesale table is NOT monotone ($10 is dear,
  // $20 the cheapest, then the rate climbs again as the $0.15 fee is netted out
  // of a larger ticket), so only the dip at $20 is asserted.
  it("falls with volume and bottoms out at the $20 ticket", () => {
    const grid = DEFAULT_RATE_MATRIX.cardPresentBps;
    for (let r = 1; r < MATRIX_ROWS; r++) {
      for (let c = 0; c < MATRIX_COLS; c++) expect(grid[r][c]).toBeLessThan(grid[r - 1][c]);
    }
    for (let r = 0; r < MATRIX_ROWS; r++) {
      expect(grid[r].indexOf(Math.min(...grid[r]))).toBe(2);
    }
  });

  // §10.5 (Oct 2026): at $0.15/txn NO cell exceeds the 3.30% card-not-present
  // rate (verified against the numbers, not just the guide's claim). If an edit
  // breaks that, the card says taking the card in person costs more than online.
  it("never crosses the CNP rate", () => {
    const over = DEFAULT_RATE_MATRIX.cardPresentBps
      .flatMap((row, r) => row.map((bps, c) => ({ r, c, bps })))
      .filter(cell => cell.bps > DEFAULT_RATE_MATRIX.cardNotPresentBps);
    expect(over).toEqual([]);
  });
});

// The admin page prints the real range each column covers in its header,
// derived from RATE_MATRIX_TICKETS rather than a second hardcoded list that
// could drift from it. Each column value is its bucket's max + $0.01.
describe("TICKET_COLUMN_LABELS", () => {
  it("has one label per column", () => {
    expect(TICKET_COLUMN_LABELS).toHaveLength(MATRIX_COLS);
  });

  it("labels each column with the range it covers, one cent short of its own value", () => {
    expect(TICKET_COLUMN_LABELS).toEqual([
      "$0 – $9.99", "$10 – $14.99", "$15 – $19.99", "$20 – $24.99", "$25 – $29.99",
      "$30 – $39.99", "$40 – $49.99", "$50 – $74.99", "$75+",
    ]);
  });

  it("leaves the last column open-ended — everything $75 and up", () => {
    expect(TICKET_COLUMN_LABELS[MATRIX_COLS - 1]).toBe("$75+");
  });

  it("stays derived from RATE_MATRIX_TICKETS rather than a second hardcoded copy", () => {
    // If someone ever widens the grid, the labels have to follow without a
    // second edit — each label (bar the open-ended last) ends one cent under
    // its column's value.
    RATE_MATRIX_TICKETS.slice(0, -1).forEach((t, i) => {
      expect(TICKET_COLUMN_LABELS[i].endsWith(`$${(t - 0.01).toFixed(2)}`)).toBe(true);
    });
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
  // A column's value is its bucket's max + $0.01, so a ticket reads the first
  // column whose value is strictly greater than it.
  it("reads the first column strictly above the ticket", () => {
    expect(matrixTicketIndex(9.99)).toBe(0);   // $0 – $9.99
    expect(matrixTicketIndex(10)).toBe(1);     // $10 – $14.99
    expect(matrixTicketIndex(14.99)).toBe(1);
    expect(matrixTicketIndex(15)).toBe(2);
    expect(matrixTicketIndex(22.4)).toBe(3);   // the $25 column ($20 – $24.99)
    expect(matrixTicketIndex(24.99)).toBe(3);
    expect(matrixTicketIndex(25)).toBe(4);
    expect(matrixTicketIndex(29.99)).toBe(4);
    expect(matrixTicketIndex(30)).toBe(5);
    expect(matrixTicketIndex(39.99)).toBe(5);
    expect(matrixTicketIndex(40)).toBe(6);
    expect(matrixTicketIndex(49.99)).toBe(6);
    expect(matrixTicketIndex(50)).toBe(7);     // the $75 column ($50 – $74.99)
    expect(matrixTicketIndex(74.99)).toBe(7);
    expect(matrixTicketIndex(75)).toBe(8);     // the open-ended $100 column
  });

  it("clamps a ticket under the cheapest column onto it", () => {
    expect(matrixTicketIndex(4)).toBe(0);
    expect(matrixTicketIndex(0.5)).toBe(0);
  });

  it("clamps a ticket past the dearest column onto it", () => {
    expect(matrixTicketIndex(100)).toBe(MATRIX_COLS - 1);
    expect(matrixTicketIndex(500)).toBe(MATRIX_COLS - 1);
    expect(matrixTicketIndex(900)).toBe(MATRIX_COLS - 1);
  });
});

describe("lookupCardPresentRate", () => {
  it("reads the published cell", () => {
    // $60K/mo at a $22.50 ticket -> row "$50K – $75K", column $25 ($20 – $24.99) -> 2.41%.
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, 60000, 22.5)).toBeCloseTo(0.0241, 6);
    // A corner of the card (the Oct 2026 grid is no longer dearest here).
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, 10000, 5)).toBeCloseTo(0.0300, 6);
    // The $200K+ / $100 corner.
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, 500000, 120)).toBeCloseTo(0.0238, 6);
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
      // One cent under each column's value is inside that column's bucket.
      for (const t of RATE_MATRIX_TICKETS) seen.add(`${matrixVolumeIndex(vol)}:${matrixTicketIndex(t - 0.01)}`);
    }
    expect(seen.size).toBe(MATRIX_ROWS * MATRIX_COLS);
  });
});

// The statement path. A statement fills the rep's volume and ticket boxes and
// those are what the rate card is looked up on — so a statement that doesn't
// print an average ticket must still produce one, or the quote silently stays
// on the flat standard rate. Reported live 2026-10-12: a statement was read,
// the boxes stayed blank, and the rate never moved off 2.49%.
describe("averageTicketOf", () => {
  const base = { averageTicket: 0, totalVolume: 0, totalTransactions: 0 };

  it("uses the figure the statement printed", () => {
    expect(averageTicketOf({ ...base, averageTicket: 34.5, totalVolume: 100000, totalTransactions: 1 })).toBe(34.5);
  });

  it("derives it from volume ÷ transactions when the statement omits it", () => {
    expect(averageTicketOf({ ...base, totalVolume: 100000, totalTransactions: 4000 })).toBe(25);
  });

  it("is 0 when neither is available, which reads as 'no basis'", () => {
    expect(averageTicketOf(base)).toBe(0);
    expect(averageTicketOf({ ...base, totalVolume: 100000 })).toBe(0);
    expect(averageTicketOf({ ...base, totalTransactions: 4000 })).toBe(0);
  });

  it("feeds a real cell of the card", () => {
    const ticket = averageTicketOf({ ...base, totalVolume: 100000, totalTransactions: 4000 });
    // $100K/mo is the "$75K – $100K" band; a $25 ticket reads the $30 column ($25 – $29.99).
    expect(lookupCardPresentRate(DEFAULT_RATE_MATRIX, 100000, ticket)).toBeCloseTo(0.0234, 6);
  });
});
