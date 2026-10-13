// The commission/ARR margin — a SECOND, DELIBERATELY SEPARATE margin from
// `derivePricing`'s `appliedTargetMargin` in pricing.ts. Provenance: the
// product owner's 10/13 notes.md list, under "commissions calculator" /
// "immediatley work on payments stuff":
//
//   Total Revenue   = (CP Rate × MonthlyVolume) + ((MonthlyVolume ÷ AvgTicket) × TxnFee)
//   Total Take Rate = Total Revenue ÷ MonthlyVolume
//   Margin          = Total Take Rate % − Wholesale %
//
// (notes.md prints the wholesale table as two separate columns, tickets then
// percentages, one value per line — paired back up below.)
//
// DO NOT confuse this with `appliedTargetMargin`:
//   - `appliedTargetMargin` (pricing.ts) is revenue over INTERCHANGE — what the
//     quoted rates leave above AIO's actual per-dollar cost, split CP/CNP/AMEX,
//     computed from either a real statement's itemized interchange or
//     `INTERCHANGE_ESTIMATE`. It feeds `belowMarginFloor`, which is now a hard
//     server-side refusal (`marginFloorBlockers`) — CLAUDE.md is explicit that
//     this function and the margin floor are not to be touched by this change.
//   - `commissionMargin` (this file) is revenue over a flat, ticket-indexed
//     WHOLESALE table the product owner supplied directly, using ONE blended
//     CP rate and ONE flat per-transaction fee — no CP/CNP split, no AMEX lane,
//     no interchange estimate. It exists for exactly one consumer:
//     `payment_processing_arr` (lib/billing/processingArr.ts), which is a
//     forecast/commission figure, not a refusal gate.
//   These will not agree, and are not supposed to — see processingArr.ts's
//   doc comment for the size of the gap observed on real data.
//
// The wholesale table's ticket axis is deliberately the SAME NINE POINTS as
// `RATE_MATRIX_TICKETS` in rateMatrix.ts (§10.3's rate card) — $10/$15/$20/
// $25/$30/$40/$50/$75/$100 — so this is a sibling of that module rather than
// a parallel reimplementation. `matrixTicketIndex` (how a real $22.40 ticket
// reads DOWN to the $20 column, never interpolated) is reused rather than
// duplicated, for the same reason that file gives: an admin editing a cell
// here would otherwise not be editing the table anyone reads from.
//
// Stored as whole BASIS POINTS, the same way rateMatrix.ts stores its rates
// and for the same reason: every figure the product owner supplied is a
// two-decimal percentage (3.50%, 2.87%, …), exact in bps and not in a float.

import { matrixTicketIndex, RATE_MATRIX_TICKETS } from "@/lib/rateMatrix";

/**
 * Wholesale % by average ticket, in bps, row-aligned with
 * `RATE_MATRIX_TICKETS` ($10, $15, $20, $25, $30, $40, $50, $75, $100).
 * Verbatim from the product owner's 10/13 notes.
 */
export const WHOLESALE_PCT_BPS: readonly number[] = [
  350, // $10
  287, // $15
  255, // $20
  236, // $25
  223, // $30
  208, // $40
  198, // $50
  185, // $75
  179, // $100
];

if (WHOLESALE_PCT_BPS.length !== RATE_MATRIX_TICKETS.length) {
  // Would mean the two tables drifted apart — see the module comment on why
  // they must not. Thrown rather than silently misindexed.
  throw new Error("WHOLESALE_PCT_BPS must have one entry per RATE_MATRIX_TICKETS column");
}

/**
 * The wholesale % for a real average ticket, as a FRACTION (0.0223), not bps —
 * same convention as `lookupCardPresentRate` in rateMatrix.ts. Reads DOWN to
 * the column at or below the ticket (matrixTicketIndex), so a $22.40 ticket
 * reads the $20 column and a ticket under $10 reads the $10 column — the
 * cheapest ticket the table prices, same rule rateMatrix.ts's own comment
 * gives for the identical shape of problem.
 */
export function wholesalePctFor(avgTicket: number): number {
  return WHOLESALE_PCT_BPS[matrixTicketIndex(avgTicket)] / 10000;
}

/**
 * Total Revenue = (CP Rate × MonthlyVolume) + ((MonthlyVolume ÷ AvgTicket) × TxnFee)
 *
 * `cpRate` and `perTxnFee` are a fraction (0.0249) and a flat dollar amount
 * ($0.15) respectively — the same units `QuoteRates.cardPresentRate` /
 * `.perTransactionFee` already use. No AvgTicket means no transaction count
 * can be derived, so the per-transaction term is left at 0 rather than
 * guessed — the caller (processingArr.ts) only calls this once it has a
 * positive avgTicket.
 */
export function totalRevenue(
  cpRate: number,
  monthlyVolume: number,
  avgTicket: number,
  perTxnFee: number
): number {
  if (!(monthlyVolume > 0)) return 0;
  const txns = avgTicket > 0 ? monthlyVolume / avgTicket : 0;
  return cpRate * monthlyVolume + txns * perTxnFee;
}

/** Total Take Rate = Total Revenue ÷ Monthly Volume, as a fraction. */
export function totalTakeRate(revenue: number, monthlyVolume: number): number {
  if (!(monthlyVolume > 0)) return 0;
  return revenue / monthlyVolume;
}

/**
 * Margin = Total Take Rate % − Wholesale %, as a fraction. Can be negative —
 * a take rate thinner than wholesale at this ticket size is a real (bad)
 * outcome to report, not an input error, so this never clamps to zero.
 */
export function commissionMargin(takeRate: number, avgTicket: number): number {
  return takeRate - wholesalePctFor(avgTicket);
}

/** Every figure behind `commissionMargin`, for a caller that needs to show its work. */
export type CommissionMarginBreakdown = {
  totalRevenue: number;
  takeRate: number;
  wholesalePct: number;
  margin: number;
};

export function commissionMarginBreakdown(
  cpRate: number,
  monthlyVolume: number,
  avgTicket: number,
  perTxnFee: number
): CommissionMarginBreakdown {
  const revenue = totalRevenue(cpRate, monthlyVolume, avgTicket, perTxnFee);
  const takeRate = totalTakeRate(revenue, monthlyVolume);
  const wholesalePct = wholesalePctFor(avgTicket);
  return { totalRevenue: revenue, takeRate, wholesalePct, margin: takeRate - wholesalePct };
}
