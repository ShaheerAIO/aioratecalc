import { describe, it, expect } from "vitest";
import {
  analysisFromQuoteConfig, derivePricingForRole, monthlyRevenueFloorBlockers, type PaddingConfig,
} from "@/lib/pricing";
import {
  DEFAULT_QUOTE_RATES, MIN_MONTHLY_PROCESSING_REVENUE,
  type QuoteRates, type StatementAnalysis,
} from "@/types/merchant";

// The $10-a-month minimum on AIO's OWN processing revenue (product owner,
// 2026-10-15: "dont allow the montly revenue to be less than 10 dollars" /
// "dont allow rep to change CP rate to make monthly rev less than 10$").
//
// Measured on wholesale.ts's commission margin — the same margin
// `payment_processing_arr` is built from — so the figure a rep is held to is
// the figure their quote reports. Independent of `belowMarginFloor`, which is
// a rate test against a padded, undisclosed table.

const NO_FEES = { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 };
const NO_PADDING: PaddingConfig = { paddingPct: 0, paddingMinMrrAdd: 0, paddingAdyenCostHide: false };

/** A merchant at `volume` a month on a $40 average ticket — the 2.08% wholesale column. */
const at = (volume: number) => ({
  totalVolume: volume,
  totalTransactions: volume / 40,
  interchangeRate: 0.018,
  icEstimated: false,
  cardPresentPct: 0.9,
  cardNotPresentPct: 0.1,
  cardPresentVolume: volume * 0.9,
  cardNotPresentVolume: volume * 0.1,
} as StatementAnalysis);

const cp = (rate: number): QuoteRates => ({ ...DEFAULT_QUOTE_RATES, cardPresentRate: rate });

const preview = (analysis: StatementAnalysis, rates: QuoteRates = DEFAULT_QUOTE_RATES) =>
  derivePricingForRole(analysis, rates, "2-tier", NO_FEES, "rep", null, NO_PADDING);

describe("the $10 monthly processing-revenue floor", () => {
  it("reports both horizons off one computation, so they can't disagree", () => {
    // $100k at 2.49% + $0.15 on a $40 ticket: 2.865% take rate, 2.08%
    // wholesale, 0.785% margin -> $785 a month.
    const p = preview(at(100_000));
    expect(p.monthlyProcessingRevenue).toBeCloseTo(785, 6);
    expect(p.processingArr).toBe(9_420);
    expect(p.belowMonthlyRevenueFloor).toBe(false);
    expect(monthlyRevenueFloorBlockers(p)).toEqual([]);
  });

  it("refuses a merchant too small to clear $10 at the quoted rate", () => {
    // The same margin on $1,000 a month is $7.85.
    const p = preview(at(1_000));
    expect(p.monthlyProcessingRevenue).toBeCloseTo(7.85, 6);
    expect(p.belowMonthlyRevenueFloor).toBe(true);

    const [msg] = monthlyRevenueFloorBlockers(p);
    // Unlike the margin floor, this refusal names both sides — the figure is
    // shown to the rep live, so withholding it from the message would be
    // withholding it from nobody.
    expect(msg).toContain("$7.85");
    expect(msg).toContain("$10.00");
    expect(msg).toMatch(/too small to process for/);
  });

  // The other half of the same ask: the CP rate is the only input a rep
  // moves, so refusing the quote IS refusing the rate.
  it("clears once the rep raises the card-present rate far enough", () => {
    expect(preview(at(1_000), cp(0.0249)).belowMonthlyRevenueFloor).toBe(true);
    const raised = preview(at(1_000), cp(0.0275));
    expect(raised.monthlyProcessingRevenue!).toBeGreaterThanOrEqual(MIN_MONTHLY_PROCESSING_REVENUE);
    expect(raised.belowMonthlyRevenueFloor).toBe(false);
  });

  // A thin or negative margin is what the floor exists to catch. Reporting
  // null there would read as "no basis to judge", which is the one answer
  // that lets it through.
  it("refuses a NEGATIVE margin rather than reporting no figure at all", () => {
    const p = preview(at(100_000), cp(0.005));
    expect(p.monthlyProcessingRevenue!).toBeLessThan(0);
    expect(p.belowMonthlyRevenueFloor).toBe(true);
    // The commission still drops a non-positive forecast — a commission on
    // negative revenue is nonsense, where the refusal above is the point.
    expect(p.projectedCommission.total).toBeNull();
  });

  // Both halves of what a rep spotted on 2026-10-15: $299.99 printed beside
  // $3,600.00, which neither multiplies nor matches the margin the typed
  // figures imply.
  describe("the figures a rep reads off a quote with no statement behind it", () => {
    // $100,002 at a $25 ticket, quoted 2.06% + $0.15. Take rate 2.66%,
    // wholesale 2.36% at that ticket, so the margin is exactly 0.30%.
    const config = analysisFromQuoteConfig({ monthlyVolume: 100_002, avgTicket: 25 });
    const p = preview(config, cp(0.0206));

    it("reads the ticket the rep TYPED, not one divided back out of a rounded count", () => {
      // analysisFromQuoteConfig rounds 4000.08 transactions to 4000; dividing
      // back out gives a $25.0005 ticket, which moved the margin enough to
      // print $299.99 instead of $300.01.
      expect(config.totalTransactions).toBe(4_000);
      expect(config.totalVolume / config.totalTransactions).not.toBe(25);
      expect(p.monthlyProcessingRevenue).toBe(300.01);
    });

    it("annualises the figure it PRINTS, so the two multiply", () => {
      expect(p.processingArr).toBe(3_600.12);
      expect(p.processingArr).toBe(p.monthlyProcessingRevenue! * 12);
    });
  });

  it("holds reps and admins to the identical figure — this one is not padded", () => {
    const rep = preview(at(100_000));
    const admin = derivePricingForRole(at(100_000), DEFAULT_QUOTE_RATES, "2-tier", NO_FEES, "admin", null, NO_PADDING);
    expect(admin.monthlyProcessingRevenue).toBe(rep.monthlyProcessingRevenue);
    expect(admin.belowMonthlyRevenueFloor).toBe(rep.belowMonthlyRevenueFloor);
  });

  describe("says nothing when there is no basis to judge", () => {
    it("no volume", () => {
      const p = preview(at(0));
      expect(p.monthlyProcessingRevenue).toBeNull();
      expect(p.belowMonthlyRevenueFloor).toBe(false);
      expect(monthlyRevenueFloorBlockers(p)).toEqual([]);
    });

    it("no transactions, so no ticket to read the wholesale column from", () => {
      const p = preview({ ...at(100_000), totalTransactions: 0 });
      expect(p.monthlyProcessingRevenue).toBeNull();
      expect(p.belowMonthlyRevenueFloor).toBe(false);
    });

    // A rate past MAX_PLAUSIBLE_CARD_RATE is a decimal point in the wrong
    // place. Refusing it as "under $10" would name the wrong problem, and
    // reporting the revenue would annualise a typo.
    it("an implausible quoted rate", () => {
      const p = preview(at(100_000), cp(0.2));
      expect(p.monthlyProcessingRevenue).toBeNull();
      expect(p.belowMonthlyRevenueFloor).toBe(false);
    });
  });
});
