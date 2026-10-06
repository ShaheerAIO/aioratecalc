import { describe, it, expect } from "vitest";
import { analysisFromQuoteConfig, derivePricing, getDesiredMargin, ratesFor, type FeeOverrides } from "@/lib/pricing";
import { DEFAULT_QUOTE_RATES, type QuoteRates, type StatementAnalysis } from "@/types/merchant";

// Rates became the pricing INPUT on 2026-10-06, inverting what this engine
// did: AIO used to decide the margin it needed and work the rates back from
// interchange, and now the rep quotes a rate and whatever margin it leaves is
// whatever it leaves. These are the tests for that direction.

const NO_FEES: FeeOverrides = { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 };

// $100k on 2,500 transactions ($40 average ticket), split 90/10, with
// interchange itemized at 1.80% so it is read rather than estimated.
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

const price = (rates: QuoteRates | null, fees: FeeOverrides = NO_FEES) =>
  derivePricing(ANALYSIS, rates, "2-tier", fees);

describe("the standard rate", () => {
  it("is 2.49% on all FOUR lanes plus $0.15", () => {
    // The flat rate every merchant is quoted until the ticket x volume matrix
    // exists. Card-not-present deliberately equals card-present, and AMEX
    // equals both — none of which is what the industry does or what HubSpot's
    // own rate-card text says. Product-owner decision, 2026-10-06.
    expect(DEFAULT_QUOTE_RATES).toEqual({
      cardPresentRate: 0.0249,
      cardNotPresentRate: 0.0249,
      amexCardPresentRate: 0.0249,
      amexCardNotPresentRate: 0.0249,
      perTransactionFee: 0.15,
    });
  });

  it("is what a quote with no rates on it prices at", () => {
    expect(ratesFor(null)).toEqual(DEFAULT_QUOTE_RATES);
    expect(ratesFor(undefined)).toEqual(DEFAULT_QUOTE_RATES);
    expect(price(null).projectedMonthlyFees).toBe(price(DEFAULT_QUOTE_RATES).projectedMonthlyFees);
  });
});

describe("derivePricing — 2-tier prices off the quoted rates", () => {
  it("quotes back exactly the rates it was given", () => {
    const rates = { cardPresentRate: 0.0275, cardNotPresentRate: 0.031, amexCardPresentRate: 0.0275, amexCardNotPresentRate: 0.031, perTransactionFee: 0.1 };
    const p = price(rates);
    expect(p.cpRate).toBe(0.0275);
    expect(p.cnpRate).toBe(0.031);
    expect(p.perTxnFee).toBe(0.1);
  });

  it("does NOT move the rate with interchange, which is what it used to do", () => {
    // The old engine returned interchange + margin, so a merchant whose
    // statement itemized higher interchange was quoted a higher rate. The rate
    // the rep typed is now the rate the merchant gets, whatever their mix.
    const dearIc = { ...ANALYSIS, interchangeRate: 0.025 } as StatementAnalysis;
    expect(derivePricing(dearIc, DEFAULT_QUOTE_RATES, "2-tier", NO_FEES).cpRate).toBe(0.0249);
    expect(price(DEFAULT_QUOTE_RATES).cpRate).toBe(0.0249);
  });

  it("charges the per-transaction fee on top, never folded into the rate", () => {
    // Steve 2026-07-23. A merchant checking their statement has to find 2.49%
    // and $0.15 as two separate charges.
    const p = price(DEFAULT_QUOTE_RATES);
    expect(p.projectedMonthlyFees).toBeCloseTo(100_000 * 0.0249 + 2_500 * 0.15, 6);
    expect(p.cpRate).toBe(0.0249); // unchanged by the fee
  });

  it("applies one per-transaction fee across both lanes", () => {
    // The two per-lane fee overrides went with the margin input. A merchant is
    // quoted "+ $0.15", not a card-present fee and a card-not-present fee.
    const withLaneFees = price(DEFAULT_QUOTE_RATES, { ...NO_FEES, cpPerTxnFee: 9, cnpPerTxnFee: 9 });
    expect(withLaneFees.projectedMonthlyFees).toBeCloseTo(price(DEFAULT_QUOTE_RATES).projectedMonthlyFees, 6);
  });

  it("splits volume across the lanes when the rates differ", () => {
    const p = price({ cardPresentRate: 0.02, cardNotPresentRate: 0.04, amexCardPresentRate: 0.02, amexCardNotPresentRate: 0.04, perTransactionFee: 0 });
    expect(p.projectedMonthlyFees).toBeCloseTo(90_000 * 0.02 + 10_000 * 0.04, 6);
  });

  it("still adds a monthly fee when one is set", () => {
    const p = price(DEFAULT_QUOTE_RATES, { ...NO_FEES, monthlyFee: 25 });
    expect(p.projectedMonthlyFees).toBeCloseTo(100_000 * 0.0249 + 2_500 * 0.15 + 25, 6);
  });
});

describe("margin is now an OUTPUT", () => {
  it("reports what the quoted rate leaves over interchange", () => {
    // 2.49% quoted, 1.80% interchange, plus $375 of per-transaction fees on
    // $100k of volume = 0.69% + 0.375% = 1.065%.
    const p = price(DEFAULT_QUOTE_RATES);
    expect(p.appliedTargetMargin).toBeCloseTo((0.0249 - 0.018) + (2_500 * 0.15) / 100_000, 10);
    expect(p.aioRevenue).toBeCloseTo(p.appliedTargetMargin * 100_000, 6);
  });

  it("falls with the rate, where it used to be the thing that SET the rate", () => {
    const cheap = price({ cardPresentRate: 0.019, cardNotPresentRate: 0.019, amexCardPresentRate: 0.019, amexCardNotPresentRate: 0.019, perTransactionFee: 0 });
    const dear  = price({ cardPresentRate: 0.030, cardNotPresentRate: 0.030, amexCardPresentRate: 0.030, amexCardNotPresentRate: 0.030, perTransactionFee: 0 });
    expect(cheap.appliedTargetMargin).toBeLessThan(dear.appliedTargetMargin);
    expect(cheap.appliedTargetMargin).toBeCloseTo(0.019 - 0.018, 10);
  });

  it("goes NEGATIVE on a below-cost rate rather than refusing it", () => {
    // Nothing clamps this and nothing refuses the save — floor enforcement was
    // removed with the margin input. The number is what the rep's collapsed
    // internal panel warns off.
    const p = price({ cardPresentRate: 0.005, cardNotPresentRate: 0.005, amexCardPresentRate: 0.005, amexCardNotPresentRate: 0.005, perTransactionFee: 0 });
    expect(p.appliedTargetMargin).toBeLessThan(0);
  });
});

describe("the two unsellable models still price off the margin matrix", () => {
  it("leaves flat-rate and interchange-plus on the volume tier's desired margin", () => {
    // Neither is sellable (SELECTABLE_PRICING_MODELS) and neither has a rate
    // input — they keep doing exactly what they did when no target was passed.
    const desired = getDesiredMargin(100_000);
    const flat = derivePricing(ANALYSIS, DEFAULT_QUOTE_RATES, "flat-rate", NO_FEES);
    const icp  = derivePricing(ANALYSIS, DEFAULT_QUOTE_RATES, "interchange-plus", NO_FEES);

    expect(flat.appliedTargetMargin).toBe(desired);
    expect(icp.appliedTargetMargin).toBe(desired);
    expect(flat.flatRate).toBeCloseTo(0.018 + desired, 10);
    expect(icp.bps).toBe(Math.round(desired * 10000));
  });

  it("ignores the quoted rates on those models — there is nowhere to put them", () => {
    const a = derivePricing(ANALYSIS, DEFAULT_QUOTE_RATES, "flat-rate", NO_FEES);
    const b = derivePricing(
      ANALYSIS,
      { cardPresentRate: 0.09, cardNotPresentRate: 0.09, amexCardPresentRate: 0.09, amexCardNotPresentRate: 0.09, perTransactionFee: 5 },
      "flat-rate",
      NO_FEES
    );
    expect(a.projectedMonthlyFees).toBe(b.projectedMonthlyFees);
  });
});

// AMEX settles at its own cost, so it is priced apart from Visa/Mastercard/
// Discover — four rates across two brand groups and two lanes. They all
// default to the same number, which is exactly why these tests set them apart:
// equal rates hide every bug in the split.
describe("AMEX is priced apart from Visa/Mastercard/Discover", () => {
  const SPLIT: QuoteRates = {
    cardPresentRate: 0.02,
    cardNotPresentRate: 0.03,
    amexCardPresentRate: 0.04,
    amexCardNotPresentRate: 0.05,
    perTransactionFee: 0,
  };

  // $100k, 90/10 card-present, of which $20k is AMEX.
  const WITH_AMEX = { ...ANALYSIS, amexVolume: 20_000 } as StatementAnalysis;

  it("splits volume four ways: two brand groups × two lanes", () => {
    // AMEX is assumed to split CP/CNP in the merchant's overall ratio, the
    // only cross-tab a statement gives us. So: AMEX 18k CP + 2k CNP, and
    // V/MD takes the remainder, 72k CP + 8k CNP.
    const p = derivePricing(WITH_AMEX, SPLIT, "2-tier", NO_FEES);
    expect(p.amexVol).toBe(20_000);
    expect(p.projectedMonthlyFees).toBeCloseTo(
      72_000 * 0.02 + 8_000 * 0.03 + 18_000 * 0.04 + 2_000 * 0.05, 6
    );
  });

  it("quotes all four rates back", () => {
    const p = derivePricing(WITH_AMEX, SPLIT, "2-tier", NO_FEES);
    expect([p.cpRate, p.cnpRate, p.amexCpRate, p.amexCnpRate]).toEqual([0.02, 0.03, 0.04, 0.05]);
  });

  it("charges the AMEX rate on AMEX volume, not the V/MD rate", () => {
    const dearAmex = derivePricing(WITH_AMEX, SPLIT, "2-tier", NO_FEES);
    const flat = derivePricing(
      WITH_AMEX,
      { ...SPLIT, amexCardPresentRate: 0.02, amexCardNotPresentRate: 0.03 },
      "2-tier", NO_FEES
    );
    expect(dearAmex.projectedMonthlyFees).toBeGreaterThan(flat.projectedMonthlyFees);
  });

  it("prices every dollar at the V/MD rates when the statement shows no AMEX", () => {
    const p = derivePricing(ANALYSIS, SPLIT, "2-tier", NO_FEES);
    expect(p.amexVol).toBe(0);
    expect(p.projectedMonthlyFees).toBeCloseTo(90_000 * 0.02 + 10_000 * 0.03, 6);
  });

  it("invents no AMEX share on a statement-less quote", () => {
    // Product-owner decision, 2026-10-06: the config path has no AMEX figure
    // and none is assumed. The AMEX rates still appear on the quote; they just
    // don't move the projection, because quoting a saving off a number nobody
    // supplied is worse than quoting none.
    const config = analysisFromQuoteConfig({ avgTicket: 40, monthlyVolume: 100_000 });
    expect(config.amexVolume).toBe(0);

    const p = derivePricing(config, SPLIT, "2-tier", NO_FEES);
    expect(p.amexVol).toBe(0);
    expect(p.projectedMonthlyFees).toBeCloseTo(90_000 * 0.02 + 10_000 * 0.03, 6);
  });

  it("never lets a bad AMEX figure exceed the merchant's own volume", () => {
    // Read off a statement by an LLM, so it can be nonsense. Clamped rather
    // than trusted: an AMEX total above total volume would drive the V/MD
    // lanes negative and quote a merchant less than nothing.
    const p = derivePricing({ ...ANALYSIS, amexVolume: 500_000 } as StatementAnalysis, SPLIT, "2-tier", NO_FEES);
    expect(p.amexVol).toBe(100_000);
    expect(p.projectedMonthlyFees).toBeCloseTo(90_000 * 0.04 + 10_000 * 0.05, 6);
    expect(p.projectedMonthlyFees).toBeGreaterThan(0);
  });
});
