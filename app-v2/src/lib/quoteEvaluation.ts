// Which admin-approvable overrides a SAVED quote carries, and whether its
// approval still covers them (draft quotes + admin override approval,
// 2026-11-02).
//
// Server-only in practice: it reads the live rate card and margin table
// (`loadMarginReqs`, itself server-only). Deliberately NOT a "use server"
// file: every export of one is a callable endpoint, and these take a whole
// application rather than an id the caller has been scoped to.
//
// Everything here works off the values PERSISTED on the row — the quote
// lines and rates the merchant will be sent — never off the picks they were
// built from. That is what lets the save, the approval and the publish gate
// (`preconditions.ts`) all agree: each recomputes from the same row. The line
// half is what `buildQuote` reports as `BuiltQuote.overrides` for those same
// lines (it runs the same `adjustmentBlockers` sink and unit-cap sum over its
// finished `quoteLines`); the plan-line id it also passes only changes a HARD
// refusal, which a saved row can never carry.

import { getMaxDiscountPercent, getPricingPreviewAction, getQuoteLimits } from "@/lib/actions/pricing";
import { getRateMatrix } from "@/lib/actions/rateMatrix";
import { loadMarginReqs } from "@/lib/marginReqsLoader";
import { getMarginFloor } from "@/lib/pricing";
import { overrideFingerprint, rateOverrides } from "@/lib/quoteOverrides";
import {
  adjustmentBlockers, maxQtyFor, processesCardNotPresentOnly, quoteHasProcessing, quoteTypeOf,
} from "@/lib/quoting";
import { lookupCardPresentRate } from "@/lib/rateMatrix";
import { adjustBpsRangeFor } from "@/lib/wholesale";
import { averageTicketOf, type MerchantApplication, type QuoteOverride } from "@/types/merchant";

export type EvaluatedQuote = Pick<
  MerchantApplication, "quoteType" | "quoteLines" | "quoteRates" | "analysis" | "quoteConfig" | "pricingModel"
>;

// No fee overrides are persisted on an application, so the floor is judged
// against zero — the same posture the old `assertRateAboveFloor` took.
const ZERO_FEE_OVERRIDES = { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 };

/** Discount caps and unit caps, read off the saved lines against today's limits. */
async function lineOverrides(app: EvaluatedQuote): Promise<QuoteOverride[]> {
  const lines = app.quoteLines ?? [];
  if (!lines.length) return [];
  const [maxDiscountPercent, limits] = await Promise.all([getMaxDiscountPercent(), getQuoteLimits()]);
  const out: QuoteOverride[] = [];
  // Only the override sink is read: the hard refusals were enforced when the
  // lines were derived, and a saved row cannot carry one.
  adjustmentBlockers(lines, maxDiscountPercent, limits.maxBillingDelayDays, limits.discountCaps, null, out);
  // Summed per product, exactly as buildQuote sums them.
  const qtyByProduct = new Map<string, { name: string; qty: number }>();
  for (const line of lines) {
    const prev = qtyByProduct.get(line.hubspotProductId);
    qtyByProduct.set(line.hubspotProductId, { name: line.name, qty: (prev?.qty ?? 0) + line.qty });
  }
  for (const [productId, { name, qty }] of qtyByProduct) {
    const max = maxQtyFor(productId, limits.unitCaps);
    if (max != null && qty > max) {
      out.push({
        kind: "unit_cap", productId, productName: name,
        message: `${name}: ${qty} units (cap ${max})`, value: qty, limit: max,
      });
    }
  }
  return out;
}

/** The card-present and card-not-present overrides, against the live rate card and margin table. */
async function rateOverridesFor(app: EvaluatedQuote): Promise<QuoteOverride[]> {
  const rates = app.quoteRates;
  const quoteType = quoteTypeOf(app.quoteType);
  const lines = app.quoteLines ?? [];
  if (!rates || !quoteHasProcessing(quoteType, lines)) return [];

  const analysis = app.analysis ?? null;
  const quoteConfig = analysis ? null : app.quoteConfig ?? null;
  const pricing = analysis || quoteConfig
    ? await getPricingPreviewAction({
        analysis,
        quoteConfig,
        quoteRates: rates,
        pricingModel: app.pricingModel ?? "2-tier",
        feeOverrides: ZERO_FEE_OVERRIDES,
        activeTier: null,
        // All card-not-present when they only take orders online, so the floor
        // is judged on the rate actually quoted.
        cardPresentPct: processesCardNotPresentOnly(quoteType, lines) ? 0 : null,
      })
    : null;

  // The rate card cell this quote's volume and ticket read, the same lookup
  // `getSuggestedRatesAction` makes (and the same basis EditQuotePanel hands it).
  const volume = analysis ? analysis.totalVolume : quoteConfig?.monthlyVolume ?? 0;
  const ticket = analysis ? averageTicketOf(analysis) : quoteConfig?.avgTicket ?? 0;
  const matrix = await getRateMatrix();
  const cell = lookupCardPresentRate(matrix, volume, ticket);
  const cardPresentBps = Math.round(rates.cardPresentRate * 10000);
  let cpAdjustmentBps: number | null = null;
  let adjustBpsRange: { min: number; max: number } | null = null;
  if (cell !== null) {
    cpAdjustmentBps = cardPresentBps - Math.round(cell * 10000);
    const marginReqs = await loadMarginReqs();
    adjustBpsRange = adjustBpsRangeFor(
      cell, volume, ticket, matrix.perTransactionFeeCents / 100, getMarginFloor(volume, marginReqs)
    );
  }

  return rateOverrides({
    pricing,
    cardPresentBps,
    cpAdjustmentBps,
    adjustBpsRange,
    cardNotPresentBps: rates.cardNotPresentRate * 10000,
    policyCardNotPresentBps: matrix.cardNotPresentBps,
  });
}

/**
 * Every limit this saved quote goes past that an admin may approve on it:
 * discount caps and unit caps first (the order `buildQuote` reports them in),
 * then the rates. Empty means it needs no approval.
 */
export async function evaluateQuoteOverrides(app: EvaluatedQuote): Promise<QuoteOverride[]> {
  return [...(await lineOverrides(app)), ...(await rateOverridesFor(app))];
}

/**
 * The fingerprint an approval is stored and checked under. Normalised exactly
 * as the publish gate (`preconditions.ts`) normalises it — `?? []` for the
 * lines, `?? null` for the rates — over the values persisted on the row.
 */
export function quoteFingerprint(
  app: Pick<MerchantApplication, "quoteLines" | "quoteRates">,
  overrides: QuoteOverride[]
): string {
  return overrideFingerprint(app.quoteLines ?? [], app.quoteRates ?? null, overrides);
}

/**
 * Whether the row's approval covers these overrides: approved, and given for
 * exactly this quote. The one validity check `sendDraftAction`,
 * `approveQuoteAction` and `saveQuoteConfigurationAction` share.
 */
export function approvalCovers(
  app: Pick<MerchantApplication, "quoteLines" | "quoteRates" | "quoteApproval">,
  overrides: QuoteOverride[]
): boolean {
  const approval = app.quoteApproval;
  return !!approval?.approvedAt && approval.fingerprint === quoteFingerprint(app, overrides);
}

/** The base every staff email link is built on, as the other callers build it. */
export function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
}
