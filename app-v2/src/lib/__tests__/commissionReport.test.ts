import { describe, it, expect } from "vitest";
import {
  buildCommissionReport, buildCommissionDataGaps, commissionRowForApplication,
} from "@/lib/billing/commissionReport";
import { DEFAULT_QUOTE_RATES } from "@/types/merchant";
import type { MerchantApplication, QuoteLine, StoredQuoteType } from "@/types/merchant";

function app(over: Partial<MerchantApplication> = {}): MerchantApplication {
  return {
    id: "app-1",
    stage: "quote_accepted",
    hubspotDealId: "343689933538",
    quoteType: "all_in_one" as StoredQuoteType,
    quoteAcceptedAt: null,
    pricingModel: "2-tier",
    quoteRates: DEFAULT_QUOTE_RATES,
    quoteConfig: { monthlyVolume: 100_000, avgTicket: 30 },
    analysis: null,
    business: { dba: "Torta Palace" },
    quoteLines: [],
    ...over,
  } as unknown as MerchantApplication;
}

function line(over: Partial<QuoteLine> = {}): QuoteLine {
  return {
    hubspotProductId: "123",
    name: "POS Unit",
    qty: 1,
    unitPrice: 1000,
    billingFrequency: "one_time",
    productType: "Hardware",
    ...over,
  } as QuoteLine;
}

describe("commissionRowForApplication", () => {
  it("is null for an application with no pricing basis, no ARR, and no hardware commission data", () => {
    const empty = app({ quoteConfig: undefined, analysis: null, quoteType: "marketing_only" as StoredQuoteType });
    expect(commissionRowForApplication(empty, null)).toBeNull();
  });

  it("reports the TRUE numbers — admin role is never padded", () => {
    const row = commissionRowForApplication(app(), null)!;
    expect(row).not.toBeNull();
    expect(row.applicationId).toBe("app-1");
    expect(row.merchantName).toBe("Torta Palace");
    expect(row.aioRevenue).not.toBeNull();
    expect(row.trueMarginFloor).not.toBeNull();
    expect(row.processingArr).not.toBeNull();
    expect(row.signingCommission).not.toBeNull();
    expect(row.activationCommission).toBe(row.signingCommission);
  });

  it("has no processor cost figures with no active tier on file", () => {
    const row = commissionRowForApplication(app(), null)!;
    expect(row.processorCostRate).toBeNull();
    expect(row.netMarginRate).toBeNull();
  });

  it("includes recurring ARR from quoteLines in totalArr", () => {
    const withoutLines = commissionRowForApplication(app(), null)!;
    const withLines = commissionRowForApplication(app({
      quoteLines: [{
        hubspotProductId: "335283119838", name: "All-in-One Platform", qty: 1,
        unitPrice: 399, billingFrequency: "monthly", productType: "Software",
      }],
    }), null)!;
    expect(withLines.recurringArr).toBe(4788);
    expect(withLines.totalArr!).toBeGreaterThan(withoutLines.totalArr!);
  });

  it("is null (not zero) hardware commission with no one-time lines carrying both a cost and a rate", () => {
    const row = commissionRowForApplication(app(), null)!;
    expect(row.repHardwareCommission).toBeNull();
    expect(row.rsmHardwareCommission).toBeNull();
  });

  it("computes real rep/rsm hardware commission from a priced, rated one-time line", () => {
    const row = commissionRowForApplication(app({
      quoteLines: [line({
        unitPrice: 1000, qty: 2, costToRep: 600, repCommissionBps: 1000, rsmCommissionBps: 500,
      })],
    }), null)!;
    // netAmount = 2000 (no discount), margin = 2000 - 600*2 = 800
    expect(row.repHardwareCommission).toBeCloseTo(80); // 800 * 10%
    expect(row.rsmHardwareCommission).toBeCloseTo(40); // 800 * 5%
  });

  it("reports NOTHING for a package-covered line — AIO comps it, nobody loses on it", () => {
    // Was asserted as -$60 until 2026-10-14. The cost is real and still owed,
    // but it is AIO's giveaway, not the rep's discount, so it is excluded
    // rather than charged to them. A quote made only of covered lines has no
    // commission figure at all — null, not 0, since 0 would read as measured.
    const row = commissionRowForApplication(app({
      quoteLines: [line({
        unitPrice: 1000, qty: 1, costToRep: 600, repCommissionBps: 1000, rsmCommissionBps: 500,
        discountPercent: 100, coveredByPackage: "QSR Kit",
      })],
    }), null)!;
    expect(row.repHardwareCommission).toBeNull();
    expect(row.rsmHardwareCommission).toBeNull();
  });

  it("still charges a REP'S OWN discount below cost against their commission", () => {
    const row = commissionRowForApplication(app({
      quoteLines: [line({
        unitPrice: 1000, qty: 1, costToRep: 600, repCommissionBps: 1000, rsmCommissionBps: 500,
        discountPercent: 100,
      })],
    }), null)!;
    // netAmount = 0, margin = 0 - 600 = -600
    expect(row.repHardwareCommission).toBeCloseTo(-60); // -600 * 10%
    expect(row.rsmHardwareCommission).toBeCloseTo(-30); // -600 * 5%
  });

  it("surfaces a pure-hardware deal (no processing basis, no ARR) once hardware commission data exists", () => {
    const row = commissionRowForApplication(app({
      quoteConfig: undefined, analysis: null, quoteType: "marketing_only" as StoredQuoteType,
      quoteLines: [line({ costToRep: 100, repCommissionBps: 500, rsmCommissionBps: 500 })],
    }), null);
    expect(row).not.toBeNull();
    expect(row!.repHardwareCommission).not.toBeNull();
  });

  it("computes wholesale-basis total revenue and take rate for a normal processing quote, separate from the floor-enforcement basis", () => {
    const row = commissionRowForApplication(app({
      quoteConfig: { monthlyVolume: 100_000, avgTicket: 30 },
    }), null)!;
    // cardPresentRate 0.0249, perTransactionFee 0.15 (DEFAULT_QUOTE_RATES), $30 ticket -> $30 column (223 bps wholesale)
    // revenue = 0.0249*100000 + (100000/30)*0.15 = 2490 + 500 = 2990
    expect(row.totalRevenue).toBeCloseTo(2990, 0);
    expect(row.totalTakeRate).toBeCloseTo(0.0299, 4);
    expect(row.wholesaleMargin).toBeCloseTo(0.0299 - 0.0223, 4);
    // Separate field from the floor-enforcement-basis margin — never overwrites it.
    expect(row.wholesaleMargin).not.toBe(row.netMarginRate);
  });

  it("is all null (wholesale basis) for a marketing-only quote", () => {
    const row = commissionRowForApplication(app({
      quoteConfig: undefined, analysis: null, quoteType: "marketing_only" as StoredQuoteType,
      quoteLines: [line({ costToRep: 100, repCommissionBps: 500, rsmCommissionBps: 500 })],
    }), null)!;
    expect(row).not.toBeNull();
    expect(row.totalRevenue).toBeNull();
    expect(row.totalTakeRate).toBeNull();
    expect(row.wholesaleMargin).toBeNull();
    expect(row.implausibleRate).toBeNull();
    expect(row.processingArr).toBeNull();
  });

  it("is all null plus the implausible flag for a stored rate above MAX_PLAUSIBLE_CARD_RATE", () => {
    const row = commissionRowForApplication(app({
      quoteRates: { ...DEFAULT_QUOTE_RATES, cardPresentRate: 2.0049 }, // 200.49% — a real stored value
    }), null)!;
    expect(row.implausibleRate).toBeCloseTo(2.0049, 4);
    expect(row.totalRevenue).toBeNull();
    expect(row.totalTakeRate).toBeNull();
    expect(row.wholesaleMargin).toBeNull();
    expect(row.processingArr).toBeNull();
  });

  it("carries the floor-enforcement basis and the wholesale basis as separate fields that never overwrite each other", () => {
    const tier = {
      id: "t1", name: "Tier 1", isDefault: true,
      processingBps: 150, perTxnFee: 0.1, schemeBps: 10, monthlyFee: 0,
    };
    const row = commissionRowForApplication(app(), tier)!;
    // Both bases are now computable (a real activeTier is on file) — and they
    // disagree, which is the whole point: one basis must never silently
    // become, or be mistaken for, the other.
    expect(row.netMarginRate).not.toBeNull();
    expect(row.wholesaleMargin).not.toBeNull();
    expect(row.netMarginRate).not.toBe(row.wholesaleMargin);
    expect(row.aioRevenue).not.toBeNull();
    expect(row.totalRevenue).not.toBeNull();
    expect(row.aioRevenue).not.toBe(row.totalRevenue);
  });
});

describe("buildCommissionReport", () => {
  it("drops applications with nothing to report and keeps the rest", () => {
    const apps = [
      app({ id: "a" }),
      app({ id: "b", quoteConfig: undefined, analysis: null, quoteType: "marketing_only" as StoredQuoteType }),
    ];
    const report = buildCommissionReport(apps, null);
    expect(report.map(r => r.applicationId)).toEqual(["a"]);
  });

  it("sorts by total ARR, biggest first", () => {
    const small = app({ id: "small", quoteConfig: { monthlyVolume: 20_000, avgTicket: 30 } });
    const big = app({ id: "big", quoteConfig: { monthlyVolume: 500_000, avgTicket: 30 } });
    const report = buildCommissionReport([small, big], null);
    expect(report.map(r => r.applicationId)).toEqual(["big", "small"]);
  });
});

describe("buildCommissionDataGaps", () => {
  it("is empty when there are no quote lines anywhere", () => {
    const gaps = buildCommissionDataGaps([app()]);
    expect(gaps).toEqual({ missingCost: [], zeroCost: [], recurringWithRate: [] });
  });

  it("flags a one-time line with no cost on file", () => {
    const gaps = buildCommissionDataGaps([app({
      quoteLines: [line({ name: "Mystery Hardware", costToRep: null })],
    })]);
    expect(gaps.missingCost).toEqual(["Mystery Hardware"]);
    expect(gaps.zeroCost).toEqual([]);
  });

  it("flags a one-time line costed at a literal $0 separately from missing cost", () => {
    const gaps = buildCommissionDataGaps([app({
      quoteLines: [line({ name: "Network Switch", costToRep: 0 })],
    })]);
    expect(gaps.zeroCost).toEqual(["Network Switch"]);
    expect(gaps.missingCost).toEqual([]);
  });

  it("flags a recurring line that carries a commission rate", () => {
    const gaps = buildCommissionDataGaps([app({
      quoteLines: [line({
        name: "All-in-One Platform", billingFrequency: "monthly", repCommissionBps: 500,
      })],
    })]);
    expect(gaps.recurringWithRate).toEqual(["All-in-One Platform"]);
  });

  it("dedupes the same product name across multiple deals", () => {
    const gaps = buildCommissionDataGaps([
      app({ id: "a", quoteLines: [line({ name: "Mystery Hardware", costToRep: null })] }),
      app({ id: "b", quoteLines: [line({ name: "Mystery Hardware", costToRep: null })] }),
    ]);
    expect(gaps.missingCost).toEqual(["Mystery Hardware"]);
  });
});
