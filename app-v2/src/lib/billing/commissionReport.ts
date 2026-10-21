// The ADMIN-ONLY per-deal commission breakdown (2026-10-13) — "the other
// stuff calculate it and store it in an admin only view somewhere" (product
// owner, on what used to be in PricingStep's/EditQuotePanel's AIO Internal
// panel). This is that somewhere: /admin, ?view=commissions.
//
// Pure given its inputs (apps, the active processor tier) — no DB, no
// HubSpot, no env reads. The action that fetches those is
// `getCommissionReportAction` (lib/actions/commissions.ts); this file only
// shapes what it found.
//
// Deliberately reuses `derivePricingForRole(..., "admin", ...)` rather than
// calling `derivePricing`/`getMarginFloor` directly: "admin" is the role that
// already bypasses every pad (see pricing.ts), so this gets the TRUE
// aioRevenue/adyenCostRate/marginFloor for free, through the one function
// CLAUDE.md says every pricing read must go through — not a second, parallel
// path to the same true numbers.
//
// `recurringArr`/`totalArr`/the two ARR-based commission figures on each row
// are built from `estimatedRecurringArrFromQuoteLines` — an ESTIMATE, not
// HubSpot's real `saas_revenue`. This panel lists every deal at once, so a
// live GET per row is off the table. The actual write to HubSpot
// (commissionWriteback.ts) does NOT use this report's numbers and does NOT
// share this estimate — it reads HubSpot's real saas_revenue at write time.
// Don't let this panel's figures be mistaken for "what will be written";
// they're a preview built the only way a list view can be.
//
// HARDWARE commission (rep/rsm, per product) is NOT an estimate — it's the
// exact formula over each quote's own snapshotted `costToRep`/
// `repCommissionBps`/`rsmCommissionBps` (see lib/commission.ts,
// `quoteHardwareCommission`). The only thing uncertain about it today is
// whether the catalog has the inputs at all — see `buildCommissionDataGaps`
// below, which is what makes that uncertainty visible instead of silently
// reading as "$0 everywhere, nothing to see."

import { derivePricingForRole, analysisFromQuoteConfig, type MarginReq, type PaddingConfig } from "@/lib/pricing";
import { paymentProcessingArrBreakdown } from "@/lib/billing/processingArr";
import {
  commissionFromTotalArr, estimatedRecurringArrFromQuoteLines, sumArrOrNull,
  isPolicyComped, isNotCommissionable, quoteHardwareCommission,
} from "@/lib/commission";
import type { MerchantApplication, ProcessorTier } from "@/types/merchant";

// No padding applies to an admin read, but `derivePricingForRole` still takes
// the parameter — this is the inert value, same role `getActivePaddingPolicy`'s
// DEFAULT_PADDING plays for a rep read that fails to load a real policy.
const NO_PADDING: PaddingConfig = { paddingPct: 0, paddingMinMrrAdd: 0, paddingAdyenCostHide: false };
const ZERO_FEES = { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 };

export type DealCommissionRow = {
  applicationId: string;
  merchantName: string | null;
  stage: string;
  quoteAcceptedAt: string | null;
  // ── FLOOR-ENFORCEMENT BASIS (derivePricingForRole / pricing.ts) ──────────
  // The true figures CLAUDE.md says a rep must never see — fine here, this
  // report is admin-only (enforced in the action, not this file). This is
  // revenue over INTERCHANGE (split CP/CNP/AMEX), and `netMarginRate` is what
  // `belowMarginFloor` actually refuses a quote against. It does NOT agree
  // with the ARR/commission-basis figures below — see the module comment on
  // `wholesale.ts` and `processingArr.ts` for the size of the gap on real
  // data (0.109% vs 0.799% margin on one live row). Don't reconcile them.
  aioRevenue: number | null;
  processorCostRate: number | null;
  netMarginRate: number | null;
  trueMarginFloor: number | null;
  // ── ARR / COMMISSION BASIS (wholesale.ts / processingArr.ts) ─────────────
  // What actually drives `payment_processing_arr` and therefore commission —
  // ONE blended CP rate and flat per-transaction fee against the product
  // owner's 10/13 ticket-indexed wholesale table, NOT interchange. See
  // `wholesale.ts`'s module comment for why this is deliberately a different
  // number from the floor-enforcement basis above.
  /** (CP Rate × Monthly Volume) + ((Monthly Volume ÷ Avg Ticket) × Txn Fee). Null when implausibleRate is set, or when there's no ARR basis at all (marketing-only, no volume/ticket). */
  totalRevenue: number | null;
  /** totalRevenue ÷ Monthly Volume, as a fraction. Same null rules as totalRevenue. */
  totalTakeRate: number | null;
  /** totalTakeRate − the wholesale % for this avgTicket (wholesale.ts's `wholesalePctFor`). Can be negative. Same null rules as totalRevenue — this is NOT `netMarginRate` above. */
  wholesaleMargin: number | null;
  /**
   * The offending stored rate when a quote's card rate exceeds
   * `MAX_PLAUSIBLE_CARD_RATE` — set instead of `totalRevenue`/
   * `totalTakeRate`/`wholesaleMargin`/`processingArr`, which are all null in
   * that case so the panel never shows the inflated numbers the check exists
   * to catch. A real row in production data stores 200.49% here.
   */
  implausibleRate: number | null;
  processingArr: number | null;
  /**
   * ESTIMATE — `estimatedRecurringArrFromQuoteLines` (lib/commission.ts), not
   * a live HubSpot read. This panel lists every deal in one query, so it
   * can't afford a GET per row; proven to diverge from HubSpot's real
   * `saas_revenue` (see that function's doc comment). `totalArr` and the two
   * commission figures below inherit the same caveat — this whole row is a
   * preview of what the writeback WOULD compute if it ran off estimates,
   * which it deliberately does not (see commissionWriteback.ts).
   */
  recurringArr: number | null;
  totalArr: number | null;
  signingCommission: number | null;
  activationCommission: number | null;
  /**
   * Sum of this deal's one-time lines' rep/rsm hardware commission
   * (lib/commission.ts, `quoteHardwareCommission`) — real per-product math,
   * not an estimate. null means "no one-time line on this deal has BOTH a
   * cost and a rate on file", which is distinct from a real 0 (every
   * qualifying line's margin happened to net to exactly zero, or summed to
   * it). Null is still the right answer for a quote whose every line is
   * comped or unpriced — see `buildCommissionDataGaps` for which products
   * those are. Real figures started landing 2026-10-14, when HubSpot's
   * product library was populated.
   */
  repHardwareCommission: number | null;
  rsmHardwareCommission: number | null;
};

/**
 * One row, or null when this application has neither a pricing basis
 * (no statement, no rep-entered volume/ticket) nor any ARR to report — an
 * empty prospect with nothing priced yet, which would otherwise render as a
 * row of dashes nobody needs to see.
 */
export function commissionRowForApplication(
  app: MerchantApplication,
  activeTier: ProcessorTier | null,
  /** The saved margin table; omitted = MARGIN_REQS. Only feeds `trueMarginFloor`. */
  marginReqs?: readonly MarginReq[]
): DealCommissionRow | null {
  const analysis = app.analysis
    ?? (app.quoteConfig && app.quoteConfig.monthlyVolume > 0 && app.quoteConfig.avgTicket > 0
      ? analysisFromQuoteConfig(app.quoteConfig)
      : null);

  const arrBreakdown = paymentProcessingArrBreakdown(app);
  const processingArr = arrBreakdown.arr;
  const implausibleRate = arrBreakdown.implausibleRate;
  // `paymentProcessingArrBreakdown` still returns its (wrong) computed
  // takeRate/commissionMargin alongside `implausibleRate` — deliberately, per
  // its own doc comment, so a human reviewing the backfill script sees WHY a
  // rate got flagged. This report is not that reviewer; an admin glancing at
  // a table should see a dash and the flagged rate, never the inflated
  // number the check exists to catch. So every wholesale-basis figure here
  // is nulled together whenever `implausibleRate` is set.
  const totalTakeRate = implausibleRate == null ? arrBreakdown.takeRate : null;
  const wholesaleMargin = implausibleRate == null ? arrBreakdown.commissionMargin : null;
  // Total Revenue isn't on the breakdown itself (only the rate it implies) —
  // back it out from takeRate × monthlyVolume rather than re-deriving a
  // second copy of wholesale.ts's `totalRevenue` from raw inputs.
  const totalRevenue = totalTakeRate != null && arrBreakdown.monthlyVolume != null
    ? totalTakeRate * arrBreakdown.monthlyVolume
    : null;
  const recurringArr = app.quoteLines && app.quoteLines.length > 0 ? estimatedRecurringArrFromQuoteLines(app.quoteLines) : null;
  const totalArr = sumArrOrNull(processingArr, recurringArr);
  const commission = commissionFromTotalArr(totalArr);

  const hw = quoteHardwareCommission(app.quoteLines ?? []);
  // `quoteHardwareCommission` sums with 0 as the identity (so a deal with one
  // qualifying line and one non-qualifying line still totals correctly) —
  // "qualifying" has to be read off `perLine`, not off the 0 total, or a deal
  // with no hardware data at all would show $0.00 indistinguishable from a
  // deal whose hardware genuinely nets to nothing.
  const hwRepQualifies = hw.perLine.some(l => l.rep !== null);
  const hwRsmQualifies = hw.perLine.some(l => l.rsm !== null);

  // A pure-hardware deal with no processing basis and no recurring line still
  // has something to report once hardware commission data exists.
  if (!analysis && totalArr === null && !hwRepQualifies && !hwRsmQualifies) return null;

  let aioRevenue: number | null = null;
  let processorCostRate: number | null = null;
  let netMarginRate: number | null = null;
  let trueMarginFloor: number | null = null;
  if (analysis) {
    const pricing = derivePricingForRole(
      analysis, app.quoteRates, app.pricingModel || "2-tier", ZERO_FEES,
      "admin", activeTier, NO_PADDING, null, marginReqs
    );
    aioRevenue = pricing.aioRevenue;
    processorCostRate = pricing.adyenCostRate;
    netMarginRate = pricing.adyenCostRate != null ? pricing.appliedTargetMargin - pricing.adyenCostRate : null;
    trueMarginFloor = pricing.marginFloor;
  }

  return {
    applicationId: app.id,
    merchantName: app.business?.dba?.trim() || app.business?.legalName?.trim() || app.analysis?.merchantName?.trim() || null,
    stage: app.stage,
    quoteAcceptedAt: app.quoteAcceptedAt ?? null,
    aioRevenue, processorCostRate, netMarginRate, trueMarginFloor,
    totalRevenue, totalTakeRate, wholesaleMargin, implausibleRate,
    processingArr, recurringArr, totalArr,
    signingCommission: commission.signingCommission,
    activationCommission: commission.activationCommission,
    repHardwareCommission: hwRepQualifies ? hw.rep : null,
    rsmHardwareCommission: hwRsmQualifies ? hw.rsm : null,
  };
}

/** Every application that has something to report, biggest total ARR first (nulls last). */
export function buildCommissionReport(
  apps: MerchantApplication[],
  activeTier: ProcessorTier | null,
  marginReqs?: readonly MarginReq[]
): DealCommissionRow[] {
  return apps
    .map(a => commissionRowForApplication(a, activeTier, marginReqs))
    .filter((r): r is DealCommissionRow => r !== null)
    .sort((a, b) => (b.totalArr ?? -1) - (a.totalArr ?? -1));
}

// ── Hardware commission data-quality gaps ───────────────────────────────────
//
// Tells the admin WHICH products are missing what, instead of the panel just
// reading as "this deal earns $0 hardware commission" with no explanation.
// Scans every app's quote lines directly — deliberately NOT limited to the
// apps that produced a row above, since a prospect with no pricing basis yet
// can still carry quote lines worth flagging.
//
// Smaller and more pointed since the real data landed (2026-10-14): what it
// finds now is a genuinely unpriced product — POS Unit, Customer Facing
// Display, mPOS and the two tablets have no "Cost to Rep" while most of the
// catalog does — rather than the whole catalog at once.

export type CommissionDataGaps = {
  /** One-time line names (deduped) with no cost on file at all — these
   * contribute nothing to any commission total; the product needs a
   * "Cost to Rep" filled in before it can ever pay one. */
  missingCost: string[];
  /** One-time line names (deduped) costed at a literal $0 — honoured as a
   * real zero by the formula (margin = full sale price), not treated as
   * missing. As of 2026-10-13 this is 8 network products, almost certainly
   * "nobody has entered a cost yet" rather than a true zero-cost product. */
  zeroCost: string[];
  /** Recurring line names (deduped) that nonetheless carry a rep/rsm
   * commission rate. Excluded from every total by design — hardware
   * commission is one-time-dollars only — and worth a product-owner look,
   * since a rate on a recurring product is more likely a mistake than an
   * intentional "sell the subscription itself for commission" setup. */
  recurringWithRate: string[];
};

export function buildCommissionDataGaps(apps: MerchantApplication[]): CommissionDataGaps {
  const missingCost = new Set<string>();
  const zeroCost = new Set<string>();
  const recurringWithRate = new Set<string>();

  for (const app of apps) {
    for (const line of app.quoteLines ?? []) {
      if (line.billingFrequency !== "one_time") {
        if (line.repCommissionBps != null || line.rsmCommissionBps != null) recurringWithRate.add(line.name);
        continue;
      }
      // Hardware AIO comps by policy earns nothing whatever its cost says
      // (see `isPolicyComped`), so neither list reports one: an admin sent to
      // fill in a cost there would change no figure on any quote. Same rule
      // `quoteHardwareCommission.missingCost` follows, so the admin panel and
      // the AE's own view of a quote can't disagree about what's missing.
      if (isPolicyComped(line)) continue;
      // Nor a line that was never a sale — the rate disclosure and the
      // pre-auth will never carry a cost and nobody should be sent to give
      // them one. Same rule, same reason. See `isNotCommissionable`.
      if (isNotCommissionable(line)) continue;
      if (line.costToRep == null) missingCost.add(line.name);
      else if (line.costToRep === 0) zeroCost.add(line.name);
    }
  }

  return {
    missingCost: [...missingCost].sort(),
    zeroCost: [...zeroCost].sort(),
    recurringWithRate: [...recurringWithRate].sort(),
  };
}
