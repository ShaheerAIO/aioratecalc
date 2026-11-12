// @vitest-environment jsdom
//
// "Use standard rates" in the Edit Quote panel (product owner, 2026-11-11).
// Volume isn't editable here, so the button only resets the rates to the flat
// standard card: 2.49% + $0.15 card present, AIO's policy card-not-present.
// With a volume basis on file the 2.49% is still judged against the rate
// card's range like any typed rate — standard rates waive no approval.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { CatalogProduct, MerchantApplication, QuoteLine, QuoteRates } from "@/types/merchant";

const { saveQuoteConfigurationAction, listQuotableProductsAction, analysisFromQuoteConfigAction, getSuggestedRatesAction } = vi.hoisted(() => ({
  saveQuoteConfigurationAction: vi.fn(),
  listQuotableProductsAction: vi.fn(),
  analysisFromQuoteConfigAction: vi.fn(),
  getSuggestedRatesAction: vi.fn(),
}));
vi.mock("@/lib/actions/prospects", () => ({ saveQuoteConfigurationAction, analysisFromQuoteConfigAction }));
vi.mock("@/lib/actions/applications", () => ({ getSettingsAction: () => Promise.resolve(null) }));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
vi.mock("@/lib/actions/pricing", () => ({
  getPricingPreviewAction: vi.fn(() => Promise.resolve(null)),
  getMaxDiscountPercent: () => Promise.resolve(50),
  getQuoteLimits: () => Promise.resolve({ unitCaps: {}, maxBillingDelayDays: 90, showTablets: false }),
}));
vi.mock("@/lib/actions/rateMatrix", () => ({
  getSuggestedRatesAction,
  getCnpPolicyRateAction: () => Promise.resolve(0.033),
}));

import EditQuotePanel from "@/components/rep/EditQuotePanel";

const P = (id: string, name: string, price: number, f: CatalogProduct["billingFrequency"], t: string): CatalogProduct =>
  ({ hubspotProductId: id, name, price, billingFrequency: f, productType: t });
const CATALOG = [
  P("335283119838", "All-in-One Platform", 399, "monthly", "Software"),
  P("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  P("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  P("217445755632", "POS Unit", 949, "one_time", "inventory"),
  P("223511653105", "Payment Terminal - AMS1", 350, "one_time", "inventory"),
  P("260559288040", "AIO Processing Two Tiered Rate", 0, "monthly", "AIO Payment Processing"),
  P("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
];
const LINES: QuoteLine[] = [
  { hubspotProductId: "335283119838", name: "All-in-One Platform", qty: 1, unitPrice: 399, billingFrequency: "monthly", productType: "Software", billingStart: { mode: "days", days: 45 } },
  { hubspotProductId: "217445755632", name: "POS Unit", qty: 1, unitPrice: 949, billingFrequency: "one_time", productType: "inventory" },
  { hubspotProductId: "223511653105", name: "Payment Terminal - AMS1", qty: 1, unitPrice: 350, billingFrequency: "one_time", productType: "inventory" },
];
// Saved off-card: a CNP off policy, a different fee.
const SAVED: QuoteRates = {
  cardPresentRate: 0.027, amexCardPresentRate: 0.027,
  cardNotPresentRate: 0.035, amexCardNotPresentRate: 0.035, perTransactionFee: 0.2,
};
const STANDARD: QuoteRates = {
  cardPresentRate: 0.0249, amexCardPresentRate: 0.0249,
  cardNotPresentRate: 0.033, amexCardNotPresentRate: 0.033, perTransactionFee: 0.15,
};
const app = (over: Partial<MerchantApplication> = {}) => ({
  id: "app-1", quoteType: "all_in_one", quoteLines: LINES, quoteNote: null, orderPoints: null,
  analysis: null, quoteConfig: null, quoteRates: SAVED, pricingModel: "2-tier", hubspotIds: null,
  quoteAcceptedAt: null, detailsConfirmedAt: null, ...over,
}) as unknown as MerchantApplication;

const standardButton = () => screen.getByRole("button", { name: "Use standard rates" }) as HTMLButtonElement;
const cp = () => (screen.getByLabelText("Card present rate, percent") as HTMLInputElement).value;

beforeEach(() => {
  listQuotableProductsAction.mockResolvedValue({ products: CATALOG, all: CATALOG, error: null });
  saveQuoteConfigurationAction.mockResolvedValue({});
  getSuggestedRatesAction.mockResolvedValue(null);
  analysisFromQuoteConfigAction.mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("EditQuotePanel — Use standard rates", () => {
  it("resets a saved quote's rates to the standard card, clearing the off-policy CNP approval", async () => {
    render(<EditQuotePanel app={app()} onSaved={() => {}} onCancel={() => {}} />);
    // The saved 3.50% CNP is off the 3.30% policy, so it needs approval first.
    await screen.findByRole("button", { name: "Submit for approval" });
    await waitFor(() => expect(standardButton().disabled).toBe(false));
    fireEvent.click(standardButton());

    expect(cp()).toBe("2.49");
    const save = await screen.findByRole("button", { name: "Save Quote" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(saveQuoteConfigurationAction).toHaveBeenCalled());
    expect(saveQuoteConfigurationAction.mock.calls[0][0].quoteRates).toEqual(STANDARD);
  });

  it("with a volume on file, holds 2.49% against the rate card and still flags it outside the range", async () => {
    analysisFromQuoteConfigAction.mockResolvedValue({
      totalVolume: 400000, totalTransactions: 13333, averageTicket: 30, totalFees: 0,
    });
    getSuggestedRatesAction.mockResolvedValue({
      rates: { ...STANDARD, cardPresentRate: 0.0217, amexCardPresentRate: 0.0217 },
      volumeBand: "$250K+", ticketColumn: 30, adjustBpsRange: { min: -14, max: 3 },
    });
    render(
      <EditQuotePanel
        app={app({ quoteRates: { ...STANDARD, cardPresentRate: 0.0217, amexCardPresentRate: 0.0217 }, quoteConfig: { monthlyVolume: 400000, avgTicket: 30 } })}
        onSaved={() => {}} onCancel={() => {}}
      />
    );
    await waitFor(() => expect(getSuggestedRatesAction).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Save Quote" });
    await waitFor(() => expect(standardButton().disabled).toBe(false));
    fireEvent.click(standardButton());

    // RateSuggestion re-applies card + adjustment (+32), which is 2.49%.
    await waitFor(() => expect(cp()).toBe("2.49"));
    expect(screen.getByTestId("approval-summary").textContent)
      .toMatch(/Card-present rate adjustment is outside the allowed range/);
  });
});
