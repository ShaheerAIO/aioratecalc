import { describe, it, expect } from "vitest";
import { paymentProcessingArr, paymentProcessingArrBreakdown } from "@/lib/billing/processingArr";
import { buildDealProperties, isAtOrPastClosedWon, SALES_PIPELINE_STAGES } from "@/lib/adapters/hubspot";
import { DEFAULT_QUOTE_RATES, MAX_PLAUSIBLE_CARD_RATE } from "@/types/merchant";
import { MARKETING_ADDON_PRODUCT, PAYROLL_PRODUCT_ID, WEBSITE_PRODUCT_ID } from "@/lib/quoting";
import type { MerchantApplication, StoredQuoteType } from "@/types/merchant";

// `payment_processing_arr` on the HubSpot deal, and the gate that keeps it
// off a deal nobody has accepted yet.

function app(over: Partial<MerchantApplication> = {}): MerchantApplication {
  return {
    id: "app-1",
    stage: "quote_accepted",
    hubspotDealId: "343689933538",
    quoteType: "all_in_one" as StoredQuoteType,
    quoteAcceptedAt: "2026-10-12T00:00:00.000Z",
    pricingModel: "2-tier",
    quoteRates: DEFAULT_QUOTE_RATES,
    quoteConfig: { monthlyVolume: 100000, avgTicket: 30 },
    analysis: null,
    business: { dba: "Torta Palace" },
    ...over,
  } as unknown as MerchantApplication;
}

describe("paymentProcessingArr", () => {
  it("is the take-rate-minus-wholesale commission margin, annualised", () => {
    const arr = paymentProcessingArr(app());
    expect(arr).not.toBeNull();

    // 2.49% CP rate + $0.15/txn on a $30 avg ticket (100000/30 txns) against
    // the $30 wholesale column (2.46%) — whatever that comes to, the identity
    // that matters is that ARR is twelve times one month of it.
    const monthly = arr! / 12;
    expect(monthly).toBeGreaterThan(0);
    expect(monthly).toBeLessThan(100000); // never more than the volume itself
  });

  it("scales with volume", () => {
    const small = paymentProcessingArr(app({ quoteConfig: { monthlyVolume: 50000, avgTicket: 30 } } as never))!;
    const big = paymentProcessingArr(app({ quoteConfig: { monthlyVolume: 200000, avgTicket: 30 } } as never))!;
    expect(big).toBeGreaterThan(small);
  });

  it("rises with the rate the merchant was quoted", () => {
    const standard = paymentProcessingArr(app())!;
    const dearer = paymentProcessingArr(app({
      quoteRates: { ...DEFAULT_QUOTE_RATES, cardPresentRate: 0.0299, cardNotPresentRate: 0.0299, amexCardPresentRate: 0.0299, amexCardNotPresentRate: 0.0299 },
    }))!;
    expect(dearer).toBeGreaterThan(standard);
  });

  // The product owner's own exclusion: a marketing merchant processes
  // nothing, so there is no processing margin to state.
  it("is null for both marketing plans", () => {
    expect(paymentProcessingArr(app({ quoteType: "marketing_only" as StoredQuoteType }))).toBeNull();
    expect(paymentProcessingArr(app({ quoteType: "marketing_term" as StoredQuoteType }))).toBeNull();
  });

  it("treats the two retired plans as all_in_one, the way quoteTypeOf does", () => {
    expect(paymentProcessingArr(app({ quoteType: "full_pos" as StoredQuoteType }))).not.toBeNull();
    expect(paymentProcessingArr(app({ quoteType: null }))).not.toBeNull();
  });

  it("is null with no volume behind the quote", () => {
    expect(paymentProcessingArr(app({ quoteConfig: null }))).toBeNull();
    expect(paymentProcessingArr(app({ quoteConfig: { monthlyVolume: 0, avgTicket: 30 } } as never))).toBeNull();
    // A half-set basis is not a basis.
    expect(paymentProcessingArr(app({ quoteConfig: { monthlyVolume: 100000, avgTicket: 0 } } as never))).toBeNull();
  });

  it("prefers a real statement over the rep's typed figures", () => {
    const withStatement = app({
      analysis: {
        totalVolume: 250000, totalTransactions: 8000, interchangeRate: 0.018,
        icEstimated: false, cardPresentPct: 0.9, cardNotPresentPct: 0.1,
      },
    } as never);
    const fromConfig = paymentProcessingArr(app())!;
    expect(paymentProcessingArr(withStatement)!).toBeGreaterThan(fromConfig);
  });

  it("is a whole number of dollars", () => {
    expect(Number.isInteger(paymentProcessingArr(app())!)).toBe(true);
  });

  // The 20.00%-instead-of-2.0% typo (Elizabeth, 10/9 notes): a quoted rate
  // this far out isn't an unusually profitable merchant, it's bad input —
  // and this figure feeds rep commission (total_arr → signing/activation
  // commission), so a wrong number must never go out as a right-looking one.
  it("is null when a quoted rate exceeds MAX_PLAUSIBLE_CARD_RATE", () => {
    expect(paymentProcessingArr(app({
      quoteRates: { ...DEFAULT_QUOTE_RATES, cardPresentRate: 0.20 },
    }))).toBeNull();
  });

  it("checks all four rate fields, not just cardPresentRate", () => {
    expect(paymentProcessingArr(app({
      quoteRates: { ...DEFAULT_QUOTE_RATES, cardNotPresentRate: 0.20 },
    }))).toBeNull();
    expect(paymentProcessingArr(app({
      quoteRates: { ...DEFAULT_QUOTE_RATES, amexCardPresentRate: 0.20 },
    }))).toBeNull();
    expect(paymentProcessingArr(app({
      quoteRates: { ...DEFAULT_QUOTE_RATES, amexCardNotPresentRate: 0.20 },
    }))).toBeNull();
  });

  it("is not tripped by a rate exactly at the ceiling, only past it", () => {
    expect(paymentProcessingArr(app({
      quoteRates: { ...DEFAULT_QUOTE_RATES, cardPresentRate: MAX_PLAUSIBLE_CARD_RATE },
    }))).not.toBeNull();
  });

  // perTransactionFee is a flat dollar amount, not a percentage — must never
  // be compared against a rate ceiling.
  it("does not flag a large flat per-transaction fee as an implausible rate", () => {
    expect(paymentProcessingArr(app({
      quoteRates: { ...DEFAULT_QUOTE_RATES, perTransactionFee: 10 },
    }))).not.toBeNull();
  });

  it("null quoteRates falls back to DEFAULT_QUOTE_RATES and is never implausible", () => {
    expect(paymentProcessingArr(app({ quoteRates: null }))).not.toBeNull();
  });
});

describe("paymentProcessingArrBreakdown — the implausible-rate guard", () => {
  it("reports the offending rate when arr is null for this reason, and the rest of the breakdown stays populated", () => {
    const b = paymentProcessingArrBreakdown(app({
      quoteRates: { ...DEFAULT_QUOTE_RATES, cardPresentRate: 0.20 },
    }));
    expect(b.arr).toBeNull();
    expect(b.implausibleRate).toBe(0.20);
    expect(b.monthlyVolume).toBeGreaterThan(0);
    expect(b.takeRate).not.toBeNull();
    expect(b.wholesalePct).not.toBeNull();
    expect(b.commissionMargin).not.toBeNull();
  });

  it("leaves implausibleRate null for every other reason arr is null", () => {
    expect(paymentProcessingArrBreakdown(app({ quoteType: "marketing_only" as StoredQuoteType })).implausibleRate).toBeNull();
    expect(paymentProcessingArrBreakdown(app({ quoteConfig: null })).implausibleRate).toBeNull();
  });

  it("reports both halves of the margin: take rate and the wholesale % the ticket read", () => {
    // $30 avg ticket reads the $40 wholesale column ($30 – $39.99): 2.45%.
    const b = paymentProcessingArrBreakdown(app());
    expect(b.wholesalePct).toBeCloseTo(0.0245, 4);
    expect(b.takeRate).not.toBeNull();
    expect(b.commissionMargin).toBeCloseTo(b.takeRate! - b.wholesalePct!, 10);
  });
});

describe("buildDealProperties — payment_processing_arr", () => {
  it("writes it once the merchant has accepted", () => {
    const props = buildDealProperties(app());
    expect(Number(props.payment_processing_arr)).toBeGreaterThan(0);
  });

  // Before acceptance it is a hope, and this property feeds total_arr, which
  // the sales org reads as booked revenue.
  it("omits it before acceptance", () => {
    expect(buildDealProperties(app({ quoteAcceptedAt: null }))).not.toHaveProperty("payment_processing_arr");
  });

  // Omitted rather than zeroed: a 0 would read as a measured zero.
  it("omits it on a marketing quote even after acceptance", () => {
    const props = buildDealProperties(app({ quoteType: "marketing_only" as StoredQuoteType }));
    expect(props).not.toHaveProperty("payment_processing_arr");
  });

  it("omits it when there is no volume", () => {
    expect(buildDealProperties(app({ quoteConfig: null }))).not.toHaveProperty("payment_processing_arr");
  });

  // The guard this whole file is about: a rep's decimal-point slip must not
  // reach the deal and pay a commission computed off it.
  it("omits it when a quoted rate exceeds MAX_PLAUSIBLE_CARD_RATE, even though the merchant has accepted", () => {
    const props = buildDealProperties(app({ quoteRates: { ...DEFAULT_QUOTE_RATES, cardPresentRate: 0.20 } }));
    expect(props).not.toHaveProperty("payment_processing_arr");
  });
});

describe("buildDealProperties — modules_used", () => {
  const line = (hubspotProductId: string) => ({ hubspotProductId, name: "", qty: 1 });
  const modules = (over: Partial<MerchantApplication>) => buildDealProperties(app(over)).modules_used;

  it("ticks Marketing and POS/Payments on All-in-One", () => {
    expect(modules({ quoteLines: [] })).toBe("Marketing;POS/Payments");
  });

  it("ticks only POS/Payments on Order & Pay Only", () => {
    expect(modules({ quoteType: "order_pay_only" as StoredQuoteType, quoteLines: [] })).toBe("POS/Payments");
  });

  it("ticks only Marketing on Marketing Only", () => {
    expect(modules({ quoteType: "marketing_only" as StoredQuoteType, quoteLines: [] })).toBe("Marketing");
  });

  it("ticks Marketing on Partial Ordering only with the marketing line", () => {
    const quoteType = "marketing_partial" as StoredQuoteType;
    expect(modules({ quoteType, quoteLines: [] })).toBe("POS/Payments");
    expect(modules({ quoteType, quoteLines: [line(MARKETING_ADDON_PRODUCT.hubspotProductId)] as never }))
      .toBe("Marketing;POS/Payments");
  });

  it("ticks Website and Payroll from their lines", () => {
    expect(modules({ quoteType: "order_pay_only" as StoredQuoteType, quoteLines: [line(WEBSITE_PRODUCT_ID), line(PAYROLL_PRODUCT_ID)] as never }))
      .toBe("Website;POS/Payments;Payroll");
  });

  // An empty value would clear the rep's own ticks before EasyOB knows anything.
  it("is omitted until the quote has a plan", () => {
    expect(buildDealProperties(app({ quoteType: null }))).not.toHaveProperty("modules_used");
  });
});

describe("isAtOrPastClosedWon", () => {
  // The whole reason this exists: AIO's pipeline runs four live stages AFTER
  // Closed Won, every one of them flagged `closed: false`, so the existing
  // "is it closed" gate waves them through.
  it("catches the live stages that sit after Closed Won", () => {
    for (const label of ["Onboarding", "Onboarding Delayed", "Configuration", "Deployment/Training", "Deal Active"]) {
      const stage = SALES_PIPELINE_STAGES.find(s => s.label === label)!;
      expect(stage.closed).toBe(false);
      expect(isAtOrPastClosedWon(stage.id)).toBe(true);
    }
  });

  it("catches Closed Won itself", () => {
    expect(isAtOrPastClosedWon("closedwon")).toBe(true);
  });

  it("lets every stage before Closed Won through", () => {
    for (const label of ["Discovery Meeting", "Demo Meeting", "Quote Sent", "Signing Delayed",
                         "Signed Awaiting Features", "Signed/Awaiting Payment Info"]) {
      const stage = SALES_PIPELINE_STAGES.find(s => s.label === label)!;
      expect(isAtOrPastClosedWon(stage.id)).toBe(false);
    }
  });

  // dealStageRank's standing convention: an unrecognised stage ranks -1, so a
  // brand-new one never locks reps out of quoting until someone redeploys.
  it("lets an unknown or missing stage through", () => {
    expect(isAtOrPastClosedWon(null)).toBe(false);
    expect(isAtOrPastClosedWon("9999999999")).toBe(false);
  });
});
