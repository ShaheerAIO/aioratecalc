import { describe, it, expect } from "vitest";
import { analysisFromQuoteConfig, CONFIG_QUOTE_ASSUMPTIONS, derivePricing, getDesiredMargin, ratesFor, type FeeOverrides } from "@/lib/pricing";
import { DEFAULT_CARD_PRESENT_PCT, DEFAULT_QUOTE_RATES, type QuoteRates, type StatementAnalysis } from "@/types/merchant";

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

// AMEX used to settle at its own cost and price apart from Visa/Mastercard/
// Discover (2026-10-06). REVERSED 2026-10-13 ("get rid of the dual rate
// (amex)") — product owner decided the four-box split wasn't worth a rep
// reading past, so AMEX volume now prices at whatever the ordinary rate
// quotes, same as every other card. `QuoteRates.amexCardPresentRate`/
// `amexCardNotPresentRate` still exist (a row saved 2026-10-06 through
// 2026-10-12 can carry real, divergent numbers in them and has to keep
// parsing), so these tests now assert that derivePricing IGNORES them for
// pricing purposes — the opposite of what they asserted before.
describe("AMEX prices at the ordinary rate, not apart from it", () => {
  // Rates where AMEX genuinely still differs — exactly the shape a
  // pre-2026-10-13 row can carry. If derivePricing ever reads these again,
  // these tests catch it.
  const SPLIT: QuoteRates = {
    cardPresentRate: 0.02,
    cardNotPresentRate: 0.03,
    amexCardPresentRate: 0.04,
    amexCardNotPresentRate: 0.05,
    perTransactionFee: 0,
  };

  // $100k, 90/10 card-present, of which $20k is AMEX.
  const WITH_AMEX = { ...ANALYSIS, amexVolume: 20_000 } as StatementAnalysis;

  it("prices AMEX volume at the ordinary CP/CNP rates, ignoring the stored AMEX rates", () => {
    // Old behavior carved AMEX out and charged it 0.04/0.05. Now the whole
    // 90k/10k CP/CNP split prices at 0.02/0.03 regardless of how much of it
    // the statement attributes to AMEX.
    const p = derivePricing(WITH_AMEX, SPLIT, "2-tier", NO_FEES);
    expect(p.projectedMonthlyFees).toBeCloseTo(90_000 * 0.02 + 10_000 * 0.03, 6);
  });

  it("reports amexVol but no longer uses it to carve anything out of cpVol/cnpVol", () => {
    const withAmex = derivePricing(WITH_AMEX, SPLIT, "2-tier", NO_FEES);
    const withoutAmex = derivePricing(ANALYSIS, SPLIT, "2-tier", NO_FEES);
    expect(withAmex.amexVol).toBe(20_000);
    expect(withoutAmex.amexVol).toBe(0);
    // Same cpVol/cnpVol, same fees, whether or not the statement reports an
    // AMEX figure — amexVol is reporting-only now.
    expect(withAmex.cpVol).toBe(withoutAmex.cpVol);
    expect(withAmex.cnpVol).toBe(withoutAmex.cnpVol);
    expect(withAmex.projectedMonthlyFees).toBeCloseTo(withoutAmex.projectedMonthlyFees, 6);
  });

  it("mirrors amexCpRate/amexCnpRate onto the ordinary rates rather than quoting the stored AMEX ones back", () => {
    // SPLIT asks for 0.04/0.05 on AMEX; the engine no longer has anywhere to
    // put that, so it reports the same two rates everyone else gets.
    const p = derivePricing(WITH_AMEX, SPLIT, "2-tier", NO_FEES);
    expect([p.cpRate, p.cnpRate]).toEqual([0.02, 0.03]);
    expect([p.amexCpRate, p.amexCnpRate]).toEqual([p.cpRate, p.cnpRate]);
  });

  it("never lets a bad AMEX figure do anything — not even clamp pricing — since it isn't priced", () => {
    // Read off a statement by an LLM, so it can be nonsense (e.g. AMEX volume
    // above total volume). It used to need clamping because it was subtracted
    // from cpVol/cnpVol; now it's purely reported, so an absurd figure can't
    // drive anything negative.
    const p = derivePricing({ ...ANALYSIS, amexVolume: 500_000 } as StatementAnalysis, SPLIT, "2-tier", NO_FEES);
    expect(p.amexVol).toBe(100_000); // still clamped to total volume for display
    expect(p.projectedMonthlyFees).toBeCloseTo(90_000 * 0.02 + 10_000 * 0.03, 6);
  });

  it("invents no AMEX share on a statement-less quote (unchanged reasoning, now moot for pricing)", () => {
    // Product-owner decision, 2026-10-06, still true: the config path has no
    // AMEX figure and none is assumed. It no longer matters for pricing
    // either way — see the tests above — but amexVol still reports 0 here.
    const config = analysisFromQuoteConfig({ avgTicket: 40, monthlyVolume: 100_000 });
    expect(config.amexVolume).toBe(0);

    const p = derivePricing(config, SPLIT, "2-tier", NO_FEES);
    expect(p.amexVol).toBe(0);
    // 95/5 statement-less default (DEFAULT_CARD_PRESENT_PCT), not the 90/10
    // explicit split ANALYSIS/SPLIT above use.
    expect(p.projectedMonthlyFees).toBeCloseTo(95_000 * 0.02 + 5_000 * 0.03, 6);
  });
});

// The 2026-10-07 defect: the rep form defaulted its card-present field to 95
// (commit 453c588) while pricing.ts and PricingStep.tsx kept quoting 90 —
// three copies of the same assumption that had drifted apart. Fixed by
// collapsing all of them onto DEFAULT_CARD_PRESENT_PCT (types/merchant.ts,
// where client components can read it without pulling in pricing.ts's
// MARGIN_REQS). These tests are the regression guard against a future caller
// reintroducing its own 0.9 (or any other) literal instead of importing it.
describe("DEFAULT_CARD_PRESENT_PCT — one constant, not three", () => {
  it("is 95%, the 2026-10-07 value, not Steve's original 90%", () => {
    expect(DEFAULT_CARD_PRESENT_PCT).toBe(0.95);
  });

  it("CONFIG_QUOTE_ASSUMPTIONS (pricing.ts) is derived from it, not a second literal", () => {
    expect(CONFIG_QUOTE_ASSUMPTIONS.cardPresentPct).toBe(DEFAULT_CARD_PRESENT_PCT);
    expect(CONFIG_QUOTE_ASSUMPTIONS.cardNotPresentPct).toBeCloseTo(1 - DEFAULT_CARD_PRESENT_PCT, 10);
  });

  it("derivePricing's own fallback (a statement with neither lane) uses the same constant", () => {
    // Distinct from analysisFromQuoteConfig's path (covered above, "invents no
    // AMEX share…") — this exercises derivePricing's OWN rawCp/rawCnp === 0
    // fallback directly, which a config-built analysis never reaches because
    // analysisFromQuoteConfig already fills in a concrete cardPresentPct.
    const noCardMixInfo = {
      totalVolume: 100_000, totalTransactions: 2_500,
      interchangeRate: 0.018, icEstimated: false,
      // cardPresentPct/cardNotPresentPct omitted entirely — "unmeasured".
    } as StatementAnalysis;

    const p = derivePricing(noCardMixInfo, DEFAULT_QUOTE_RATES, "2-tier", NO_FEES);
    expect(p.cpVol).toBeCloseTo(100_000 * DEFAULT_CARD_PRESENT_PCT, 6);
    expect(p.cnpVol).toBeCloseTo(100_000 * (1 - DEFAULT_CARD_PRESENT_PCT), 6);
  });
});
