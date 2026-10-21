"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { marginReqsPolicy, rateMatrixPolicy } from "@/lib/db/schema";
import { loadMarginReqsBps } from "@/lib/marginReqsLoader";
import { marginReqsProblems, type MarginReqBps } from "@/lib/marginPolicy";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import {
  DEFAULT_RATE_MATRIX, MATRIX_COLS, MATRIX_ROWS, RATE_MATRIX_TICKETS, VOLUME_BAND_LABELS,
  lookupCardPresentRate, matrixTicketIndex, matrixVolumeIndex, rateMatrixProblems,
  type RateMatrixPolicy,
} from "@/lib/rateMatrix";
import { DEFAULT_QUOTE_RATES, type QuoteRates } from "@/types/merchant";

/**
 * The live rate card, or the pricing guide's own numbers when nothing has
 * been saved yet.
 *
 * Falls back to the DEFAULTS, never to "no rate card": an unseeded settings
 * table must not be able to leave a rep with nothing to quote. The read is
 * wrapped as well as the empty case, for the same reason `getQuoteLimits` is
 * — a database that hasn't run migration 0021 yet (a preview branch, a local
 * DB, the window between deploy and migrate) must degrade to the table in
 * code rather than take a rep's quote page down.
 */
export async function getRateMatrix(): Promise<RateMatrixPolicy> {
  let row;
  try {
    [row] = await db.select().from(rateMatrixPolicy).where(eq(rateMatrixPolicy.isActive, true)).limit(1);
  } catch (err) {
    console.error("[rate-matrix] could not read rate_matrix_policy; using the pricing guide's own numbers", err);
    return DEFAULT_RATE_MATRIX;
  }
  if (!row) return DEFAULT_RATE_MATRIX;

  // A grid that isn't the right SHAPE is not a rate card an admin chose — it
  // is a row written before this column existed, or jsonb that came back as
  // something else. The scalars are plain integer columns and can only be
  // wrong by being absent, so they fall back on their own.
  const grid = row.cardPresentBps;
  const wellFormed =
    Array.isArray(grid) && grid.length === MATRIX_ROWS &&
    grid.every(r => Array.isArray(r) && r.length === MATRIX_COLS && r.every(n => Number.isFinite(n)));

  return {
    cardPresentBps: wellFormed ? grid : DEFAULT_RATE_MATRIX.cardPresentBps,
    cardNotPresentBps: row.cardNotPresentBps || DEFAULT_RATE_MATRIX.cardNotPresentBps,
    perTransactionFeeCents: row.perTransactionFeeCents ?? DEFAULT_RATE_MATRIX.perTransactionFeeCents,
  };
}

export async function updateRateMatrixAction(input: RateMatrixPolicy): Promise<void> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");

  const problems = rateMatrixProblems(input);
  if (problems.length) throw new Error(problems.join(" "));

  const [existing] = await db
    .select({ id: rateMatrixPolicy.id })
    .from(rateMatrixPolicy)
    .where(eq(rateMatrixPolicy.isActive, true))
    .limit(1);
  const values = {
    cardPresentBps: input.cardPresentBps,
    cardNotPresentBps: input.cardNotPresentBps,
    perTransactionFeeCents: input.perTransactionFeeCents,
    updatedByUserId: effective.userId,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(rateMatrixPolicy).set(values).where(eq(rateMatrixPolicy.id, existing.id));
  } else {
    await db.insert(rateMatrixPolicy).values(values);
  }
}

/**
 * AIO's flat card-not-present rate, alone — independent of any volume/ticket
 * basis, because CNP doesn't vary by either (see rateMatrix.ts's doc comment
 * on `DEFAULT_CNP_RATE_BPS`; it's a scalar, not a grid).
 *
 * Added 2026-10-13, the same day CNP was locked on every rep surface
 * (`RateFields.tsx`), to fix a regression the lock introduced: `getSuggestedRatesAction`
 * below returns the live CNP figure too, but only as part of a full
 * suggestion gated on BOTH `monthlyVolume > 0` AND `avgTicket > 0` — the
 * gate CP's matrix lookup genuinely needs. A quote where the rep hasn't
 * entered both yet (average ticket is often blank at first) never got a
 * suggestion at all, so the now-disabled CNP box sat on
 * `DEFAULT_QUOTE_RATES.cardNotPresentRate` (2.49%, a flat placeholder) with
 * no way for a rep to correct it — before the lock that was just a starting
 * point a rep could fix; locked, it was a silent 81bps-under-policy number.
 * `RateFields` calls this directly, on a FRESH quote only, to confirm CNP
 * the moment it mounts rather than waiting on CP's basis.
 */
export async function getCnpPolicyRateAction(): Promise<number> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");

  const matrix = await getRateMatrix();
  return matrix.cardNotPresentBps / 10000;
}

export type RateSuggestion = {
  rates: QuoteRates;
  /** The cell the card-present rate was read off, for the line that says where it came from. */
  volumeBand: string;
  ticketColumn: number;
};

/**
 * What the rate card says to quote this merchant, or null when there's no
 * basis to look it up on.
 *
 * A server action rather than an import because the live numbers are in
 * Postgres — and because the three rep surfaces that need it are client
 * components, which is the same reason `getPricingPreviewAction` exists.
 *
 * AMEX stopped being priced apart from V/MC/Discover 2026-10-13 ("get rid of
 * the dual rate (amex)"), so the AMEX fields below are set equal to the
 * ordinary rate purely so the returned object still satisfies `QuoteRates`'
 * shape — `RateFields` no longer offers them, and nothing prices off them
 * (see pricing.ts's `derivePricing`). The rate card itself has no AMEX
 * column and never grows one now.
 */
export async function getSuggestedRatesAction(input: {
  monthlyVolume: number;
  avgTicket: number;
}): Promise<RateSuggestion | null> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");

  const matrix = await getRateMatrix();
  const cp = lookupCardPresentRate(matrix, input.monthlyVolume, input.avgTicket);
  if (cp === null) return null;

  const cnp = matrix.cardNotPresentBps / 10000;

  return {
    rates: {
      ...DEFAULT_QUOTE_RATES,
      cardPresentRate: cp,
      cardNotPresentRate: cnp,
      amexCardPresentRate: cp,
      amexCardNotPresentRate: cnp,
      perTransactionFee: matrix.perTransactionFeeCents / 100,
    },
    volumeBand: VOLUME_BAND_LABELS[matrixVolumeIndex(input.monthlyVolume)],
    ticketColumn: RATE_MATRIX_TICKETS[matrixTicketIndex(input.avgTicket)],
  };
}

// ── The margin table (MARGIN_REQS), admin-editable beside the rate card ─────
// ADMIN ONLY, in both directions: these are AIO's true min/desired/max
// margins, which reps must never receive. Rep-facing code reaches them only
// through derivePricingForRole (via getPricingPreviewAction). The loader that
// pricing uses is lib/marginReqsLoader.ts, deliberately not exported from this
// "use server" file, where it would become a callable endpoint.

/** The effective table (saved, or the code constants) in bps, for the admin page. */
export async function getMarginReqsAdminAction(): Promise<MarginReqBps[]> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");
  return loadMarginReqsBps();
}

export async function updateMarginReqsAction(input: MarginReqBps[]): Promise<void> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");

  const problems = marginReqsProblems(input);
  if (problems.length) throw new Error(problems.join(" "));

  // Persist only the three numbers, whatever else the caller sent.
  const rows = input.map(r => ({ minBps: r.minBps, desiredBps: r.desiredBps, maxBps: r.maxBps }));
  const [existing] = await db
    .select({ id: marginReqsPolicy.id })
    .from(marginReqsPolicy)
    .where(eq(marginReqsPolicy.isActive, true))
    .limit(1);
  const values = { rows, updatedByUserId: effective.userId, updatedAt: new Date() };
  if (existing) {
    await db.update(marginReqsPolicy).set(values).where(eq(marginReqsPolicy.id, existing.id));
  } else {
    await db.insert(marginReqsPolicy).values(values);
  }
}
