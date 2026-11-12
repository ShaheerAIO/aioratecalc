// @vitest-environment jsdom
//
// The "Standard rates" toggle on New Prospect (product owner, 2026-11-11:
// "Allow a user to select a button for standard rates (this can be used for a
// new restaurant that doesn't have any volume yet)", then "if the button is
// clicked the entry boxes for volume and size should be hidden away. if
// unclicked it should clear the old rate"). ON applies the flat card, hides
// and empties the volume and ticket (REQUIRED on a processing quote since
// 2026-10-18) and waives them. OFF clears it back to the fresh-form rate and
// shows the empty boxes again. Typing over a rate while on turns it off.
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
const STANDARD = {
  cardPresentRate: 0.0249, amexCardPresentRate: 0.0249,
  cardNotPresentRate: 0.033, amexCardNotPresentRate: 0.033, perTransactionFee: 0.15,
};
const createButton = () => screen.getByRole("button", { name: /Create (Quote )?Link/ }) as HTMLButtonElement;
const toggle = () => screen.getByRole("button", { name: "Standard rates" }) as HTMLButtonElement;
const cpBox = () => screen.getByLabelText("Card present rate, percent") as HTMLInputElement;
const volumeBox = () => screen.queryByLabelText("Monthly card volume, dollars") as HTMLInputElement | null;
const ticketBox = () => screen.queryByLabelText("Average ticket, dollars") as HTMLInputElement | null;

async function openProcessingQuote() {
  render(<NewProspectPage />);
  await waitFor(() => expect(openProspectFromDealAction).toHaveBeenCalled());
  await screen.findByText(/HubSpot deal · Torta Palace/);
  fireEvent.click(screen.getByRole("button", { name: "Pick plan" }));
  fireEvent.click(screen.getByRole("button", { name: "Set legal name" }));
  fireEvent.change(screen.getByLabelText("Send to"), { target: { value: "ana@tortapalace.com" } });
}

/** Volume and ticket entered, and the rate card's 2.17% applied over them. */
async function priceOffTheCard() {
  fireEvent.change(volumeBox()!, { target: { value: "80000" } });
  fireEvent.change(ticketBox()!, { target: { value: "25" } });
  await waitFor(() => expect(cpBox().value).toBe("2.17"));
}

async function turnOn() {
  await waitFor(() => expect(toggle().disabled).toBe(false));
  fireEvent.click(toggle());
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
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

describe("New Prospect — Standard rates toggle", () => {
  it("still requires a volume and ticket on a processing quote while it is off", async () => {
    await openProcessingQuote();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(volumeBox()).toBeTruthy();
    expect(screen.getByText(VOLUME_BLOCK)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it("ON over a rate-card price: applies the flat card and hides and empties the volume and ticket", async () => {
    await openProcessingQuote();
    await priceOffTheCard();
    await turnOn();

    expect(volumeBox()).toBeNull();
    expect(ticketBox()).toBeNull();
    expect(cpBox().value).toBe("2.49");
    expect((screen.getByLabelText(/Card not present rate, percent/) as HTMLInputElement).value).toBe("3.30");
    expect(screen.queryByText(VOLUME_BLOCK)).toBeNull();
    expect(screen.getByTestId("basis-note").textContent).toMatch(/Standard rates/);
    // And it stays 2.49%: the rate card doesn't come back over it.
    await new Promise(r => setTimeout(r, 400));
    expect(cpBox().value).toBe("2.49");
    expect(screen.queryByTestId("rate-outside-limits")).toBeNull();
  });

  it("sends a standard-rate quote with no volume: flat card, no quoteConfig, no volume, standardRates flagged", async () => {
    await openProcessingQuote();
    await priceOffTheCard();
    await turnOn();
    await waitFor(() => expect(createButton().disabled).toBe(false));
    fireEvent.click(createButton());

    await waitFor(() => expect(createProspectAction).toHaveBeenCalledTimes(1));
    const sent = createProspectAction.mock.calls[0][0];
    expect(sent.standardRates).toBe(true);
    expect(sent.quoteConfig).toBeNull();
    expect(sent.processing.monthlyVolume).toBe("");
    expect(sent.processing.avgTicket).toBe("");
    expect(sent.quoteRates).toEqual(STANDARD);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("OFF clears the standard rate back to the unpriced start and shows the empty boxes again", async () => {
    await openProcessingQuote();
    await turnOn();
    fireEvent.click(toggle());

    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(volumeBox()!.value).toBe("");
    expect(ticketBox()!.value).toBe("");
    expect(screen.getByText(VOLUME_BLOCK)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
    // The rate card prices it again once both are entered.
    await priceOffTheCard();
    expect(screen.queryByText(VOLUME_BLOCK)).toBeNull();
  });

  it("typing over a rate while on turns it off and keeps the typed rate", async () => {
    await openProcessingQuote();
    await turnOn();

    fireEvent.change(cpBox(), { target: { value: "2.60" } });
    fireEvent.blur(cpBox());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(cpBox().value).toBe("2.60");
    expect(volumeBox()).toBeTruthy();
    expect(screen.getByText(VOLUME_BLOCK)).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });
});
