// @vitest-environment jsdom
//
// "Use standard rates" on New Prospect (product owner, 2026-11-11: "Allow a
// user to select a button for standard rates (this can be used for a new
// restaurant that doesn't have any volume yet)"). Pressing it puts the page in
// standard-rates mode: the flat card is applied and the monthly volume and
// average ticket (REQUIRED on a processing quote since 2026-10-18) may be left
// blank. Typing over a rate, or entering both figures, leaves the mode.
//
// The configurator and the merchant form are stubbed: this is about the
// page's own gate and what it sends, not about quote derivation.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BusinessInfo } from "@/types/merchant";

const { createProspectAction, openProspectFromDealAction, getSuggestedRatesAction } = vi.hoisted(() => ({
  createProspectAction: vi.fn(),
  openProspectFromDealAction: vi.fn(),
  getSuggestedRatesAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("hubspotDealId=deal-1") }));
vi.mock("@/lib/actions/prospects", () => ({ createProspectAction, openProspectFromDealAction }));
vi.mock("@/lib/actions/pricing", () => ({
  getMyRoleAction: () => Promise.resolve("rep"),
  getPricingPreviewAction: () => Promise.resolve({
    belowMarginFloor: false, appliedTargetMargin: 0.008, projectedCommission: { total: null },
    monthlyProcessingRevenue: 500, processingArr: 6000, belowMonthlyRevenueFloor: false,
  }),
}));
vi.mock("@/lib/actions/rateMatrix", () => ({
  getCnpPolicyRateAction: () => Promise.resolve(0.033),
  getSuggestedRatesAction,
}));

const POS_LINE = {
  hubspotProductId: "217445755632", name: "POS Unit", qty: 1, unitPrice: 949,
  billingFrequency: "one_time", productType: "inventory",
};
vi.mock("@/components/quoting/ProductConfigurator", () => ({
  default: (props: {
    onQuoteTypeChange: (t: string) => void;
    onPicksChange: (p: unknown[]) => void;
    onDerivedChange: (q: unknown) => void;
    buildSlot?: ReactNode; documentRate?: ReactNode; documentFooter?: ReactNode;
  }) => (
    <div>
      <button type="button" onClick={() => {
        props.onQuoteTypeChange("all_in_one");
        props.onPicksChange([{ hubspotProductId: POS_LINE.hubspotProductId, qty: 1 }]);
        props.onDerivedChange({ quoteLines: [POS_LINE], blockers: [], overrides: [] });
      }}>Pick plan</button>
      {props.buildSlot}
      {props.documentRate}
      {props.documentFooter}
    </div>
  ),
}));
vi.mock("@/components/rep/MerchantDetailsForm", () => ({
  default: (props: { business: BusinessInfo; onBusinessChange: (b: BusinessInfo) => void }) => (
    <button type="button" onClick={() => props.onBusinessChange({ ...props.business, legalName: "Torta Palace LLC" })}>
      Set legal name
    </button>
  ),
}));

import NewProspectPage from "@/app/rep/prospects/new/page";

const VOLUME_BLOCK = /Enter the monthly volume and average ticket/;
const createButton = () => screen.getByRole("button", { name: /Create (Quote )?Link/ }) as HTMLButtonElement;
const standardButton = () => screen.getByRole("button", { name: "Use standard rates" }) as HTMLButtonElement;
const cpBox = () => screen.getByLabelText("Card present rate, percent") as HTMLInputElement;

async function openProcessingQuote() {
  render(<NewProspectPage />);
  await waitFor(() => expect(openProspectFromDealAction).toHaveBeenCalled());
  await screen.findByText(/HubSpot deal · Torta Palace/);
  fireEvent.click(screen.getByRole("button", { name: "Pick plan" }));
  fireEvent.click(screen.getByRole("button", { name: "Set legal name" }));
  fireEvent.change(screen.getByLabelText("Send to"), { target: { value: "ana@tortapalace.com" } });
}

beforeEach(() => {
  openProspectFromDealAction.mockResolvedValue({
    ok: true,
    deal: { id: "deal-1", name: "Torta Palace / Deal - 1", stageLabel: "Discovery" },
    company: { id: "c-1", name: "Torta Palace" },
    contacts: [], selectedContactId: null, prefill: null,
  });
  createProspectAction.mockResolvedValue({
    linkUrl: "https://easyob.test/lead/abc", quoteStatus: null,
    emailResult: { sent: true }, smsResult: null, companySync: { synced: true },
  });
  getSuggestedRatesAction.mockResolvedValue({
    rates: {
      cardPresentRate: 0.0217, amexCardPresentRate: 0.0217,
      cardNotPresentRate: 0.033, amexCardNotPresentRate: 0.033, perTransactionFee: 0.15,
    },
    volumeBand: "$75K – $100K", ticketColumn: 30, adjustBpsRange: { min: -12, max: 20 },
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("New Prospect — Use standard rates", () => {
  it("still requires a volume and ticket on a processing quote until the button is pressed", async () => {
    await openProcessingQuote();
    expect(screen.getByText(VOLUME_BLOCK)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it("sends a standard-rate quote with no volume: flat card, no quoteConfig, standardRates flagged", async () => {
    await openProcessingQuote();
    await waitFor(() => expect(standardButton().disabled).toBe(false));
    fireEvent.click(standardButton());

    expect(screen.queryByText(VOLUME_BLOCK)).toBeNull();
    expect(screen.getByTestId("basis-note").textContent).toMatch(/Standard rates/);
    // No volume, so no approval is asked for merely for lacking one.
    await waitFor(() => expect(createButton().disabled).toBe(false));
    fireEvent.click(createButton());

    await waitFor(() => expect(createProspectAction).toHaveBeenCalledTimes(1));
    const sent = createProspectAction.mock.calls[0][0];
    expect(sent.standardRates).toBe(true);
    expect(sent.quoteConfig).toBeNull();
    expect(sent.quoteRates).toEqual({
      cardPresentRate: 0.0249, amexCardPresentRate: 0.0249,
      cardNotPresentRate: 0.033, amexCardNotPresentRate: 0.033, perTransactionFee: 0.15,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves the mode when the rep types over the rate: the volume is required again", async () => {
    await openProcessingQuote();
    await waitFor(() => expect(standardButton().disabled).toBe(false));
    fireEvent.click(standardButton());
    expect(screen.queryByText(VOLUME_BLOCK)).toBeNull();

    fireEvent.change(cpBox(), { target: { value: "2.60" } });
    fireEvent.blur(cpBox());
    expect(screen.getByText(VOLUME_BLOCK)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it("leaves the mode once both a volume and a ticket are entered: the rate card prices it", async () => {
    await openProcessingQuote();
    await waitFor(() => expect(standardButton().disabled).toBe(false));
    fireEvent.click(standardButton());

    fireEvent.change(screen.getByLabelText("Monthly card volume, dollars"), { target: { value: "80000" } });
    expect(screen.getByTestId("basis-note").textContent).toMatch(/Standard rates/);
    fireEvent.change(screen.getByLabelText("Average ticket, dollars"), { target: { value: "25" } });

    await waitFor(() => expect(getSuggestedRatesAction).toHaveBeenCalledWith({ monthlyVolume: 80000, avgTicket: 25 }));
    await waitFor(() => expect(cpBox().value).toBe("2.17"));
    expect(screen.getByTestId("basis-note").textContent).not.toMatch(/Standard rates/);
  });
});
