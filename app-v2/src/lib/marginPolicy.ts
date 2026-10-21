// Validation for the admin-editable margin table (MARGIN_REQS' min / desired /
// max per volume band). PURE and free of every number in the table on purpose:
// the rate-matrix admin page imports this into a client bundle, and a rep can
// read any client bundle. The true values only ever cross to the browser
// through the admin-only `getMarginReqsAdminAction`.
//
// Stored and edited as whole BASIS POINTS (85 = 0.85%) — the table's own
// figures are all two-decimal percentages, exact in bps and not in a float.
import { MATRIX_ROWS, VOLUME_BAND_LABELS } from "@/lib/rateMatrix";

export type MarginReqBps = { minBps: number; desiredBps: number; maxBps: number };

/** A typo guard, like MAX_RATE_BPS: 10% over interchange is not a margin anyone means to type. */
export const MAX_MARGIN_BPS = 1000;

export function marginReqsProblems(rows: MarginReqBps[]): string[] {
  if (!Array.isArray(rows) || rows.length !== MATRIX_ROWS) {
    return [`The margin table needs ${MATRIX_ROWS} volume rows.`];
  }
  const problems: string[] = [];
  rows.forEach((r, i) => {
    const band = VOLUME_BAND_LABELS[i];
    const vals = [r?.minBps, r?.desiredBps, r?.maxBps];
    if (!vals.every(n => Number.isInteger(n) && n >= 0 && n <= MAX_MARGIN_BPS)) {
      problems.push(`${band}: margins have to be between 0% and ${(MAX_MARGIN_BPS / 100).toFixed(2)}%.`);
    } else if (!(r.minBps <= r.desiredBps && r.desiredBps <= r.maxBps)) {
      problems.push(`${band}: the minimum can't exceed the desired margin, and desired can't exceed the maximum.`);
    }
  });
  return problems;
}
