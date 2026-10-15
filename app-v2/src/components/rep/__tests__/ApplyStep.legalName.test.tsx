// @vitest-environment jsdom
//
// "make llc blank" (2026-10-13) — ApplyStep.tsx:26 used to seed the Legal
// Business Name field from the statement's `merchantName`, which is a TRADING
// name, not what's registered with the state. Under test: a fresh app with an
// analysis but no saved `business` record opens with Legal Business Name
// BLANK and DBA still carrying the trading name (that seed is intentionally
// unchanged).
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ApplyStep from "@/components/rep/ApplyStep";
import type { MerchantApplication, StatementAnalysis } from "@/types/merchant";

afterEach(cleanup);

const ANALYSIS = {
  merchantName: "Little Arabia", processingMonth: "2026-06", totalVolume: 124_500,
  totalTransactions: 3112, totalFees: 3450, interchangeFees: 2800, processorFees: 500,
  otherFees: 150, effectiveRate: 0.0277, interchangeRate: 0.0225, processorMarkup: 0.004,
  statedMarkupRate: 0.004, statedPerTxnFee: 0.1, interchangeNotShown: false, averageTicket: 40,
  cardPresentVolume: 99_600, cardNotPresentVolume: 24_900, cardPresentPct: 0.8, cardNotPresentPct: 0.2,
  visaVolume: 50_000, mastercardVolume: 40_000, amexVolume: 20_000, discoverVolume: 14_500,
  rewardCardPct: 0.3, corporateCardPct: 0.05, currentPricingModel: "flat-rate", currentProcessorName: "Clover",
  annualVolume: 1_494_000, confidence: "high", notes: "", currentMargin: 0.012,
} as StatementAnalysis;

function appWithAnalysisOnly(): MerchantApplication {
  return {
    id: "app-1", ownerUserId: "rep-1", customerUserId: null,
    createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z",
    stage: "analysis", hubspotDealId: null, dealLink: null, tenantLink: null,
    adyenIds: null, adyenOnboardingUrl: null, aioTenant: null, checkIds: null, foodbuyIds: null,
    hubspotIds: null, quoteType: null, quoteConfig: null, quoteLines: null, orderPoints: null,
    quoteAcceptedAt: null, detailsConfirmedAt: null, quoteNote: null, quoteRates: null, targetMargin: null, pricingModel: null,
    customerLinkToken: null, customerLinkPurpose: null, customerLinkSentAt: null, customerLinkExpiresAt: null,
    analysis: ANALYSIS, proposal: null,
    // No saved `business` yet — this is the fresh-wizard case ApplyStep's
    // useState initializer runs for.
    business: null, ownerContact: null, processing: null, agreement: null,
  };
}

// ApplyStep's `input()` helper renders the label as the input's PRECEDING
// SIBLING, with no `htmlFor`/`id` and no wrapping — so there's nothing for
// `getByLabelText` to associate them by. Reading the input off the label
// text's next sibling is what the markup actually supports.
function inputNextTo(labelText: string): HTMLInputElement {
  const label = screen.getByText(labelText);
  return label.nextElementSibling as HTMLInputElement;
}

describe("ApplyStep — Legal Business Name is blank on open (item 1)", () => {
  it("opens with Legal Business Name empty and DBA carrying the statement's merchant name", () => {
    render(<ApplyStep app={appWithAnalysisOnly()} onSaved={() => {}} onBack={() => {}} onSkip={() => {}} />);
    expect(inputNextTo("Legal Business Name").value).toBe("");
    expect(inputNextTo("DBA (Doing Business As)").value).toBe("Little Arabia");
  });

  it("does not override a saved business record — a reopened app keeps whatever legalName it already has", () => {
    const app = appWithAnalysisOnly();
    app.business = {
      legalName: "Little Arabia Holdings LLC", dba: "Little Arabia", bizType: "llc",
      address: "", city: "", state: "", zip: "", phone: "", website: "",
      yearsInBusiness: "", annualRevenue: "",
    };
    render(<ApplyStep app={app} onSaved={() => {}} onBack={() => {}} onSkip={() => {}} />);
    expect(inputNextTo("Legal Business Name").value).toBe("Little Arabia Holdings LLC");
  });
});
