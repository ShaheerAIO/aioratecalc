import { describe, it, expect, vi, afterEach } from "vitest";
import { derivePricingForRole, type PaddingConfig } from "@/lib/pricing";
import { DEFAULT_QUOTE_RATES, MAX_PLAUSIBLE_CARD_RATE, type StatementAnalysis } from "@/types/merchant";

// `projectedCommission` — the live preview a rep sees in PricingStep.tsx /
// EditQuotePanel.tsx (2026-10-13): "the only thing to display... is the
// margin, cuz thats how reps see their commission". Built off wholesale.ts's
// commission margin directly (no MerchantApplication exists yet at preview
// time for paymentProcessingArrBreakdown to take), same formula
// lib/billing/processingArr.ts uses.

const NO_FEES = { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 };
const NO_PADDING: PaddingConfig = { paddingAdyenCostHide: false };

// $100k/mo on 2,500 transactions -> a $40 average ticket.
const ANALYSIS = {
  totalVolume: 100_000,
  totalTransactions: 2_500,
  interchangeRate: 0.018,
  icEstimated: false,
  cardPresentPct: 0.9,
  cardNotPresentPct: 0.1,
  cardPresentVolume: 90_000,
  cardNotPresentVolume: 10_000,
} as StatementAnalysis;

const preview = (recurringArr: number | null = null, role: "admin" | "rep" = "rep") =>
  derivePricingForRole(ANALYSIS, DEFAULT_QUOTE_RATES, "2-tier", NO_FEES, role, null, NO_PADDING, recurringArr);

describe("projectedCommission", () => {
  it("is present with a real commission basis", () => {
    const p = preview();
    expect(p.projectedCommission.totalArr).toBeGreaterThan(0);
    expect(p.projectedCommission.signingCommission).toBeGreaterThan(0);
    expect(p.projectedCommission.activationCommission).toBe(p.projectedCommission.signingCommission);
    expect(p.projectedCommission.total).toBe(p.projectedCommission.signingCommission! + p.projectedCommission.activationCommission!);
  });

  it("is identical for rep and admin — this margin is not a secret from reps", () => {
    const rep = preview();
    const admin = preview(null, "admin");
    expect(rep.projectedCommission).toEqual(admin.projectedCommission);
  });

  it("is null with no volume or no transactions to derive a ticket from", () => {
    const noVol = derivePricingForRole(
      { ...ANALYSIS, totalVolume: 0 }, DEFAULT_QUOTE_RATES, "2-tier", NO_FEES, "rep", null, NO_PADDING
    );
    expect(noVol.projectedCommission.total).toBeNull();

    const noTxns = derivePricingForRole(
      { ...ANALYSIS, totalTransactions: 0 }, DEFAULT_QUOTE_RATES, "2-tier", NO_FEES, "rep", null, NO_PADDING
    );
    expect(noTxns.projectedCommission.total).toBeNull();
  });

  it("folds in recurringArr (the platform fee) when the caller knows it", () => {
    const withoutProducts = preview(null);
    const withPlatformFee = preview(4_788); // $399/mo platform fee, annualised
    expect(withPlatformFee.projectedCommission.totalArr!).toBeCloseTo(
      withoutProducts.projectedCommission.totalArr! + 4_788, 0
    );
    expect(withPlatformFee.projectedCommission.total!).toBeGreaterThan(withoutProducts.projectedCommission.total!);
  });

  it("is null, not an annualised typo, when the quoted rate is implausible", () => {
    const bad = derivePricingForRole(
      ANALYSIS,
      { ...DEFAULT_QUOTE_RATES, cardPresentRate: MAX_PLAUSIBLE_CARD_RATE + 0.01 },
      "2-tier", NO_FEES, "rep", null, NO_PADDING
    );
    expect(bad.projectedCommission.total).toBeNull();
  });

  describe("no HubSpot read — this is a rep-facing ESTIMATE, computed entirely locally", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("computes the full preview, including projectedCommission, with no network access at all", () => {
      // The real writeback (lib/billing/commissionWriteback.ts) reads HubSpot's
      // actual saas_revenue before writing anything — but this rep-facing
      // preview must work standing alone, mid-keystroke, with nothing saved
      // yet. Stubbing fetch to throw proves derivePricingForRole never reaches
      // for the network to produce projectedCommission.
      vi.stubGlobal("fetch", vi.fn(() => { throw new Error("no network access should be needed here"); }));
      const p = preview(4_788);
      expect(p.projectedCommission.total).toBeGreaterThan(0);
    });
  });
});
