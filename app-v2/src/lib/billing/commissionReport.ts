// The ADMIN-ONLY per-deal commission breakdown (2026-10-13) — "the other
// stuff calculate it and store it in an admin only view somewhere" (product
// owner, on what used to be in PricingStep's/EditQuotePanel's AIO Internal
// panel). This is that somewhere: /admin, ?view=commissions.
//
// Pure given its inputs (apps, the active processor tier, the hardware
// commission policy) — no DB, no HubSpot, no env reads. The action that
// fetches those three things is `getCommissionReportAction`
// (lib/actions/commissions.ts); this file only shapes what it found.
//
// Deliberately reuses `derivePricingForRole(..., "admin", ...)` rather than
// calling `derivePricing`/`getMarginFloor` directly: "admin" is the role that
// already bypasses every pad (see pricing.ts), so this gets the TRUE
// aioRevenue/adyenCostRate/marginFloor for free, through the one function
// CLAUDE.md says every pricing read must go through — not a second, parallel
// path to the same true numbers.
//
// `recurringArr`/`totalArr`/the two commission figures on each row are built
// from `estimatedRecurringArrFromQuoteLines` — an ESTIMATE, not HubSpot's real
// `saas_revenue`. This panel lists every deal at once, so a live GET per row
// is off the table. The actual write to HubSpot (commissionWriteback.ts) does
// NOT use this report's numbers and does NOT share this estimate — it reads
// HubSpot's real saas_revenue at write time. Don't let this panel's figures
// be mistaken for "what will be written"; they're a preview built the only
// way a list view can be.

import { derivePricingForRole, analysisFromQuoteConfig, type PaddingConfig } from "@/lib/pricing";
import { paymentProcessingArrBreakdown } from "@/lib/billing/processingArr";
import {
  commissionFromTotalArr, estimatedRecurringArrFromQuoteLines, hardwareCommission, sumArrOrNull,
  type HardwareCommissionPolicy,
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
  // The true figures CLAUDE.md says a rep must never see — fine here, this
  // report is admin-only (enforced in the action, not this file).
  aioRevenue: number | null;
  processorCostRate: number | null;
  netMarginRate: number | null;
  trueMarginFloor: number | null;
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
  // Always 0 today — see lib/commission.ts's hardwareCommission doc comment
  // for the data gap (no hardware COST anywhere in this codebase). Carried as
  // a real field, not omitted, so the report and the quote-view row it will
  // eventually back (ProductConfigurator/QuoteReceipt) agree on its shape
  // once a rate and a cost source both exist.
  hardwareCommission: number;
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
  hardwarePolicy: HardwareCommissionPolicy
): DealCommissionRow | null {
  const analysis = app.analysis
    ?? (app.quoteConfig && app.quoteConfig.monthlyVolume > 0 && app.quoteConfig.avgTicket > 0
      ? analysisFromQuoteConfig(app.quoteConfig)
      : null);

  const processingArr = paymentProcessingArrBreakdown(app).arr;
  const recurringArr = app.quoteLines && app.quoteLines.length > 0 ? estimatedRecurringArrFromQuoteLines(app.quoteLines) : null;
  const totalArr = sumArrOrNull(processingArr, recurringArr);
  const commission = commissionFromTotalArr(totalArr);
  // Literal 0, not derived — see hardwareCommission's own doc comment. This is
  // the one call site that would supply a real margin if one ever existed.
  const hwCommission = hardwareCommission(0, hardwarePolicy);

  if (!analysis && totalArr === null) return null;

  let aioRevenue: number | null = null;
  let processorCostRate: number | null = null;
  let netMarginRate: number | null = null;
  let trueMarginFloor: number | null = null;
  if (analysis) {
    const pricing = derivePricingForRole(
      analysis, app.quoteRates, app.pricingModel || "2-tier", ZERO_FEES,
      "admin", activeTier, NO_PADDING
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
    processingArr, recurringArr, totalArr,
    signingCommission: commission.signingCommission,
    activationCommission: commission.activationCommission,
    hardwareCommission: hwCommission,
  };
}

/** Every application that has something to report, biggest total ARR first (nulls last). */
export function buildCommissionReport(
  apps: MerchantApplication[],
  activeTier: ProcessorTier | null,
  hardwarePolicy: HardwareCommissionPolicy
): DealCommissionRow[] {
  return apps
    .map(a => commissionRowForApplication(a, activeTier, hardwarePolicy))
    .filter((r): r is DealCommissionRow => r !== null)
    .sort((a, b) => (b.totalArr ?? -1) - (a.totalArr ?? -1));
}
