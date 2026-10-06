// AIO Payments margin matrix — provenance: Steve's 2026-07-23 pricing matrix
// (supersedes the prior "AIO Payments Margin Requirements.xlsx" take-rate/minMRR floors).
//   minMargin     = the true floor AIO won't go below (pillowed before reps see it)
//   desiredMargin = the default target we quote (per volume tier)
//   maxMargin     = soft ceiling (above it the rep gets a non-blocking warning)
//   desiredArr    = target annual revenue per account — reference only, not used in math

import { DEFAULT_QUOTE_RATES } from "@/types/merchant";
import type { ProcessorTier, QuoteConfig, QuoteRates, StatementAnalysis } from "@/types/merchant";

export const MARGIN_REQS = [
  { maxVol: 25000,    minMargin: 0.0067, desiredMargin: 0.0133,   maxMargin: 0.0200, desiredArr: 2000 },
  { maxVol: 50000,    minMargin: 0.0022, desiredMargin: 0.004467, maxMargin: 0.0067, desiredArr: 2000 }, // maxMargin filled per max=desired×1.5 (Steve left it blank)
  { maxVol: 75000,    minMargin: 0.0027, desiredMargin: 0.0053,   maxMargin: 0.0080, desiredArr: 4000 },
  { maxVol: 100000,   minMargin: 0.0019, desiredMargin: 0.0038,   maxMargin: 0.0057, desiredArr: 4000 },
  { maxVol: 125000,   minMargin: 0.0015, desiredMargin: 0.0030,   maxMargin: 0.0044, desiredArr: 4000 },
  { maxVol: 150000,   minMargin: 0.0012, desiredMargin: 0.0024,   maxMargin: 0.0036, desiredArr: 4000 },
  { maxVol: 175000,   minMargin: 0.0010, desiredMargin: 0.0021,   maxMargin: 0.0031, desiredArr: 4000 },
  { maxVol: 200000,   minMargin: 0.0009, desiredMargin: 0.0018,   maxMargin: 0.0027, desiredArr: 4000 },
  { maxVol: Infinity, minMargin: 0.0008, desiredMargin: 0.0017,   maxMargin: 0.0025, desiredArr: 4000 },
];

export function getMarginFloor(monthlyVolume: number) {
  return MARGIN_REQS.find(t => monthlyVolume <= t.maxVol) || MARGIN_REQS[MARGIN_REQS.length - 1];
}

// Per-tier default target margin (what the rep's slider starts at) and soft ceiling.
// SERVER-ONLY in practice — never import these into a client component, since reading
// them pulls the whole MARGIN_REQS array (incl. the true minMargin floor) into the bundle.
export function getDesiredMargin(monthlyVolume: number) {
  return getMarginFloor(monthlyVolume).desiredMargin;
}

export function getMaxMargin(monthlyVolume: number) {
  return getMarginFloor(monthlyVolume).maxMargin;
}

export function calcAdyenCost(tier: ProcessorTier, volume: number, txnCount: number): number {
  if (!tier) return 0;
  return (
    volume * (tier.processingBps || 0) +
    txnCount * (tier.perTxnFee || 0) +
    volume * (tier.schemeBps || 0) +
    (tier.monthlyFee || 0)
  );
}

export function adyenRateOnVolume(tier: ProcessorTier | null, volume: number, txnCount: number): number {
  if (!tier || !volume) return 0;
  return calcAdyenCost(tier, volume, txnCount) / volume;
}

// Interchange estimate used when a statement doesn't itemize interchange
// (flat-rate / tiered — interchange is bundled, so its true cost is unknown).
// Steve 2026-07-23: assume 2.10% CP / 2.50% CNP, flat % (no separate per-item
// component yet — the average-ticket / DPI refinement is a deferred data project).
export const INTERCHANGE_ESTIMATE = {
  cardPresent:    0.0210,
  cardNotPresent: 0.0250,
};

export function blendedInterchangeEstimate(cpPct: number, cnpPct: number): number {
  return cpPct * INTERCHANGE_ESTIMATE.cardPresent + cnpPct * INTERCHANGE_ESTIMATE.cardNotPresent;
}

// ── Statement-less quotes ───────────────────────────────────────────────────
// When a rep quotes from configs (average ticket + monthly volume) with no
// statement in hand, these are the only assumptions the quote rests on. Both
// are already answered, and both are the same values derivePricing falls back
// to when a statement omits them — so a config quote and a statement quote
// that happen to agree on volume/ticket price identically.
//
// PROVISIONAL, pending PRICING-QUESTIONS-FOR-STEVE #4: the 90/10 split is
// Steve's blended default, not a per-MCC one. A restaurant is overwhelmingly
// card-present, so if the answer ever becomes MCC-aware this is the constant
// that moves. Interchange itself is NOT provisional — INTERCHANGE_ESTIMATE
// above carries Steve's 2026-07-23 answer to question #1.
//
// Deliberately absent: an assumed CURRENT effective rate. Quoting savings
// without a statement would mean inventing what the merchant pays today
// (PRICING-QUESTIONS #2, unanswered), so the config path quotes a rate and
// leaves CustomerSafeQuote's savings fields null instead.
export const CONFIG_QUOTE_ASSUMPTIONS = {
  cardPresentPct: 0.9,
  cardNotPresentPct: 0.1,
};

// Projects a rep-entered quoteConfig into the analysis shape the rest of the
// pricing pipeline already speaks, so derivePricing / derivePricingForRole /
// getPricingPreviewAction need no statement-less variant of their own — and
// so the role-scoped path is identical for both quote bases.
// Fields a statement would supply but a config cannot (card brand mix, the
// merchant's current processor and fees) stay zeroed; `confidence: "low"` and
// `icEstimated: true` mark the result as derived rather than read.
export function analysisFromQuoteConfig(config: QuoteConfig): StatementAnalysis {
  const vol = config.monthlyVolume || 0;
  const ticket = config.avgTicket || 0;
  const txns = ticket > 0 ? Math.round(vol / ticket) : 0;
  const { cardPresentPct: cpPct, cardNotPresentPct: cnpPct } = CONFIG_QUOTE_ASSUMPTIONS;
  const icRate = blendedInterchangeEstimate(cpPct, cnpPct);

  return {
    merchantName: "",
    processingMonth: "",
    totalVolume: vol,
    totalTransactions: txns,
    // No statement, so nothing is known about what they pay today. Left at 0
    // rather than estimated — see the note on CONFIG_QUOTE_ASSUMPTIONS.
    totalFees: 0,
    interchangeFees: vol * icRate,
    processorFees: 0,
    otherFees: 0,
    effectiveRate: 0,
    interchangeRate: icRate,
    processorMarkup: 0,
    statedMarkupRate: 0,
    statedPerTxnFee: 0,
    interchangeNotShown: true,
    averageTicket: ticket,
    cardPresentVolume: vol * cpPct,
    cardNotPresentVolume: vol * cnpPct,
    cardPresentPct: cpPct,
    cardNotPresentPct: cnpPct,
    visaVolume: 0,
    mastercardVolume: 0,
    amexVolume: 0,
    discoverVolume: 0,
    rewardCardPct: 0,
    corporateCardPct: 0,
    currentPricingModel: "unknown",
    currentProcessorName: "",
    annualVolume: vol * 12,
    confidence: "low",
    notes: "Derived from rep-entered volume and average ticket — no statement was provided.",
    currentMargin: 0,
    icEstimated: true,
  };
}

export type FeeOverrides = {
  monthlyFee: number;
  perTxnFee: number;
  cpPerTxnFee: number;
  cnpPerTxnFee: number;
};

export type DerivedPricing = {
  flatRate: number;
  cpRate: number;
  cnpRate: number;
  amexCpRate: number;
  amexCnpRate: number;
  /** Volume attributed to AMEX. 0 with no statement — see the note in derivePricing. */
  amexVol: number;
  bps: number;                 // interchange-plus basis points (above IC)
  perTxnFee: number;           // effective per-txn fee used
  // On 2-tier, the margin the QUOTED rates leave over interchange — an output,
  // not the input it used to be. On the two unsellable models, still the volume
  // tier's desired margin, which is what they price off.
  appliedTargetMargin: number;
  projectedMonthlyFees: number;
  aioRevenue: number;          // projected AIO monthly revenue
  marginFloor: number;         // minimum-margin floor in $ for this volume tier (vol × minMargin)
  cpVol: number;
  cnpVol: number;
  cpPct: number;
  cnpPct: number;
};

/** The rates to price a 2-tier quote on, with the standard ones as the floor-less default. */
export function ratesFor(rates: QuoteRates | null | undefined): QuoteRates {
  return rates ?? DEFAULT_QUOTE_RATES;
}

export function derivePricing(
  analysis: { totalVolume: number; totalTransactions: number; interchangeRate: number; icEstimated?: boolean; cardPresentPct?: number; cardNotPresentPct?: number; cardPresentVolume?: number; cardNotPresentVolume?: number; amexVolume?: number },
  /**
   * The quoted rates, for the only model AIO sells. Null falls back to
   * DEFAULT_QUOTE_RATES — a row written before rates were the input prices at
   * today's standard rate rather than at nothing.
   *
   * The other two models have no rate input and never had one: they are not
   * sellable (see SELECTABLE_PRICING_MODELS) and keep pricing off the volume
   * tier's desired margin, which is what they did before any of this when the
   * caller passed no target.
   */
  rates: QuoteRates | null | undefined,
  pricingModel: string,
  feeOverrides: FeeOverrides
): DerivedPricing {
  const vol   = analysis.totalVolume || 0;
  const txns  = analysis.totalTransactions || 0;
  const icRate = analysis.interchangeRate || 0;

  const quoted = ratesFor(rates);
  // Only the unsellable models still work backwards from a margin.
  const margin = getDesiredMargin(vol);

  // CP/CNP split — default 90/10 (Steve 2026-07-23) when the statement gives neither.
  // 0 means "unknown" (the analyzer coerces invalid pcts to 0), so a genuine 0 only
  // survives when the other lane is explicitly provided (e.g. a 100%-CNP rep override).
  const rawCp  = analysis.cardPresentPct    || 0;
  const rawCnp = analysis.cardNotPresentPct || 0;
  const cpPct  = (rawCp > 0 || rawCnp > 0) ? rawCp  : 0.9;
  const cnpPct = (rawCp > 0 || rawCnp > 0) ? (rawCnp || 1 - rawCp) : 0.1;
  const cpVol  = analysis.cardPresentVolume    || vol * cpPct;
  const cnpVol = analysis.cardNotPresentVolume || vol * cnpPct;

  // Per-lane interchange: when interchange is estimated (bundled/unknown statement),
  // use the exact CP/CNP estimate lanes; otherwise split the itemized blended rate.
  const cpIcRate  = analysis.icEstimated
    ? INTERCHANGE_ESTIMATE.cardPresent
    : (cpVol  > 0 ? (icRate * vol * cpPct)  / cpVol  : icRate * 0.85);
  const cnpIcRate = analysis.icEstimated
    ? INTERCHANGE_ESTIMATE.cardNotPresent
    : (cnpVol > 0 ? (icRate * vol * cnpPct) / cnpVol : icRate * 1.15);

  // Flat rate (hidden model — kept for future; folds fees into the rate as before)
  const flatRevNeeded    = vol * margin;
  const flatFeeRevenue   = txns * (feeOverrides.perTxnFee || 0) + (feeOverrides.monthlyFee || 0);
  const flatPctRevNeeded = Math.max(0, flatRevNeeded - flatFeeRevenue);
  const derivedFlatRate  = icRate + flatPctRevNeeded / (vol || 1);

  // 2-tier — the rates are QUOTED, not derived. Fees are charged on top of the
  // rate (Steve 2026-07-23) rather than folded into it, so the per-transaction
  // fee is a separate term in projectedMonthlyFees below and never moves the
  // percentage the merchant was shown.
  const derivedCPRate  = quoted.cardPresentRate;
  const derivedCNPRate = quoted.cardNotPresentRate;

  // AMEX is priced apart from Visa/Mastercard/Discover, so the volume splits
  // four ways: two brand groups x two lanes.
  //
  // The statement gives an AMEX total and a card-present split, but never the
  // cross-tab of the two — so AMEX is assumed to split CP/CNP in the same
  // ratio as the merchant overall. It is the only assumption available, and it
  // errs small: the two rates are equal by default, so it moves nothing until
  // someone prices AMEX differently.
  //
  // With NO statement there is no AMEX figure at all, and none is invented
  // (product-owner decision, 2026-10-06) — `analysisFromQuoteConfig` leaves
  // amexVolume at 0, so a config quote prices every dollar at the V/MD rates.
  // The AMEX rates still appear on the quote; they just don't move the
  // projection. Assuming a share would be quoting a saving off a number
  // nobody supplied.
  const amexVol = Math.max(0, Math.min(vol, analysis.amexVolume || 0));
  const amexCpVol  = amexVol * cpPct;
  const amexCnpVol = amexVol * cnpPct;
  const baseCpVol  = Math.max(0, cpVol  - amexCpVol);
  const baseCnpVol = Math.max(0, cnpVol - amexCnpVol);

  const bps        = Math.round(margin * 10000);
  const perTxnFee  = pricingModel === "2-tier"
    ? (quoted.perTransactionFee || 0)
    : (feeOverrides.perTxnFee || 0);

  let projectedMonthlyFees = 0;
  if (pricingModel === "flat-rate") {
    projectedMonthlyFees = vol * derivedFlatRate + txns * perTxnFee + (feeOverrides.monthlyFee || 0);
  } else if (pricingModel === "2-tier") {
    // One per-transaction fee across both lanes, which is how the rate card
    // reads ("+ $0.15" on every line) and how a merchant checks their
    // statement. The old per-lane overrides are gone with the margin input
    // they shipped beside.
    projectedMonthlyFees =
      baseCpVol * derivedCPRate + baseCnpVol * derivedCNPRate +
      amexCpVol * quoted.amexCardPresentRate + amexCnpVol * quoted.amexCardNotPresentRate +
      txns * perTxnFee +
      (feeOverrides.monthlyFee || 0);
  } else {
    projectedMonthlyFees = vol * icRate + vol * margin + txns * perTxnFee + (feeOverrides.monthlyFee || 0);
  }

  const floorTier   = getMarginFloor(vol);
  const marginFloor = vol * floorTier.minMargin;
  // aioRevenue = projected - what merchant would pay at IC-only
  const icOnlyCost  = vol * icRate;
  const aioRev      = projectedMonthlyFees - icOnlyCost;

  // On 2-tier this is now an OUTPUT — what the quoted rates happen to leave
  // over interchange, per dollar of volume — where it used to be the input the
  // rates were worked back from. Nothing refuses a quote for it; it feeds the
  // rep's collapsed internal panel and the margin work that comes later.
  const effectiveMargin = pricingModel === "2-tier"
    ? (vol > 0 ? aioRev / vol : 0)
    : margin;

  return {
    flatRate: derivedFlatRate,
    cpRate: derivedCPRate,
    cnpRate: derivedCNPRate,
    amexCpRate: quoted.amexCardPresentRate,
    amexCnpRate: quoted.amexCardNotPresentRate,
    amexVol,
    bps, perTxnFee,
    appliedTargetMargin: effectiveMargin,
    projectedMonthlyFees,
    aioRevenue: Math.max(0, aioRev),
    marginFloor,
    cpVol, cnpVol, cpPct, cnpPct,
  };
}

// Global admin-set padding applied to the true floor/cost before a rep is
// allowed to see it — reps must never discover or undercut AIO's actual
// rock-bottom margin. Pure function; the active policy is fetched from the
// margin_policy table by the caller (see lib/actions/pricing.ts) and passed
// in here, keeping this file free of DB access.
export type PaddingConfig = {
  paddingPct: number;          // proportional pad on the true min-margin floor (0.5 = +50%, i.e. floor × 1.5)
  paddingMinMrrAdd: number;    // flat $ padding added to the computed dollar floor
  paddingAdyenCostHide: boolean; // whether the exact Adyen cost rate is hidden from reps
};

// Padded floor RATE for reps — the true min-margin scaled up by the admin pillow.
// Proportional (not flat bps) so it tracks each volume tier: Steve's min margins span
// 0.08%–0.67%, and a flat pad would either swamp the small floors or exceed the desired
// default on the large ones. With pad < 1, the padded floor always stays below the tier's
// desired margin (desired ≈ 2× min), so the default quote is never itself below-floor.
// The flat dollar pad (paddingMinMrrAdd) is applied to the resulting dollar floor by the
// caller, not here, so both pillow knobs stay meaningful.
export function getPaddedFloorRate(minMargin: number, padding: PaddingConfig): number {
  return minMargin * (1 + padding.paddingPct);
}

export type RoleScopedPricing = DerivedPricing & {
  belowCostFloor: boolean;    // computed from the TRUE Adyen cost server-side; the cost itself is never derived from this flag
  belowMarginFloor: boolean;  // target margin is below the (padded, for reps) min-margin floor — blocks the client-side
                              // save button (PricingStep.tsx, EditQuotePanel.tsx); the write-path backstop against the
                              // TRUE floor lives server-side in actions/prospects.ts (assertMarginAboveTrueFloor)
  adyenCostRate: number | null; // null when hidden from this role (reps, per paddingAdyenCostHide)
  desiredMargin: number;      // per-tier default target (rep-visible)
  maxMargin: number;          // per-tier soft ceiling (rep-visible)
};

// Returns a pricing view scoped to who's asking. Admins get the true
// marginFloor/adyenCostRate; everyone else gets the padded floor and
// (per policy) a redacted cost, plus safe belowCostFloor / belowMarginFloor
// booleans computed from the true numbers without ever exposing them.
export function derivePricingForRole(
  analysis: Parameters<typeof derivePricing>[0],
  rates: QuoteRates | null | undefined,
  pricingModel: string,
  feeOverrides: FeeOverrides,
  role: "admin" | "rep",
  activeTier: ProcessorTier | null,
  padding: PaddingConfig
): RoleScopedPricing {
  const result = derivePricing(analysis, rates, pricingModel, feeOverrides);
  const appliedMargin = result.appliedTargetMargin;
  const vol = analysis.totalVolume || 0;
  const tier = getMarginFloor(vol);
  const trueAdyenCostRate = activeTier ? adyenRateOnVolume(activeTier, analysis.totalVolume, analysis.totalTransactions) : 0;
  const belowCostFloor = !!activeTier && appliedMargin - trueAdyenCostRate < 0;

  if (role === "admin") {
    return {
      ...result,
      belowCostFloor,
      belowMarginFloor: appliedMargin < tier.minMargin,
      adyenCostRate: activeTier ? trueAdyenCostRate : null,
      desiredMargin: tier.desiredMargin,
      maxMargin: tier.maxMargin,
    };
  }

  const paddedRate = getPaddedFloorRate(tier.minMargin, padding);
  const paddedMarginFloor = vol * paddedRate + padding.paddingMinMrrAdd;

  return {
    ...result,
    marginFloor: paddedMarginFloor,
    belowCostFloor,
    belowMarginFloor: appliedMargin < paddedRate,
    adyenCostRate: padding.paddingAdyenCostHide ? null : trueAdyenCostRate,
    desiredMargin: tier.desiredMargin,
    maxMargin: tier.maxMargin,
  };
}
