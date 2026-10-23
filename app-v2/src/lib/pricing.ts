// AIO Payments margin matrix — provenance: Steve's 2026-07-23 pricing matrix
// (supersedes the prior "AIO Payments Margin Requirements.xlsx" take-rate/minMRR floors).
//   minMargin     = the floor AIO won't go below (the same for reps and admins since 2026-10-23)
//   desiredMargin = the default target we quote (per volume tier)
//   maxMargin     = soft ceiling (above it the rep gets a non-blocking warning)
//   desiredArr    = target annual revenue per account — reference only, not used in math

// DEFAULT_CARD_PRESENT_PCT lives in types/merchant.ts, not here, so the client
// components that need it (PricingStep, the prospect form) can import it
// without pulling in MARGIN_REQS — see its doc comment there for the full
// history of the 90→95 disagreement this constant fixes.
import {
  averageTicketOf, DEFAULT_QUOTE_RATES, DEFAULT_CARD_PRESENT_PCT, MAX_PLAUSIBLE_CARD_RATE,
  MIN_MONTHLY_PROCESSING_REVENUE,
} from "@/types/merchant";
import type { ProcessorTier, QuoteConfig, QuoteRates, StatementAnalysis } from "@/types/merchant";
import { totalRevenue, totalTakeRate, wholesalePctFor } from "@/lib/wholesale";
import { commissionFromTotalArr, sumArrOrNull, type CommissionFromArr } from "@/lib/commission";
import { fmt$ } from "@/lib/utils";

export type MarginReq = {
  maxVol: number; minMargin: number; desiredMargin: number; maxMargin: number; desiredArr: number;
};

// The CODE defaults. The live table is admin-edited on the rate-matrix page and
// loaded server-side by `loadMarginReqs` (lib/marginReqsPolicy.ts), which falls
// back to this when there is no saved row or the read fails.
export const MARGIN_REQS: readonly MarginReq[] = [
  { maxVol: 25000,    minMargin: 0.0085, desiredMargin: 0.0100,   maxMargin: 0.0200, desiredArr: 1500 }, // Oct 2026 guide §7
  { maxVol: 50000,    minMargin: 0.0065, desiredMargin: 0.0085,   maxMargin: 0.0100, desiredArr: 3825 }, // Oct 2026 guide §7
  { maxVol: 75000,    minMargin: 0.0027, desiredMargin: 0.0053,   maxMargin: 0.0080, desiredArr: 4000 },
  { maxVol: 100000,   minMargin: 0.0019, desiredMargin: 0.0038,   maxMargin: 0.0057, desiredArr: 4000 },
  { maxVol: 125000,   minMargin: 0.0015, desiredMargin: 0.0030,   maxMargin: 0.0044, desiredArr: 4000 },
  { maxVol: 150000,   minMargin: 0.0012, desiredMargin: 0.0024,   maxMargin: 0.0036, desiredArr: 4000 },
  { maxVol: 175000,   minMargin: 0.0010, desiredMargin: 0.0021,   maxMargin: 0.0031, desiredArr: 4000 },
  { maxVol: 200000,   minMargin: 0.0009, desiredMargin: 0.0018,   maxMargin: 0.0027, desiredArr: 4000 },
  { maxVol: Infinity, minMargin: 0.0008, desiredMargin: 0.0017,   maxMargin: 0.0025, desiredArr: 4000 },
];

export function getMarginFloor(monthlyVolume: number, reqs: readonly MarginReq[] = MARGIN_REQS): MarginReq {
  return reqs.find(t => monthlyVolume <= t.maxVol) || reqs[reqs.length - 1];
}

// Per-tier default target margin (what the rep's slider starts at) and soft ceiling.
// SERVER-ONLY in practice — never import these into a client component, since reading
// them pulls the whole MARGIN_REQS array (incl. the true minMargin floor) into the bundle.
export function getDesiredMargin(monthlyVolume: number, reqs: readonly MarginReq[] = MARGIN_REQS) {
  return getMarginFloor(monthlyVolume, reqs).desiredMargin;
}

export function getMaxMargin(monthlyVolume: number, reqs: readonly MarginReq[] = MARGIN_REQS) {
  return getMarginFloor(monthlyVolume, reqs).maxMargin;
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
// Interchange itself is NOT provisional — INTERCHANGE_ESTIMATE above carries
// Steve's 2026-07-23 answer to question #1. Only the split (see
// DEFAULT_CARD_PRESENT_PCT) is provisional.
//
// Deliberately absent: an assumed CURRENT effective rate. Quoting savings
// without a statement would mean inventing what the merchant pays today
// (PRICING-QUESTIONS #2, unanswered), so the config path quotes a rate and
// leaves CustomerSafeQuote's savings fields null instead.
export const CONFIG_QUOTE_ASSUMPTIONS = {
  cardPresentPct: DEFAULT_CARD_PRESENT_PCT,
  cardNotPresentPct: 1 - DEFAULT_CARD_PRESENT_PCT,
};

// Projects a rep-entered quoteConfig into the analysis shape the rest of the
// pricing pipeline already speaks, so derivePricing / derivePricingForRole /
// getPricingPreviewAction need no statement-less variant of their own — and
// so the role-scoped path is identical for both quote bases.
// Fields a statement would supply but a config cannot (card brand mix, the
// merchant's current processor and fees) stay zeroed; `confidence: "low"` and
// `icEstimated: true` mark the result as derived rather than read.
export function analysisFromQuoteConfig(
  config: QuoteConfig,
  /**
   * The share of volume taken card-present, when the caller knows it and the
   * standing 95% assumption would be wrong. Today exactly one caller does:
   * a merchant who takes orders online and has nothing on site passes 0
   * (`processesCardNotPresentOnly`, quoting.ts).
   *
   * Without it, hiding the card-present rate from that rep's screen — which
   * is what the product owner asked for on 2026-10-14 — would leave the
   * merchant's own headline effective rate 95% weighted on the rate we had
   * just said can never apply. The display and the money have to agree.
   *
   * A real statement is untouched by this: it carries a measured split, and
   * `basis.analysis` wins over the config everywhere this is reached from.
   */
  cardPresentPctOverride?: number | null
): StatementAnalysis {
  const vol = config.monthlyVolume || 0;
  const ticket = config.avgTicket || 0;
  const txns = ticket > 0 ? Math.round(vol / ticket) : 0;
  const cpPct = cardPresentPctOverride ?? CONFIG_QUOTE_ASSUMPTIONS.cardPresentPct;
  const cnpPct = 1 - cpPct;
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
  /**
   * MIRRORS cpRate/cnpRate as of 2026-10-13 — AMEX is no longer priced apart
   * (see the note in derivePricing). Kept on this type only because
   * `generateProposal` (claude.ts) destructures these to fill
   * `ProposedRates2Tier.amexCardPresentRate`/`amexCardNotPresentRate`, which in
   * turn exist only so a proposal generated before today still renders.
   */
  amexCpRate: number;
  amexCnpRate: number;
  /** Volume attributed to AMEX, REPORTING ONLY as of 2026-10-13 — it no longer
   *  carves anything out of cpVol/cnpVol. 0 with no statement — see the note
   *  in derivePricing. */
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
  feeOverrides: FeeOverrides,
  /** The saved margin table; omitted means the MARGIN_REQS constants. */
  marginReqs: readonly MarginReq[] = MARGIN_REQS
): DerivedPricing {
  const vol   = analysis.totalVolume || 0;
  const txns  = analysis.totalTransactions || 0;
  const icRate = analysis.interchangeRate || 0;

  const quoted = ratesFor(rates);
  // Only the unsellable models still work backwards from a margin.
  const margin = getDesiredMargin(vol, marginReqs);

  // CP/CNP split — default DEFAULT_CARD_PRESENT_PCT when the statement gives
  // neither. 0 means "unknown" (the analyzer coerces invalid pcts to 0), so a
  // genuine 0 only survives when the other lane is explicitly provided (e.g. a
  // 100%-CNP rep override).
  const rawCp  = analysis.cardPresentPct    || 0;
  const rawCnp = analysis.cardNotPresentPct || 0;
  const cpPct  = (rawCp > 0 || rawCnp > 0) ? rawCp  : DEFAULT_CARD_PRESENT_PCT;
  const cnpPct = (rawCp > 0 || rawCnp > 0) ? (rawCnp || 1 - rawCp) : 1 - DEFAULT_CARD_PRESENT_PCT;
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

  // AMEX is priced at the ordinary V/MC/Discover rates, not apart from them
  // (2026-10-13, "get rid of the dual rate (amex)" — reverses the 2026-10-06
  // "AMEX priced apart" decision from the product owner). AMEX volume is no
  // longer carved out of cpVol/cnpVol: it is already part of them (cpVol/cnpVol
  // are the WHOLE merchant's card-present/not-present split), so folding AMEX
  // back in is simply not subtracting it out any more.
  //
  // `QuoteRates.amexCardPresentRate`/`amexCardNotPresentRate` still exist —
  // rows saved before today carry real numbers in them and have to keep
  // parsing, same pattern as `StoredQuoteType` — but nothing here reads them
  // for pricing purposes any more. `amexVol` is kept as a REPORTING figure
  // only (how much of this merchant's statement volume is AMEX); it no longer
  // carves anything out of the fee math below.
  const amexVol = Math.max(0, Math.min(vol, analysis.amexVolume || 0));

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
    // they shipped beside. cpVol/cnpVol is EVERY dollar in that lane, AMEX
    // included (see the note above) — there is no longer a separate AMEX term.
    projectedMonthlyFees =
      cpVol * derivedCPRate + cnpVol * derivedCNPRate +
      txns * perTxnFee +
      (feeOverrides.monthlyFee || 0);
  } else {
    projectedMonthlyFees = vol * icRate + vol * margin + txns * perTxnFee + (feeOverrides.monthlyFee || 0);
  }

  const floorTier   = getMarginFloor(vol, marginReqs);
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
    amexCpRate: derivedCPRate,
    amexCnpRate: derivedCNPRate,
    amexVol,
    bps, perTxnFee,
    appliedTargetMargin: effectiveMargin,
    projectedMonthlyFees,
    aioRevenue: Math.max(0, aioRev),
    marginFloor,
    cpVol, cnpVol, cpPct, cnpPct,
  };
}

// What a rep may see of AIO's cost. Named for the margin_policy columns it is
// read from. It carried the margin padding (a % and a flat $ added to the
// min-margin floor for reps) until 2026-10-23, when that was removed (product
// owner: "there is no need for padding if the admin can just adjust the min
// and max anyways"). The padding_bps / padding_min_mrr_add columns are left
// in place and are neither read nor written.
export type PaddingConfig = {
  paddingAdyenCostHide: boolean; // whether the exact Adyen cost rate is hidden from reps
};

export type RoleScopedPricing = DerivedPricing & {
  belowCostFloor: boolean;    // computed from the TRUE Adyen cost server-side; the cost itself is never derived from this flag
  belowMarginFloor: boolean;  // target margin is below the tier's min-margin floor — blocks the client-side
                              // save button (PricingStep.tsx, EditQuotePanel.tsx); the write-path backstop against the
                              // TRUE floor lives server-side in actions/prospects.ts (assertMarginAboveTrueFloor)
  adyenCostRate: number | null; // null when hidden from this role (reps, per paddingAdyenCostHide)
  desiredMargin: number;      // per-tier default target (rep-visible)
  maxMargin: number;          // per-tier soft ceiling (rep-visible)
  /**
   * What a REP sees of their commission (2026-10-13 — "the only thing to
   * display... is the margin, cuz thats how reps see their commission").
   * ESTIMATED signing + activation commission on THIS quote, computed off
   * the SAME wholesale-table commission margin lib/billing/processingArr.ts
   * uses for `payment_processing_arr` — via wholesale.ts directly, since
   * there's no MerchantApplication yet at preview time to hand
   * `paymentProcessingArrBreakdown` — plus `recurringArr` below, which is
   * itself an ESTIMATE (`estimatedRecurringArrFromQuoteLines`,
   * lib/commission.ts), not a live HubSpot read. This figure is NOT what
   * `lib/billing/commissionWriteback.ts` actually writes — that function
   * reads HubSpot's real `saas_revenue` at acceptance instead, because the
   * two provably diverge (see that estimate function's doc comment). The UI
   * must label this "(est.)" for that reason — don't let a rep read it as a
   * guarantee of what they'll be paid.
   *
   * NOT role-scoped or padded: this margin is already the one
   * processingArr.ts's own comment calls "AIO's own forecast... not a
   * secret", so admin and rep get the identical number — the trade the
   * product owner accepted is that margin % + this wholesale table let a rep
   * back out AIO's cost basis, not a bug to solve here.
   */
  projectedCommission: CommissionFromArr;
  /**
   * What AIO itself earns on this merchant's processing at the quoted rates —
   * a month of it, and the same figure annualised (`payment_processing_arr`'s
   * own number; see `projectedProcessingRevenue`). Null when there is no
   * volume/ticket basis to compute against, or when a quoted rate is past
   * `MAX_PLAUSIBLE_CARD_RATE` and the inputs are therefore a typo.
   *
   * Shown to reps verbatim (2026-10-15 — "show montly revenue and yearly arr
   * in the card rate box"). Rep-safe for the same reason `projectedCommission`
   * is: it is built on the wholesale table, which is AIO's own forecast of its
   * own revenue, not AIO's cost.
   */
  monthlyProcessingRevenue: number | null;
  processingArr: number | null;
  /**
   * `monthlyProcessingRevenue` is under `MIN_MONTHLY_PROCESSING_REVENUE`.
   * False when there is no basis to judge — the same posture
   * `belowMarginFloor` takes, and the reason a quote with no volume on it
   * still goes out with priced lines and no rate.
   */
  belowMonthlyRevenueFloor: boolean;
};

// Returns a pricing view scoped to who's asking. Everyone is judged against
// the same min-margin floor (no rep padding since 2026-10-23); admins get the
// true adyenCostRate, everyone else (per policy) a redacted one, plus a safe
// belowCostFloor boolean computed from the true cost without exposing it.
export function derivePricingForRole(
  analysis: Parameters<typeof derivePricing>[0],
  rates: QuoteRates | null | undefined,
  pricingModel: string,
  feeOverrides: FeeOverrides,
  role: "admin" | "rep",
  activeTier: ProcessorTier | null,
  padding: PaddingConfig,
  /**
   * An ESTIMATE of annualised recurring (SaaS/hardware subscription) revenue
   * already known for this quote — not a HubSpot read. Null/omitted on
   * PricingStep, where no products are configured yet — the commission shown
   * there reflects processing margin only, not the eventual platform-fee
   * ARR. EditQuotePanel passes the configurator's live totals, so its figure
   * is the fuller (still estimated) one.
   */
  recurringArr: number | null = null,
  /**
   * The saved margin table (rate-matrix page). Omitted means the MARGIN_REQS
   * constants. Server callers load it via `loadMarginReqs`; never pass one
   * built from client input.
   */
  marginReqs: readonly MarginReq[] = MARGIN_REQS
): RoleScopedPricing {
  const result = derivePricing(analysis, rates, pricingModel, feeOverrides, marginReqs);
  const appliedMargin = result.appliedTargetMargin;
  const vol = analysis.totalVolume || 0;
  const tier = getMarginFloor(vol, marginReqs);
  const trueAdyenCostRate = activeTier ? adyenRateOnVolume(activeTier, analysis.totalVolume, analysis.totalTransactions) : 0;
  const belowCostFloor = !!activeTier && appliedMargin - trueAdyenCostRate < 0;
  const processing = projectedProcessingRevenue(analysis, rates);
  // Only a POSITIVE annual figure feeds the commission — unchanged, and
  // deliberately not folded into the new floor below: a commission on a
  // negative forecast is nonsense, where a negative forecast is precisely
  // what the floor has to see.
  // The commission is still figured on a WHOLE-DOLLAR ARR, as it always was —
  // `recurringArr`, the other half of the sum, is an integer too.
  const projectedCommission = commissionFromTotalArr(
    sumArrOrNull(processing && processing.annual > 0 ? Math.round(processing.annual) : null, recurringArr)
  );
  const revenueView = {
    monthlyProcessingRevenue: processing ? processing.monthly : null,
    processingArr: processing ? processing.annual : null,
    belowMonthlyRevenueFloor: !!processing && processing.monthly < MIN_MONTHLY_PROCESSING_REVENUE,
  };

  return {
    ...result,
    belowCostFloor,
    belowMarginFloor: appliedMargin < tier.minMargin,
    adyenCostRate: role === "admin"
      ? (activeTier ? trueAdyenCostRate : null)
      : (padding.paddingAdyenCostHide ? null : trueAdyenCostRate),
    desiredMargin: tier.desiredMargin,
    maxMargin: tier.maxMargin,
    projectedCommission,
    ...revenueView,
  };
}

/**
 * The processing half of `projectedCommission` above: this quote's annualised
 * commission margin (wholesale.ts's Total Take Rate minus Wholesale %, over a
 * year), computed DIRECTLY off the live rates/analysis rather than through
 * `paymentProcessingArrBreakdown` (lib/billing/processingArr.ts) — there is no
 * `MerchantApplication` yet at preview time to hand that function. Same
 * formula, same guards (no ticket → no basis; an implausible quoted rate →
 * no number, not a typo annualised), reused rather than reimplemented: both
 * this and processingArr.ts call the identical wholesale.ts primitives.
 */
function projectedProcessingRevenue(
  // `averageTicket` is optional here only because `derivePricing`'s own
  // analysis parameter doesn't declare it — every real caller passes a whole
  // StatementAnalysis, which carries it. Absent, `averageTicketOf` falls back
  // to volume ÷ transactions, which is what this used to do unconditionally.
  analysis: Parameters<typeof derivePricing>[0] & { averageTicket?: number },
  rates: QuoteRates | null | undefined
): { monthly: number; annual: number } | null {
  const vol = analysis.totalVolume || 0;
  if (!(vol > 0)) return null;
  // `averageTicketOf`, NOT volume ÷ transactions. They are not the same number
  // on a quote with no statement behind it: `analysisFromQuoteConfig` ROUNDS
  // the transaction count (a merchant doesn't take 4000.08 cards a month), so
  // dividing back out returns a ticket slightly off the one the rep typed —
  // $100,002 at a $25 ticket came back as $25.0005, which moved the margin by
  // 6/10000 of a point and the monthly figure from $300.01 to $299.99.
  //
  // It also put this preview at odds with `paymentProcessingArrBreakdown`
  // (lib/billing/processingArr.ts), which has always used `averageTicketOf`
  // — so the ARR a rep read here was not the ARR the deal would carry. Same
  // helper on both sides now; they're meant to be the same formula.
  const avgTicket = averageTicketOf({ ...analysis, averageTicket: analysis.averageTicket ?? 0 });
  if (!(avgTicket > 0)) return null;

  const quoted = ratesFor(rates);
  const maxQuotedRate = Math.max(quoted.cardPresentRate, quoted.cardNotPresentRate, quoted.amexCardPresentRate, quoted.amexCardNotPresentRate);
  if (maxQuotedRate > MAX_PLAUSIBLE_CARD_RATE) return null;

  const revenue = totalRevenue(quoted.cardPresentRate, vol, avgTicket, quoted.perTransactionFee);
  const takeRate = totalTakeRate(revenue, vol);
  const margin = takeRate - wholesalePctFor(avgTicket);
  const exact = margin * vol;
  if (!Number.isFinite(exact)) return null;
  // ROUNDED TO CENTS, and then annualised FROM the rounded figure — so the
  // two numbers a rep reads side by side multiply (2026-10-15). They are both
  // rendered to the cent, so an annual figure taken from the unrounded
  // monthly visibly fails the one arithmetic check anybody does on it: here,
  // $300.01 a month printed beside $3,600.07 a year. The monthly is the
  // figure a rep says out loud, so it is the one the year is built from.
  //
  // It therefore differs by pennies from `payment_processing_arr`, which is
  // computed at acceptance from the merchant's own row and rounded to whole
  // dollars (lib/billing/processingArr.ts) — a different moment and a
  // different rounding, not a disagreement about the money.
  //
  // NOT clamped at zero, and the commission caller is what still drops a
  // non-positive figure. A thin or negative margin is exactly what
  // `MIN_MONTHLY_PROCESSING_REVENUE` exists to refuse, and a null here would
  // read as "no basis to judge" — the one answer that lets it through.
  const monthly = Math.round(exact * 100) / 100;
  return { monthly, annual: monthly * 12 };
}

/**
 * The write-side half of the 2026-10-09 decision ("card rate minimums are
 * needed"): a rep's typed rates are refused server-side when they don't clear
 * AIO's margin floor for the volume on file, same as the rep form
 * (rep/prospects/new/page.tsx) and EditQuotePanel already refuse to submit
 * client-side.
 *
 * Takes an ALREADY-COMPUTED RoleScopedPricing (from `derivePricingForRole` via
 * `getPricingPreviewAction`, the exact function the UI calls) rather than
 * deriving a second one — a write path computing its own copy of this check
 * is how the two drift apart again.
 *
 * The message doesn't state the floor, only that the rate is under it. Reps
 * and admins are judged against the same tier minimum (the rep padding was
 * removed 2026-10-23).
 *
 * This is a HARD refusal with exactly ONE recovery for a rep: raise the rate.
 * There is no per-quote override; an admin moves the floor itself by editing
 * the Min margin column on /admin/settings/rate-matrix.
 */
export function marginFloorBlockers(pricing: Pick<RoleScopedPricing, "belowMarginFloor">): string[] {
  if (!pricing.belowMarginFloor) return [];
  return [
    "The card rate is below the minimum AIO can process this volume at. Raise the rate to send this quote.",
  ];
}

/**
 * The $10-a-month minimum on AIO's own processing revenue (product owner,
 * 2026-10-15). A SECOND, independent refusal alongside `marginFloorBlockers`
 * — a quote has to clear both — and the two are deliberately unalike:
 *
 *  - The margin floor is a RATE test against a padded, never-disclosed table,
 *    so its message states no figure and a rep can only ever hear "yes" or
 *    "no". This one is a DOLLAR test against a number the rep is shown live
 *    beside the rates, so it names both sides. Stating it costs nothing: a
 *    merchant doing $3,000 a month clears the margin floor comfortably and
 *    still isn't worth boarding, and that is what this sentence has to say.
 *  - It therefore binds hardest on SMALL volume, where a rate rise can't
 *    always fix it — hence "raise the rate, or this merchant is too small",
 *    rather than pointing at a rate that may have no reachable value.
 *
 * `MIN_MONTHLY_PROCESSING_REVENUE` lives in types/merchant.ts, not here, so
 * the rep surfaces can name the same number without bundling MARGIN_REQS.
 */
export function monthlyRevenueFloorBlockers(
  pricing: Pick<RoleScopedPricing, "belowMonthlyRevenueFloor" | "monthlyProcessingRevenue">
): string[] {
  if (!pricing.belowMonthlyRevenueFloor) return [];
  const earned = pricing.monthlyProcessingRevenue ?? 0;
  return [
    `At this rate AIO earns ${fmt$(earned)} a month on this merchant's processing, under the ` +
    `${fmt$(MIN_MONTHLY_PROCESSING_REVENUE)} minimum. Raise the card rate, or this merchant is ` +
    `too small to process for.`,
  ];
}
