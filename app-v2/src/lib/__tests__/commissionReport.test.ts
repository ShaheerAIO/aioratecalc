import { describe, it, expect } from "vitest";
import { buildCommissionReport, commissionRowForApplication } from "@/lib/billing/commissionReport";
import { DEFAULT_HARDWARE_COMMISSION_POLICY } from "@/lib/commission";
import { DEFAULT_QUOTE_RATES } from "@/types/merchant";
import type { MerchantApplication, StoredQuoteType } from "@/types/merchant";

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

describe("commissionRowForApplication", () => {
  it("is null for an application with no pricing basis and no ARR at all", () => {
    const empty = app({ quoteConfig: undefined, analysis: null, quoteType: "marketing_only" as StoredQuoteType });
    expect(commissionRowForApplication(empty, null, DEFAULT_HARDWARE_COMMISSION_POLICY)).toBeNull();
  });

  it("reports the TRUE numbers — admin role is never padded", () => {
    const row = commissionRowForApplication(app(), null, DEFAULT_HARDWARE_COMMISSION_POLICY)!;
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
    const row = commissionRowForApplication(app(), null, DEFAULT_HARDWARE_COMMISSION_POLICY)!;
    expect(row.processorCostRate).toBeNull();
    expect(row.netMarginRate).toBeNull();
  });

  it("includes recurring ARR from quoteLines in totalArr", () => {
    const withoutLines = commissionRowForApplication(app(), null, DEFAULT_HARDWARE_COMMISSION_POLICY)!;
    const withLines = commissionRowForApplication(app({
      quoteLines: [{
        hubspotProductId: "335283119838", name: "All-in-One Platform", qty: 1,
        unitPrice: 399, billingFrequency: "monthly", productType: "Software",
      }],
    }), null, DEFAULT_HARDWARE_COMMISSION_POLICY)!;
    expect(withLines.recurringArr).toBe(4788);
    expect(withLines.totalArr!).toBeGreaterThan(withoutLines.totalArr!);
  });

  it("is always zero hardware commission under the default (unset) policy", () => {
    const row = commissionRowForApplication(app(), null, DEFAULT_HARDWARE_COMMISSION_POLICY)!;
    expect(row.hardwareCommission).toBe(0);
  });

  it("is still zero hardware commission even with a rate configured — no cost data to apply it to", () => {
    const row = commissionRowForApplication(app(), null, { hardwareCommissionBps: 1000 })!;
    expect(row.hardwareCommission).toBe(0);
  });
});

describe("buildCommissionReport", () => {
  it("drops applications with nothing to report and keeps the rest", () => {
    const apps = [
      app({ id: "a" }),
      app({ id: "b", quoteConfig: undefined, analysis: null, quoteType: "marketing_only" as StoredQuoteType }),
    ];
    const report = buildCommissionReport(apps, null, DEFAULT_HARDWARE_COMMISSION_POLICY);
    expect(report.map(r => r.applicationId)).toEqual(["a"]);
  });

  it("sorts by total ARR, biggest first", () => {
    const small = app({ id: "small", quoteConfig: { monthlyVolume: 20_000, avgTicket: 30 } });
    const big = app({ id: "big", quoteConfig: { monthlyVolume: 500_000, avgTicket: 30 } });
    const report = buildCommissionReport([small, big], null, DEFAULT_HARDWARE_COMMISSION_POLICY);
    expect(report.map(r => r.applicationId)).toEqual(["big", "small"]);
  });
});
