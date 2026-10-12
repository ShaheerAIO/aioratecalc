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
 * The ticket columns, as the guide prints them. These are POINTS, not ranges
 * — see `matrixTicketIndex` for how a real $22 ticket lands on one.
 */
export const RATE_MATRIX_TICKETS = [10, 15, 20, 25, 30, 40, 50, 75, 100] as const;

export const VOLUME_BAND_LABELS = [
  "$0 – $25K", "$25K – $50K", "$50K – $75K", "$75K – $100K", "$100K – $125K",
  "$125K – $150K", "$150K – $175K", "$175K – $200K", "$200K+",
] as const;

/**
 * §10.3, verbatim, in basis points. Row = volume band, column = ticket.
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
  [333, 320, 313, 309, 306, 303, 301, 298, 297],
  [285, 272, 265, 261, 258, 255, 253, 250, 249],
  [253, 240, 233, 229, 226, 223, 221, 218, 217],
  [238, 225, 218, 214, 211, 208, 206, 203, 202],
  [230, 217, 210, 206, 203, 200, 198, 195, 194],
  [224, 211, 204, 200, 197, 194, 192, 189, 188],
  [221, 208, 201, 197, 194, 191, 189, 186, 185],
  [218, 205, 198, 194, 191, 188, 186, 183, 182],
  [217, 204, 197, 193, 190, 187, 185, 182, 181],
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
 * The guide's columns are points ($10, $15, $20 …) but a real ticket is
 * $22.40, so each column is read as the band STARTING at it: $22.40 reads the
 * $20 column. That is the LARGER of the two neighbouring rates (the rate falls
 * as the ticket rises), which is the same direction §12 rounds — "every rate
 * is rounded up, never down, so margin is preserved or slightly padded versus
 * the raw calculated rate".
 *
 * Interpolating between columns would be more precise and is deliberately not
 * done: the table an admin edits is then no longer the rate card, and a cell
 * they typed would never be the rate anyone is quoted. A ticket under $10
 * reads the $10 column — the cheapest ticket the card prices, and the dearest
 * rate on it.
 */
export function matrixTicketIndex(avgTicket: number): number {
  let idx = 0;
  for (let i = 0; i < MATRIX_COLS; i++) {
    if (avgTicket >= RATE_MATRIX_TICKETS[i]) idx = i;
  }
  return idx;
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
