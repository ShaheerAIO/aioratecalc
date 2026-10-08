import { describe, it, expect } from "vitest";
import {
  CONFIG_QUOTE_ASSUMPTIONS,
  analysisFromQuoteConfig,
} from "@/lib/pricing";
import { DEFAULT_QUOTE_RATES } from "@/types/merchant";
import { buildCustomerSafeQuote, hasQuoteBasis } from "@/lib/leadQuote";
import type { CustomerSafeQuote, StatementAnalysis } from "@/types/merchant";

// Narrows away the products-basis variant. A marketing-only quote carries no
// rate fields at all (see CustomerSafeQuote), and every quote in this file is a
// rated one — so this doubles as the assertion that it built at all.
function rated(quote: CustomerSafeQuote | null) {
  if (!quote) throw new Error("expected a quote, got null");
  if (quote.basis === "products") throw new Error("expected a rated quote, got a products-only one");
  return quote;
}

// A statement-less quote is pure arithmetic on two rep-entered numbers, so the
// expectations below are hand-computed from Steve's constants rather than
// snapshotted off the implementation.
const CONFIG = { avgTicket: 40, monthlyVolume: 100_000 };
const { cardPresentPct: CP, cardNotPresentPct: CNP } = CONFIG_QUOTE_ASSUMPTIONS;

describe("analysisFromQuoteConfig", () => {
  it("derives transaction count from volume ÷ ticket", () => {
    expect(analysisFromQuoteConfig(CONFIG).totalTransactions).toBe(2500);
    expect(analysisFromQuoteConfig({ avgTicket: 37.5, monthlyVolume: 10_000 }).totalTransactions).toBe(267);
  });

  it("survives a zero ticket without dividing by zero", () => {
    const a = analysisFromQuoteConfig({ avgTicket: 0, monthlyVolume: 50_000 });
    expect(a.totalTransactions).toBe(0);
    expect(a.totalVolume).toBe(50_000);
  });

  it("splits volume on the 90/10 default and blends interchange from it", () => {
    const a = analysisFromQuoteConfig(CONFIG);
    expect(CP).toBe(0.9);
    expect(CNP).toBe(0.1);
    expect(a.cardPresentVolume).toBe(90_000);
    expect(a.cardNotPresentVolume).toBe(10_000);
    // 0.9 × 2.10% + 0.1 × 2.50% = 2.14%
    expect(a.interchangeRate).toBeCloseTo(0.0214, 10);
    expect(a.interchangeFees).toBeCloseTo(2140, 6);
  });

  it("marks interchange as estimated so derivePricing uses the per-lane estimate", () => {
    const a = analysisFromQuoteConfig(CONFIG);
    expect(a.icEstimated).toBe(true);
    expect(a.interchangeNotShown).toBe(true);
    expect(a.confidence).toBe("low");
  });

  it("claims nothing about what the merchant pays today", () => {
    const a = analysisFromQuoteConfig(CONFIG);
    expect(a.totalFees).toBe(0);
    expect(a.effectiveRate).toBe(0);
    expect(a.processorMarkup).toBe(0);
    expect(a.currentMargin).toBe(0);
    expect(a.currentProcessorName).toBe("");
  });
});

describe("buildCustomerSafeQuote — config basis", () => {
  const quote = rated(buildCustomerSafeQuote({
    analysis: null,
    quoteConfig: CONFIG,
    targetMargin: null,
    quoteRates: DEFAULT_QUOTE_RATES,
    pricingModel: "2-tier",
  }));

  it("prices each lane at the rate the rep quoted, not at a margin over interchange", () => {
    // Rates became the INPUT on 2026-10-06. Both lanes are quoted 2.49% and
    // every transaction carries $0.15 on top (Steve 2026-07-23: fees ride
    // alongside the rate, never folded into it):
    //   volume      100,000 × 2.49%        = $2,490
    //   2,500 txns (100,000 ÷ $40) × $0.15 =   $375
    const expectedMonthly = 100_000 * 0.0249 + 2_500 * 0.15;
    expect(expectedMonthly).toBeCloseTo(2865, 6);
    expect(quote.projectedMonthlyCost).toBeCloseTo(2865, 6);
    expect(quote.projectedAnnualCost).toBeCloseTo(34_380, 6);
    expect(quote.effectiveRate).toBeCloseTo(0.02865, 10);
  });

  it("splits the lanes when the two rates differ", () => {
    const split = rated(buildCustomerSafeQuote({
      analysis: null, quoteConfig: CONFIG, targetMargin: null, pricingModel: "2-tier",
      quoteRates: { cardPresentRate: 0.0249, cardNotPresentRate: 0.035, amexCardPresentRate: 0.0249, amexCardNotPresentRate: 0.035, perTransactionFee: 0.15 },
    }));
    // 90/10 split on $100k, the statement-less default.
    const expectedMonthly = 90_000 * 0.0249 + 10_000 * 0.035 + 2_500 * 0.15;
    expect(split.projectedMonthlyCost).toBeCloseTo(expectedMonthly, 6);
    expect(split.projectedMonthlyCost).toBeGreaterThan(quote.projectedMonthlyCost);
  });

  it("echoes the rep-entered basis back", () => {
    expect(quote.basis).toBe("config");
    expect(quote.monthlyVolume).toBe(100_000);
    expect(quote.averageTicket).toBe(40);
  });

  it("leaves every savings field null — there is no statement to compare against", () => {
    expect(quote.currentMonthlyCost).toBeNull();
    expect(quote.currentEffectiveRate).toBeNull();
    expect(quote.monthlySavings).toBeNull();
    expect(quote.annualSavings).toBeNull();
    expect(quote.savingsPct).toBeNull();
  });

  it("prices a row with NO rates at the standard rate, not at nothing", () => {
    // Every application written before 2026-10-06 has a null quoteRates. It
    // has to quote something, and the something is what a new quote would get.
    const legacy = rated(buildCustomerSafeQuote({
      analysis: null, quoteConfig: CONFIG, quoteRates: null, targetMargin: 0.008, pricingModel: "2-tier",
    }));
    expect(legacy.projectedMonthlyCost).toBeCloseTo(quote.projectedMonthlyCost, 6);
  });

  it("ignores the superseded margin target entirely", () => {
    // targetMargin is still read off the row (older rows carry one) but it no
    // longer prices anything — a wildly different one changes nothing.
    const withMargin = rated(buildCustomerSafeQuote({
      analysis: null, quoteConfig: CONFIG, targetMargin: 0.039,
      quoteRates: DEFAULT_QUOTE_RATES, pricingModel: "2-tier",
    }));
    expect(withMargin.projectedMonthlyCost).toBeCloseTo(quote.projectedMonthlyCost, 6);
  });

  it("exposes no cost, margin, floor or interchange field to the customer", () => {
    // The customer-safe boundary is the shape itself: anything internal would
    // have to appear as a key here to leak.
    expect(Object.keys(quote).sort()).toEqual([
      "annualSavings", "averageTicket", "basis", "currentEffectiveRate", "currentMonthlyCost",
      "effectiveRate", "lineTotals", "lines", "monthlySavings", "monthlyVolume", "orderPoints",
      "projectedAnnualCost", "projectedMonthlyCost", "savingsPct",
    ]);
    const serialized = JSON.stringify(quote);
    for (const forbidden of ["margin", "Margin", "floor", "Floor", "adyen", "Adyen", "cost", "bps", "interchange", "aioRevenue"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("carries no quote lines or order points when none were configured", () => {
    expect(quote.lines).toEqual([]);
    expect(quote.lineTotals).toBeNull();
    expect(quote.orderPoints).toBeNull();
  });
});

describe("buildCustomerSafeQuote — quote lines and order points", () => {
  const LINES = [
    {
      hubspotProductId: "217526517443", name: "AIO Platform (1 to 5 Order Points)", qty: 1,
      unitPrice: 99, billingFrequency: "weekly", productType: "Software",
    },
    {
      hubspotProductId: "217445755632", name: "POS Unit", qty: 2,
      unitPrice: 749, billingFrequency: "one_time", productType: "inventory",
    },
  ] as const;

  const quote = rated(buildCustomerSafeQuote({
    analysis: null,
    quoteConfig: CONFIG,
    quoteRates: null,
    targetMargin: 0.008,
    pricingModel: "2-tier",
    quoteLines: [...LINES],
    orderPoints: { hardware: { "POS Unit": 2 }, channels: ["website"], total: 3 },
  }));

  it("passes the lines through exactly as snapshotted", () => {
    expect(quote.lines).toEqual([...LINES]);
  });

  it("totals them by cycle without ever merging one-time and weekly", () => {
    expect(quote.lineTotals).toEqual({
      oneTime: 1498,
      recurring: [{ frequency: "weekly", amount: 99 }],
      monthlyEquivalent: 99 * (52 / 12),
    });
  });

  it("states the order-point count the platform line was priced on", () => {
    expect(quote.orderPoints).toEqual({ hardware: { "POS Unit": 2 }, channels: ["website"], total: 3 });
  });

  it("still leaks no internal field with lines attached", () => {
    const serialized = JSON.stringify(quote);
    for (const forbidden of ["margin", "Margin", "floor", "Floor", "adyen", "Adyen", "cost", "bps", "interchange", "aioRevenue"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("buildCustomerSafeQuote — statement basis", () => {
  const analysis = {
    totalVolume: 100_000,
    totalTransactions: 2500,
    totalFees: 3_500,
    averageTicket: 40,
    interchangeRate: 0.018,
    icEstimated: false,
    cardPresentPct: 0.8,
    cardNotPresentPct: 0.2,
    cardPresentVolume: 80_000,
    cardNotPresentVolume: 20_000,
  } as StatementAnalysis;

  it("compares against the statement's own fee total", () => {
    const quote = rated(buildCustomerSafeQuote({
      analysis, quoteConfig: null, targetMargin: null,
      quoteRates: DEFAULT_QUOTE_RATES, pricingModel: "2-tier",
    }));
    // The quoted rate, not a margin over the statement's interchange:
    //   100,000 × 2.49% + 2,500 × $0.15 = $2,865.
    // The statement's own interchange still matters — it is what AIO's margin
    // is measured against internally — but it no longer sets the price.
    const projected = 100_000 * 0.0249 + 2_500 * 0.15;
    expect(quote.basis).toBe("statement");
    expect(quote.projectedMonthlyCost).toBeCloseTo(projected, 6);
    expect(quote.currentMonthlyCost).toBe(3500);
    expect(quote.currentEffectiveRate).toBeCloseTo(0.035, 10);
    expect(quote.monthlySavings).toBeCloseTo(3500 - projected, 6);
    expect(quote.annualSavings).toBeCloseTo((3500 - projected) * 12, 6);
    expect(quote.savingsPct).toBeCloseTo((3500 - projected) / 3500, 10);
  });

  it("takes precedence over a quoteConfig on the same application", () => {
    const quote = rated(buildCustomerSafeQuote({
      analysis,
      quoteConfig: { avgTicket: 5, monthlyVolume: 1_000 },
      quoteRates: null,
      targetMargin: 0.008,
      pricingModel: "2-tier",
    }));
    expect(quote.basis).toBe("statement");
    expect(quote.monthlyVolume).toBe(100_000);
  });
});

describe("hasQuoteBasis", () => {
  const none = { analysis: null, quoteConfig: null, quoteRates: null, targetMargin: null, pricingModel: null };

  it("is false with neither a statement nor configs", () => {
    expect(hasQuoteBasis(none)).toBe(false);
    expect(buildCustomerSafeQuote(none)).toBeNull();
  });

  it("is false for a config with no volume, and no quote comes out of it", () => {
    const basis = { ...none, quoteConfig: { avgTicket: 40, monthlyVolume: 0 } };
    expect(hasQuoteBasis(basis)).toBe(false);
    expect(buildCustomerSafeQuote(basis)).toBeNull();
  });

  it("is true once either side is present", () => {
    expect(hasQuoteBasis({ ...none, quoteConfig: CONFIG })).toBe(true);
    expect(hasQuoteBasis({ ...none, analysis: { totalVolume: 1 } as StatementAnalysis })).toBe(true);
  });

  it("is false for a statement whose volume didn't read", () => {
    // A mis-read statement used to pass this gate and fail the render, which
    // marked the deal quote_sent and let /accept record an acceptance of a
    // quote that draws as nothing.
    const basis = { ...none, analysis: { totalVolume: 0, totalFees: 900 } as StatementAnalysis };
    expect(hasQuoteBasis(basis)).toBe(false);
    expect(buildCustomerSafeQuote(basis)).toBeNull();
  });

  it("never disagrees with buildCustomerSafeQuote — one predicate, no drift", () => {
    const cases = [
      none,
      { ...none, quoteConfig: CONFIG },
      { ...none, quoteConfig: { avgTicket: 40, monthlyVolume: 0 } },
      { ...none, analysis: { totalVolume: 0 } as StatementAnalysis },
      { ...none, analysis: { totalVolume: 50_000 } as StatementAnalysis },
      // A statement that read as zero does NOT fall back to the configs — the
      // statement wins in buildCustomerSafeQuote, so it has to win here too.
      { ...none, analysis: { totalVolume: 0 } as StatementAnalysis, quoteConfig: CONFIG },
      // Marketing-only: the lines are the whole quote, so the rate half decides
      // nothing either way.
      { ...none, quoteType: "marketing_only" as const },
      { ...none, quoteType: "marketing_only" as const, quoteLines: [...MARKETING_LINES] },
      { ...none, quoteType: "marketing_only" as const, quoteConfig: CONFIG },
    ];
    for (const basis of cases) {
      expect(hasQuoteBasis(basis)).toBe(buildCustomerSafeQuote(basis) !== null);
    }
  });
});

const MARKETING_LINES = [
  {
    hubspotProductId: "223152695997", name: "AIO Marketing Platform",
    qty: 1, unitPrice: 49, billingFrequency: "weekly" as const, productType: "Software",
  },
  {
    hubspotProductId: "247901295335", name: "AIO Marketing Add Spend",
    qty: 1, unitPrice: 99, billingFrequency: "monthly" as const, productType: "Service",
  },
];

describe("buildCustomerSafeQuote — marketing-only", () => {
  const basis = {
    quoteType: "marketing_only" as const,
    analysis: null, quoteConfig: null, quoteRates: null, targetMargin: null, pricingModel: null,
    quoteLines: [...MARKETING_LINES],
    orderPoints: null,
  };

  it("prices the lines with no rate half at all", () => {
    const quote = buildCustomerSafeQuote(basis)!;
    expect(quote.basis).toBe("products");
    expect(quote.lines).toEqual([...MARKETING_LINES]);
    // 49/wk and 99/mo are different cycles and stay apart.
    expect(quote.lineTotals).toEqual({
      oneTime: 0,
      recurring: [{ frequency: "weekly", amount: 49 }, { frequency: "monthly", amount: 99 }],
      monthlyEquivalent: 49 * (52 / 12) + 99,
    });
    expect(quote.orderPoints).toBeNull();
  });

  it("exposes no rate, volume or savings field — there is no processing behind it", () => {
    const quote = buildCustomerSafeQuote(basis)!;
    for (const key of [
      "monthlyVolume", "averageTicket", "effectiveRate", "projectedMonthlyCost",
      "projectedAnnualCost", "currentMonthlyCost", "currentEffectiveRate",
      "monthlySavings", "annualSavings", "savingsPct",
    ]) {
      expect(quote).not.toHaveProperty(key);
    }
  });

  it("ignores a rate basis that somehow rode along on the row", () => {
    // Belt and braces: createProspectAction already drops these when there is
    // no processing on the quote. Note WHY this stays products-only — these
    // lines carry no Website. A marketing quote that does carry one is rated,
    // and that is the describe block below.
    const quote = buildCustomerSafeQuote({
      ...basis, quoteConfig: CONFIG, quoteRates: null, targetMargin: 0.008, pricingModel: "2-tier",
    })!;
    expect(quote.basis).toBe("products");
  });

  it("is null with no lines — an empty marketing quote is not a quote", () => {
    expect(buildCustomerSafeQuote({ ...basis, quoteLines: [] })).toBeNull();
    expect(buildCustomerSafeQuote({ ...basis, quoteLines: null })).toBeNull();
  });

  it("reads a row with no quoteType as a rated quote, unchanged", () => {
    const rated = buildCustomerSafeQuote({
      analysis: null, quoteConfig: CONFIG, quoteRates: null, targetMargin: 0.008, pricingModel: "2-tier",
    })!;
    expect(rated.basis).toBe("config");
  });
});

// The two rep flows (/rep/proposals/new and /rep/prospects/new) write the same
// merchant_applications row and now end at the same customer link, so the
// customer quote must depend only on the stored columns and not on which flow
// filled them in. These guard that merge.
describe("buildCustomerSafeQuote — one projection for both rep flows", () => {
  const LINES = [
    {
      hubspotProductId: "217526517443", name: "AIO Platform (1 to 5 Order Points)", qty: 1,
      unitPrice: 99, billingFrequency: "weekly", productType: "Software",
    },
  ] as const;
  const POINTS = { hardware: {}, channels: ["website"], total: 1 };

  // What the wizard now persists (quoteRates/pricingModel/quoteLines/
  // orderPoints) against what the prospect form has always persisted.
  const wizardRow = {
    analysis: null, quoteConfig: CONFIG, targetMargin: null, pricingModel: "2-tier",
    quoteRates: { cardPresentRate: 0.0275, cardNotPresentRate: 0.0275, amexCardPresentRate: 0.0275, amexCardNotPresentRate: 0.0275, perTransactionFee: 0.15 },
    quoteLines: [...LINES], orderPoints: POINTS,
  };
  const prospectRow = { ...wizardRow };

  it("gives the same quote for the same columns whichever flow wrote them", () => {
    expect(buildCustomerSafeQuote(wizardRow)).toEqual(buildCustomerSafeQuote(prospectRow));
  });

  it("honours the rep's own rates instead of the standard ones", () => {
    // The wizard used to drop what the rep set on the Pricing step, so a Flow A
    // deal was silently quoted at the default. Same hazard, new input.
    const chosen    = rated(buildCustomerSafeQuote(wizardRow));
    const defaulted = rated(buildCustomerSafeQuote({ ...wizardRow, quoteRates: null }));
    const expectedMonthly = 100_000 * 0.0275 + 2_500 * 0.15;
    expect(chosen.projectedMonthlyCost).toBeCloseTo(expectedMonthly, 6);
    expect(chosen.projectedMonthlyCost).toBeGreaterThan(defaulted.projectedMonthlyCost);
  });

  it("renders a real quote — lines, totals and points all present", () => {
    const quote = rated(buildCustomerSafeQuote(wizardRow));
    expect(quote.projectedMonthlyCost).toBeGreaterThan(0);
    expect(quote.effectiveRate).toBeGreaterThan(0);
    expect(quote.lines).toEqual([...LINES]);
    expect(quote.lineTotals?.monthlyEquivalent).toBeCloseTo(99 * (52 / 12), 10);
    expect(quote.orderPoints).toEqual(POINTS);
  });

  it("never fabricates a saving on the statement-less path", () => {
    // analysisFromQuoteConfig leaves totalFees at 0, so a naive
    // current − projected would print a large negative "saving".
    const quote = rated(buildCustomerSafeQuote(wizardRow));
    expect(quote.basis).toBe("config");
    expect(quote.monthlySavings).toBeNull();
    expect(quote.annualSavings).toBeNull();
  });

  it("shows the saving as soon as a statement supplies the current cost", () => {
    const withStatement = rated(buildCustomerSafeQuote({
      ...wizardRow,
      analysis: { totalVolume: 100_000, totalTransactions: 2500, totalFees: 4_000, averageTicket: 40,
        interchangeRate: 0.018, icEstimated: false, cardPresentPct: 0.9, cardNotPresentPct: 0.1,
        cardPresentVolume: 90_000, cardNotPresentVolume: 10_000 } as StatementAnalysis,
    }));
    expect(withStatement.basis).toBe("statement");
    expect(withStatement.currentMonthlyCost).toBe(4_000);
    expect(withStatement.monthlySavings).toBeGreaterThan(0);
    // The hardware lines ride along either way.
    expect(withStatement.lines).toEqual([...LINES]);
  });
});

// ── Marketing + Website: priced lines AND a rate ────────────────────────────
// The $50 Website makes a marketing merchant a processing merchant, so their
// quote has both halves. The CustomerSafeQuote union already allowed that —
// the rated variant is `CustomerSafeRate & CustomerSafeLines` — which is why
// this needed no new shape, only the right predicate in front of it.
describe("buildCustomerSafeQuote — marketing with a website", () => {
  const WEBSITE = {
    hubspotProductId: "333275576048", name: "Website",
    qty: 1, unitPrice: 50, billingFrequency: "monthly" as const, productType: "",
  };
  const PLATFORM = {
    hubspotProductId: "332609247965", name: "AIO Marketing Platform",
    qty: 1, unitPrice: 199, billingFrequency: "monthly" as const, productType: "Software",
  };
  // Online ordering on the Website is saved as this $0 card-rate line.
  const RATE_LINE = {
    hubspotProductId: "260559288040", name: "AIO Processing Two Tiered Rate",
    qty: 1, unitPrice: 0, billingFrequency: "one_time" as const, productType: "AIO Payment Processing",
  };
  const basis = {
    quoteType: "marketing_only" as const,
    analysis: null, quoteConfig: null, quoteRates: null, targetMargin: null, pricingModel: null,
    quoteLines: [PLATFORM, RATE_LINE, WEBSITE],
    orderPoints: null,
  };

  it("quotes a real rate once there's a volume to price it on", () => {
    const quote = rated(buildCustomerSafeQuote({ ...basis, quoteConfig: CONFIG, quoteRates: null, targetMargin: 0.008, pricingModel: "2-tier" }));
    expect(quote.basis).toBe("config");
    expect(quote.monthlyVolume).toBe(CONFIG.monthlyVolume);
    expect(quote.effectiveRate).toBeGreaterThan(0);
    // And the lines are still there — this merchant buys both.
    expect(quote.lines).toEqual([PLATFORM, RATE_LINE, WEBSITE]);
    expect(quote.lineTotals!.recurring).toEqual([{ frequency: "monthly", amount: 249 }]);
  });

  it("prices the same rate a POS merchant would get on that volume", () => {
    // The merchant is the same to Adyen either way; only the plan differs.
    const marketing = rated(buildCustomerSafeQuote({ ...basis, quoteConfig: CONFIG, quoteRates: null, targetMargin: 0.008, pricingModel: "2-tier" }));
    const pos = rated(buildCustomerSafeQuote({
      quoteType: "all_in_one" as const, analysis: null, quoteConfig: CONFIG,
      quoteRates: null, targetMargin: 0.008, pricingModel: "2-tier",
    }));
    expect(marketing.effectiveRate).toBe(pos.effectiveRate);
    expect(marketing.projectedMonthlyCost).toBe(pos.projectedMonthlyCost);
  });

  it("shows the hardware and holds the rate back when there's no volume yet", () => {
    // A half-built quote, not a different kind of quote. Showing them what
    // they're buying beats showing nothing while the rep chases a statement.
    const quote = buildCustomerSafeQuote(basis)!;
    expect(quote.basis).toBe("products");
    expect(quote.lines).toEqual([PLATFORM, RATE_LINE, WEBSITE]);
    expect(quote).not.toHaveProperty("effectiveRate");
  });

  it("quotes no rate for a website without online ordering, whatever the volume", () => {
    const quote = buildCustomerSafeQuote({
      ...basis, quoteLines: [PLATFORM, WEBSITE], quoteConfig: CONFIG, targetMargin: 0.008, pricingModel: "2-tier",
    })!;
    expect(quote.basis).toBe("products");
    expect(quote).not.toHaveProperty("effectiveRate");
  });

  it("is still null with no lines at all", () => {
    expect(buildCustomerSafeQuote({ ...basis, quoteLines: [], quoteConfig: CONFIG })).toBeNull();
  });

  it("leaves a PROCESSING plan with no rate basis null, not products-only", () => {
    // Unchanged, and deliberately not folded into the fallback above: a POS
    // quote IS the rate, so there is nothing to show without one.
    expect(buildCustomerSafeQuote({
      quoteType: "all_in_one" as const, analysis: null, quoteConfig: null,
      quoteRates: null, targetMargin: null, pricingModel: null, quoteLines: [PLATFORM],
    })).toBeNull();
  });
});

// The rep types a rate on one screen and the merchant reads it on another.
// Every customer-facing entry point builds its QuoteBasis by hand from the
// application row, and all three of them shipped omitting `quoteRates` — so
// every customer quote priced at the standard rate however the rep had
// configured it. That is why QuoteBasis.quoteRates is REQUIRED rather than
// optional: the compiler now refuses the next one.
describe("the rep's rates reach the customer", () => {
  const CUSTOM = { cardPresentRate: 0.0199, cardNotPresentRate: 0.0199, amexCardPresentRate: 0.0199, amexCardNotPresentRate: 0.0199, perTransactionFee: 0.05 };

  it("prices the customer's quote at what the rep configured, not the default", () => {
    const quote = rated(buildCustomerSafeQuote({
      quoteRates: CUSTOM, analysis: null, quoteConfig: CONFIG,
      targetMargin: null, pricingModel: "2-tier",
    }));
    const standard = rated(buildCustomerSafeQuote({
      quoteRates: null, analysis: null, quoteConfig: CONFIG,
      targetMargin: null, pricingModel: "2-tier",
    }));

    expect(quote.projectedMonthlyCost).toBeCloseTo(100_000 * 0.0199 + 2_500 * 0.05, 6);
    expect(quote.projectedMonthlyCost).toBeLessThan(standard.projectedMonthlyCost);
  });

  it("carries the rate through to the savings the merchant is shown", () => {
    const analysis = {
      totalVolume: 100_000, totalTransactions: 2_500, totalFees: 3_500, averageTicket: 40,
      interchangeRate: 0.018, icEstimated: false,
      cardPresentPct: 0.9, cardNotPresentPct: 0.1,
      cardPresentVolume: 90_000, cardNotPresentVolume: 10_000,
    } as StatementAnalysis;

    const cheap = rated(buildCustomerSafeQuote({
      quoteRates: CUSTOM, analysis, quoteConfig: null, targetMargin: null, pricingModel: "2-tier",
    }));
    const standard = rated(buildCustomerSafeQuote({
      quoteRates: null, analysis, quoteConfig: null, targetMargin: null, pricingModel: "2-tier",
    }));

    // A better rate is a bigger saving — the number the whole proposal rests on.
    expect(cheap.monthlySavings!).toBeGreaterThan(standard.monthlySavings!);
    expect(cheap.monthlySavings!).toBeCloseTo(3_500 - (100_000 * 0.0199 + 2_500 * 0.05), 6);
  });
});
