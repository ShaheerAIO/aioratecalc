// The rate half of "which limits did this quote go past" (2026-11-02): the
// card-present and card-not-present overrides an admin may approve on a single
// quote. The discount and unit-cap half is derived in `buildQuote`
// (`BuiltQuote.overrides`), since that is where the lines are.
//
// Pure: no DB, no "use server". The margin judgement is NOT redone here — it is
// read off the role-scoped pricing `marginFloorBlockers` /
// `monthlyRevenueFloorBlockers` already consume, so the floor stays in
// pricing.ts and its figure never reaches a message a rep may read.

import { createHash } from "crypto";
import { marginFloorBlockers, monthlyRevenueFloorBlockers, type RoleScopedPricing } from "@/lib/pricing";
import { fmt$ } from "@/lib/utils";
import {
  MIN_MONTHLY_PROCESSING_REVENUE, type QuoteLine, type QuoteOverride, type QuoteRates,
} from "@/types/merchant";

export type RateOverrideInput = {
  /** From `derivePricingForRole` / `getPricingPreviewAction`. Null when there is no volume basis to judge on. */
  pricing: Pick<
    RoleScopedPricing, "belowMarginFloor" | "belowMonthlyRevenueFloor" | "monthlyProcessingRevenue"
  > | null;
  /** The quoted card-present rate, whole bps. */
  cardPresentBps: number;
  /** Quoted CP minus the rate card's cell, whole bps. Null when there is no cell (no volume/ticket). */
  cpAdjustmentBps: number | null;
  /** `adjustBpsRangeFor` (wholesale.ts). Null when there is no cell to measure from. */
  adjustBpsRange: { min: number; max: number } | null;
  /** The quoted card-not-present rate, whole bps. */
  cardNotPresentBps: number;
  /** The live policy's `cardNotPresentBps` (`getRateMatrix`). */
  policyCardNotPresentBps: number;
};

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const signed = (bps: number) => (bps > 0 ? `+${bps}` : `${bps}`);

/**
 * The card-present and card-not-present overrides on a quote. Empty means the
 * rates need no approval.
 *
 * The margin-floor override's `limit` is the quoted rate itself: the floor is
 * never disclosed, to a rep or in a message (see `marginFloorBlockers`). The
 * revenue-floor one is the same, with the non-secret $10 named in the message.
 */
export function rateOverrides(input: RateOverrideInput): QuoteOverride[] {
  const out: QuoteOverride[] = [];
  const cp = input.cardPresentBps;

  if (input.pricing && marginFloorBlockers(input.pricing).length) {
    out.push({
      kind: "cp_rate",
      message: `Card-present rate ${pct(cp)} is below the minimum margin`,
      value: cp, limit: cp,
    });
  }
  if (input.pricing && monthlyRevenueFloorBlockers(input.pricing).length) {
    const earned = input.pricing.monthlyProcessingRevenue ?? 0;
    out.push({
      kind: "cp_rate",
      message:
        `Card-present rate ${pct(cp)} earns ${fmt$(earned)} a month, under the ` +
        `${fmt$(MIN_MONTHLY_PROCESSING_REVENUE)} minimum`,
      value: cp, limit: cp,
    });
  }

  const adj = input.cpAdjustmentBps;
  const range = input.adjustBpsRange;
  if (adj !== null && range) {
    if (adj < range.min || adj > range.max) {
      out.push({
        kind: "cp_rate",
        message:
          `Card-present adjustment ${signed(adj)} bps is outside the allowed ` +
          `${signed(range.min)} to ${signed(range.max)} bps`,
        value: adj, limit: adj < range.min ? range.min : range.max,
      });
    }
  }

  const cnp = Math.round(input.cardNotPresentBps);
  const policyCnp = Math.round(input.policyCardNotPresentBps);
  if (cnp !== policyCnp) {
    out.push({
      kind: "cnp_rate",
      message: `Card-not-present rate ${pct(cnp)} differs from the ${pct(policyCnp)} policy rate`,
      value: cnp, limit: policyCnp,
    });
  }

  return out;
}

/** JSON with every object's keys sorted and `undefined` dropped, so equal values serialise equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter(k => (value as Record<string, unknown>)[k] !== undefined)
        .map(k => [k, canonical((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

/**
 * A stable hash of what an approval was given for. An approval holds only
 * while this matches: any change to the lines, the rates or the overrides
 * themselves produces a different fingerprint.
 */
export function overrideFingerprint(
  quoteLines: QuoteLine[],
  quoteRates: QuoteRates | null,
  overrides: QuoteOverride[]
): string {
  const json = JSON.stringify(canonical({ quoteLines, quoteRates, overrides }));
  return createHash("sha256").update(json).digest("hex");
}
