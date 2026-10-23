// @vitest-environment jsdom
//
// 2026-10-18: "Save Quote" sent the plan, picks, channels and rates — and NOT
// the per-line adjustments. The server re-derives the quote from what it is
// sent, so every edited quote lost its billing starts and discounts: a POS
// plan's 60-day start vanished, quoteNoteBlockers read the quote as billing
// "at checkout", and every save was refused for want of a note.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { CatalogProduct, MerchantApplication, QuoteLine } from "@/types/merchant";

const { saveQuoteConfigurationAction, listQuotableProductsAction } = vi.hoisted(() => ({
  saveQuoteConfigurationAction: vi.fn(),
  listQuotableProductsAction: vi.fn(),
}));
vi.mock("@/lib/actions/prospects", () => ({
  saveQuoteConfigurationAction,
  analysisFromQuoteConfigAction: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/lib/actions/applications", () => ({ getSettingsAction: () => Promise.resolve(null) }));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
vi.mock("@/lib/actions/pricing", () => ({
  getPricingPreviewAction: vi.fn(() => Promise.resolve(null)),
  getMaxDiscountPercent: () => Promise.resolve(50),
  getQuoteLimits: () => Promise.resolve({ unitCaps: {}, maxBillingDelayDays: 90, showTablets: false }),
}));
vi.mock("@/lib/actions/rateMatrix", () => ({
  getSuggestedRatesAction: () => Promise.resolve(null),
  getCnpPolicyRateAction: () => Promise.resolve(null),
}));

import EditQuotePanel from "@/components/rep/EditQuotePanel";

afterEach(cleanup);

const P = (id: string, name: string, price: number, f: CatalogProduct["billingFrequency"], t: string): CatalogProduct =>
  ({ hubspotProductId: id, name, price, billingFrequency: f, productType: t });
const CATALOG = [
  P("335283119838", "All-in-One Platform", 399, "monthly", "Software"),
  P("333275576048", "Website", 50, "monthly", "Software"),
  P("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  P("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  P("338690209525", "AIO Wifi Network Package - Unifi", 999, "one_time", "Service"),
  P("217445755632", "POS Unit", 949, "one_time", "inventory"),
  P("223511653105", "Payment Terminal - AMS1", 350, "one_time", "inventory"),
  P("260559288040", "AIO Processing Two Tiered Rate", 0, "monthly", "AIO Payment Processing"),
  P("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
];

const SIXTY = { mode: "days", days: 60 } as const;
const LINES: QuoteLine[] = [
  { hubspotProductId: "335283119838", name: "All-in-One Platform", qty: 1, unitPrice: 399, billingFrequency: "monthly", productType: "Software", billingStart: SIXTY },
  { hubspotProductId: "217445755632", name: "POS Unit", qty: 1, unitPrice: 949, billingFrequency: "one_time", productType: "inventory" },
  { hubspotProductId: "223511653105", name: "Payment Terminal - AMS1", qty: 1, unitPrice: 350, billingFrequency: "one_time", productType: "inventory" },
];

describe("EditQuotePanel — Save Quote", () => {
  it("sends the line adjustments, so the plan's 60-day start survives the save", async () => {
    listQuotableProductsAction.mockResolvedValue({ products: CATALOG, all: CATALOG, error: null });
    saveQuoteConfigurationAction.mockResolvedValue({});
    const app = {
      id: "app-1", quoteType: "all_in_one", quoteLines: LINES, quoteNote: null, orderPoints: null,
      analysis: null, quoteConfig: null, quoteRates: null, pricingModel: "2-tier", hubspotIds: null,
      quoteAcceptedAt: null, detailsConfirmedAt: null,
    } as unknown as MerchantApplication;

    render(<EditQuotePanel app={app} onSaved={() => {}} onCancel={() => {}} />);
    const save = await screen.findByRole("button", { name: "Save Quote" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(saveQuoteConfigurationAction).toHaveBeenCalled());
    const sent = saveQuoteConfigurationAction.mock.calls[0][0];
    expect(sent.adjustments?.["335283119838"]?.billingStart).toEqual(SIXTY);
  });
});
