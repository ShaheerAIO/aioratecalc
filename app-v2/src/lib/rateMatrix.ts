// The card-present rate card: monthly volume × average ticket → the rate a
// rep quotes. Provenance: AIO-Restaurant-Payment-Pricing-Guide §10.3, the
// $0.15/transaction option, which §10.5 names the recommended default (it
// confines the "CP rate exceeds the CNP rate" crossover to a single cell).
//
// This is what DEFAULT_QUOTE_RATES' comment has been waiting for since
// 2026-10-06 ("a flat default rather than a lookup because the ticket-size ×
// volume matrix that should choose the rate doesn't exist yet"). The flat
// default STAYS: it is what a quote is priced at when nobody has supplied a
// volume and a ticket, which is every marketing-only quote and every
// processing quote whose merchant hasn't produced a statement yet. The matrix
// only ever SUGGESTS — see `lookupCardPresentRate`, and `RateSuggestion.tsx`
// for how a suggestion becomes a quote.
//
// NOT a secret. The matrix is derived from the volume tier's DESIRED margin
// (already rep-visible as `RoleScopedPricing.desiredMargin`), never from
// `minMargin` — the floor reps must not see stays in pricing.ts, server-side,
// behind `derivePricingForRole`. This file is nonetheless read through a
// server action rather than imported into a client bundle, because the live
// values live in Postgres.
//
// Rates are stored and edited as whole BASIS POINTS (249 = 2.49%). Every
// figure on AIO's rate card is a two-decimal percentage, so bps are exact
// where a float is not, and a quote is a document nobody can amend afterwards.

/**
 * Upper bound of each volume band, inclusive — the same nine bands as
 * `MARGIN_REQS` in pricing.ts, and deliberately so: the matrix's margin
 * component IS that table's `desiredMargin`, so a band that didn't line up
 * would price off one tier and check its floor against another.
 */
export const RATE_MATRIX_VOLUME_BANDS = [
  25000, 50000, 75000, 100000, 125000, 150000, 175000, 200000, Infinity,
] as const;

/**
 * The ticket columns, as the guide prints them. Each value is its bucket's
 * MAXIMUM plus one cent — see `matrixTicketIndex` for how a real $22 ticket
 * lands on one. The last column ($100) is open-ended: it takes everything $75
 * and up.
 */
export const RATE_MATRIX_TICKETS = [10, 15, 20, 25, 30, 40, 50, 75, 100] as const;

/**
 * The bucket each column ACTUALLY covers, derived from `RATE_MATRIX_TICKETS`
 * rather than a second hardcoded list (2026-10-13, "make matrix bucketing
 * explicit"). A column's value is its bucket's max + $0.01, so its range runs
 * from the previous column's value (0 for the first) to one cent under its own
 * ($0 – $9.99, $10 – $14.99 … $50 – $74.99). The last column is open-ended:
 * "$75+", because it takes every ticket from the second-to-last value upward.
 */
export const TICKET_COLUMN_LABELS: string[] = RATE_MATRIX_TICKETS.map((t, i) => {
  const lower = i === 0 ? 0 : RATE_MATRIX_TICKETS[i - 1];
  return i === RATE_MATRIX_TICKETS.length - 1
    ? `$${lower}+`
    : `$${lower} – $${(t - 0.01).toFixed(2)}`;
});

export const VOLUME_BAND_LABELS = [
  "$0 – $25K", "$25K – $50K", "$50K – $75K", "$75K – $100K", "$100K – $125K",
  "$125K – $150K", "$150K – $175K", "$175K – $200K", "$200K+",
] as const;

/**
 * §10.3 (October 2026 revision), verbatim, in basis points. Row = volume band, column = ticket.
 *
 * The guide's own formula is
 *   CP Rate = 1.60% + Desired Margin (by volume) + ($0.04 ÷ average ticket)
 * where 1.60% is interchange plus the Adyen buy rate and $0.04 is the
 * shortfall between AIO's $0.19/txn true cost and the $0.15 collected. The
 * numbers below are the guide's published cells rather than that formula
 * re-evaluated here, so an admin editing a cell is editing the rate card and
 * not fighting an arithmetic model.
 */
export const DEFAULT_CP_RATE_BPS: number[][] = [
  [300, 288, 280, 288, 296, 308, 313, 319, 321],
  [285, 273, 265, 273, 281, 293, 298, 304, 306],
  [253, 241, 233, 241, 249, 261, 266, 272, 274],
  [238, 226, 218, 226, 234, 246, 251, 257, 259],
  [230, 218, 210, 218, 226, 238, 243, 249, 251],
  [224, 212, 204, 212, 220, 232, 237, 243, 245],
  [221, 209, 201, 209, 217, 229, 234, 240, 242],
  [218, 206, 198, 206, 214, 226, 231, 237, 239],
  [217, 205, 197, 205, 213, 225, 230, 236, 238],
];

/**
 * Card-not-present, flat across every volume and every ticket — §10.1.
 *
 * ONE number rather than a second grid (product owner, 2026-10-12: "keep CNP
 * flat for now"). The notes ask for a separate online-ordering matrix
 * eventually; when it arrives it takes the same shape as the CP grid above
 * and this scalar goes away. Nothing else has to move, for the same reason
 * the flat default could become a matrix: a looked-up rate and a typed one
 * are the same number.
 */
export const DEFAULT_CNP_RATE_BPS = 330;

/** §10.3 is the $0.15/txn option. §10.4 is the same card at $0.10 — an admin wanting it edits both. */
export const DEFAULT_PER_TXN_FEE_CENTS = 15;

export type RateMatrixPolicy = {
  /** Row-major, `RATE_MATRIX_VOLUME_BANDS.length` × `RATE_MATRIX_TICKETS.length`, in bps. */
  cardPresentBps: number[][];
  cardNotPresentBps: number;
  perTransactionFeeCents: number;
};

export const DEFAULT_RATE_MATRIX: RateMatrixPolicy = {
  cardPresentBps: DEFAULT_CP_RATE_BPS,
  cardNotPresentBps: DEFAULT_CNP_RATE_BPS,
  perTransactionFeeCents: DEFAULT_PER_TXN_FEE_CENTS,
};

export const MATRIX_ROWS = RATE_MATRIX_VOLUME_BANDS.length;
export const MATRIX_COLS = RATE_MATRIX_TICKETS.length;

/** The band a monthly volume falls in. Volumes at or below a bound belong to it, as MARGIN_REQS reads them. */
export function matrixVolumeIndex(monthlyVolume: number): number {
  const i = RATE_MATRIX_VOLUME_BANDS.findIndex(max => monthlyVolume <= max);
  return i === -1 ? MATRIX_ROWS - 1 : i;
}

/**
 * The column an average ticket reads off.
 *
 * Each column's value is its bucket's max + $0.01 ($10 = $0–$9.99, $15 =
 * $10–$14.99 … $75 = $50–$74.99), so a ticket reads the FIRST column whose
 * value is strictly greater than it: $22.40 reads the $25 column, exactly
 * $10.00 reads the $15 column, $9.99 the $10 column. The last column ($100)
 * is open-ended — $75 and up, $500 included.
 *
 * Why that is safe: the guide computes each cell with the column value as the
 * ticket, so every real ticket in the bucket is at or under that value and the
 * per-transaction fee recovers at least what the cell assumed.
 *
 * Interpolating between columns would be more precise and is deliberately not
 * done: the table an admin edits is then no longer the rate card, and a cell
 * they typed would never be the rate anyone is quoted. A non-positive or NaN
 * ticket reads the first column, as it always has.
 */
export function matrixTicketIndex(avgTicket: number): number {
  if (!(avgTicket > 0)) return 0;
  const i = RATE_MATRIX_TICKETS.findIndex(t => avgTicket < t);
  return i === -1 ? MATRIX_COLS - 1 : i;
}

/**
 * The suggested card-present rate as a FRACTION (0.0233), or null when there
 * is no basis to look one up on.
 *
 * Null rather than a fallback rate on purpose: "no volume and ticket" is a
 * real and common state (a marketing-only quote, a merchant who hasn't sent a
 * statement), and the caller already has the right answer for it — today's
 * flat `DEFAULT_QUOTE_RATES`. Returning a matrix cell anyway would mean
 * quoting the $0–25K / $10-ticket corner, the dearest cell on the card, to
 * every merchant nobody has measured.
 */
export function lookupCardPresentRate(
  matrix: RateMatrixPolicy,
  monthlyVolume: number,
  avgTicket: number
): number | null {
  if (!(monthlyVolume > 0) || !(avgTicket > 0)) return null;
  const row = matrix.cardPresentBps[matrixVolumeIndex(monthlyVolume)];
  if (!row) return null;
  const bps = row[matrixTicketIndex(avgTicket)];
  return Number.isFinite(bps) ? bps / 10000 : null;
}

/**
 * Validate a grid an admin is about to save. Returns the reasons it can't be,
 * one per problem, or an empty array.
 *
 * The ceiling is MAX_PLAUSIBLE_CARD_RATE's 5%, restated here as bps rather
 * than imported: that constant is the typo guard on a rep's rate box and this
 * is the same guard on the table the box is suggested from. A cell of 0 is
 * refused too — a free rate is not a rate card entry, it is an empty box
 * someone forgot.
 */
export const MAX_RATE_BPS = 500;

export function rateMatrixProblems(matrix: RateMatrixPolicy): string[] {
  const problems: string[] = [];
  const grid = matrix.cardPresentBps;
  if (!Array.isArray(grid) || grid.length !== MATRIX_ROWS) {
    return [`The rate card needs ${MATRIX_ROWS} volume rows.`];
  }
  grid.forEach((row, r) => {
    if (!Array.isArray(row) || row.length !== MATRIX_COLS) {
      problems.push(`${VOLUME_BAND_LABELS[r]} needs ${MATRIX_COLS} ticket columns.`);
      return;
    }
    row.forEach((bps, c) => {
      if (!Number.isInteger(bps) || bps <= 0 || bps > MAX_RATE_BPS) {
        problems.push(
          `${VOLUME_BAND_LABELS[r]} at a $${RATE_MATRIX_TICKETS[c]} ticket: ` +
          `a rate has to be between 0.01% and ${(MAX_RATE_BPS / 100).toFixed(2)}%.`
        );
      }
    });
  });
  if (!Number.isInteger(matrix.cardNotPresentBps) || matrix.cardNotPresentBps <= 0 || matrix.cardNotPresentBps > MAX_RATE_BPS) {
    problems.push(`The card-not-present rate has to be between 0.01% and ${(MAX_RATE_BPS / 100).toFixed(2)}%.`);
  }
  if (!Number.isInteger(matrix.perTransactionFeeCents) || matrix.perTransactionFeeCents < 0 || matrix.perTransactionFeeCents > 500) {
    problems.push("The per-transaction fee has to be a whole number of cents, $5.00 or less.");
  }
  return problems;
}
