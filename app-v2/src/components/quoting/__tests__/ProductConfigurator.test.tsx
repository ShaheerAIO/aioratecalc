// @vitest-environment jsdom
//
// What a NEW quote opens on, asserted against the rendered component rather
// than against the constants behind it.
//
// newQuoteDefaults.test.ts models the opening cart off the same constants
// `changeType` reads, which is the right place to pin its CONTENTS — but it
// cannot see whether the component ever applies them. That is precisely where
// this screen has gone wrong twice: once with a plan preselected that had
// never been clicked (so nothing seeded), and once with the catalog still in
// flight when the rep clicked (so there was nothing to seed from).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { CatalogProduct, QuoteAdjustments, QuoteType } from "@/types/merchant";

// Hoisted with the vi.mock call below it, because the component under test is
// imported statically further down and reaches the mock during that import.
const { listQuotableProductsAction, getQuoteLimits } = vi.hoisted(() => ({
  listQuotableProductsAction: vi.fn(),
  getQuoteLimits: vi.fn(),
}));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
vi.mock("@/lib/actions/pricing", () => ({
  getMaxDiscountPercent: () => Promise.resolve(50),
  getQuoteLimits,
}));

import ProductConfigurator, { type ProductPick } from "@/components/quoting/ProductConfigurator";
import { WIFI_PRODUCT_ID } from "@/lib/quoting";

// The live HubSpot records this path touches, at their real prices.
const P: Array<[string, string, number, CatalogProduct["billingFrequency"], string]> = [
  ["335283119838", "All-in-One Platform", 399, "monthly", "Software"],
  ["332609247965", "AIO Marketing Platform", 199, "monthly", "Software"],
  ["333275576048", "Website", 50, "monthly", "Software"],
  ["217445755632", "POS Unit", 749, "one_time", "inventory"],
  ["318736467644", "Customer Facing Display", 299, "one_time", ""],
  ["222497165009", "Kiosk 27\" + Payment Terminal (AMS1) and Mount", 999, "one_time", "inventory"],
  ["223511653105", "Payment Terminal - AMS1", 300, "one_time", "inventory"],
  ["223452690132", "KDS (Kitchen Display System)", 399, "one_time", "inventory"],
  ["223511653104", "Thermal Printer", 199, "one_time", "inventory"],
  ["222497165011", "Cash Drawer", 70, "one_time", "inventory"],
  ["223511653103", "Menu Board Computer", 99, "one_time", "inventory"],
  ["281351401209", "AIO WiFi Network Package", 999, "one_time", "inventory"],
  ["338690209525", "AIO Wifi Network Package - Unifi", 698, "one_time", "inventory"],
  ["223452690133", "Onsite Installation", 999, "one_time", "Service"],
  ["223152695032", "System Onboarding and Training", 499, "one_time", "Service"],
  ["335280960199", "Additional Software License", 19, "monthly", "Software"],
  ["276751313619", "Orders Hub Tablet", 199, "one_time", "inventory"],
  ["276754193118", "Clock in Tablet", 199, "one_time", "inventory"],
];
const CATALOG: CatalogProduct[] = P.map(([hubspotProductId, name, price, billingFrequency, productType]) => ({
  hubspotProductId, name, price, billingFrequency, productType,
}));

const POS = "217445755632";
const WEBSITE = "333275576048";

/** The prospect page, reduced to the state it owns on the configurator's behalf. */
function Host() {
  const [quoteType, setQuoteType] = useState<QuoteType | null>(null);
  const [picks, setPicks] = useState<ProductPick[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [adjustments, setAdjustments] = useState<QuoteAdjustments>({});
  return (
    <>
      <div data-testid="picks">{picks.map(p => `${p.hubspotProductId}:${p.qty}`).join(" ")}</div>
      <ProductConfigurator
        layout="document"
        quoteType={quoteType}
        picks={picks}
        channels={channels}
        adjustments={adjustments}
        onQuoteTypeChange={setQuoteType}
        onPicksChange={setPicks}
        onChannelsChange={setChannels}
        onAdjustmentsChange={setAdjustments}
        onDerivedChange={() => {}}
      />
    </>
  );
}

const picksText = () => screen.getByTestId("picks").textContent ?? "";
const planCard = (name: RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  listQuotableProductsAction.mockReset();
  listQuotableProductsAction.mockResolvedValue({ products: CATALOG, all: CATALOG, error: null });
  getQuoteLimits.mockReset();
  getQuoteLimits.mockResolvedValue({ unitCaps: {}, maxBillingDelayDays: 90, showTablets: false });
});
afterEach(cleanup);

describe("a new quote opens on no plan at all", () => {
  it("highlights nothing, picks nothing, and shows no catalog until a plan is chosen", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());

    for (const label of [/Order & Pay Only/, /All-in-One/, /Marketing Only/, /Marketing Partial Ordering/]) {
      expect(planCard(label).dataset.active).not.toBe("true");
    }
    expect(picksText()).toBe("");
    // The hardware list is a decision about a plan, so it isn't offered yet.
    expect(screen.queryByText("POS Unit")).toBeNull();
    expect(screen.getByText(/Pick a plan to start/)).toBeTruthy();
  });

  it("seeds the plan's cart on the click that chooses it — no second click", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());

    fireEvent.click(planCard(/All-in-One/));

    await waitFor(() => expect(picksText()).toContain(`${POS}:1`));
    // The Website is part of All-in-One, and the POS brings its terminal.
    expect(picksText()).toContain(`${WEBSITE}:1`);
    expect(picksText()).toContain("223511653105:");
    expect(planCard(/All-in-One/).dataset.active).toBe("true");
  });

  it("lists the WiFi package as an ordinary hardware row for All-in-One, preselected by the kit", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    fireEvent.click(planCard(/All-in-One/));

    // 2026-10-21: the network package is a picker row like the KDS, not a derived line.
    await waitFor(() => expect(picksText()).toContain(`${WIFI_PRODUCT_ID}:1`));
    expect(screen.getAllByText(/Wifi Network Package - Unifi/i).length).toBeGreaterThan(0);
    // No remove / add-back machinery any more.
    expect(screen.queryByText(/Remove the WiFi package\?/)).toBeNull();
    expect(screen.queryByText(/Not on this quote/)).toBeNull();
  });

  it("still seeds when the plan is clicked before the catalog lands", async () => {
    let resolveCatalog: (value: unknown) => void = () => {};
    listQuotableProductsAction.mockReturnValue(
      new Promise(resolve => { resolveCatalog = resolve; })
    );
    render(<Host />);

    // The rep is faster than HubSpot. Nothing to seed from yet.
    fireEvent.click(planCard(/All-in-One/));
    expect(picksText()).toBe("");

    resolveCatalog({ products: CATALOG, all: CATALOG, error: null });
    await waitFor(() => expect(picksText()).toContain(`${POS}:1`));
  });

  it("switching plans re-seeds from the new one, carrying nothing across", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());

    fireEvent.click(planCard(/All-in-One/));
    await waitFor(() => expect(picksText()).toContain(`${POS}:1`));

    fireEvent.click(planCard(/Marketing Only/));
    // Three Menu Board Computers, and none of the POS plan's hardware.
    await waitFor(() => expect(picksText()).toBe("223511653103:3"));
  });
});

// ── The tablets an admin can switch off ─────────────────────────────────────
// Visibility, not a rule about what may be sold: nothing downstream refuses a
// tablet, which is why these assert the PICKER rather than the blockers.
describe("tablet visibility", () => {
  // The picker's own stepper, so a tablet sitting in the RECEIPT can't stand
  // in for a row the rep could actually change.
  const pickerRow = (name: string) => screen.queryByRole("button", { name: `Add one ${name}` });
  const pickTablet = () => pickerRow("Orders Hub Tablet");

  it("leaves them out of the picker by default", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    fireEvent.click(planCard(/All-in-One/));

    await waitFor(() => expect(picksText()).toContain(`${POS}:1`));
    expect(pickTablet()).toBeNull();
    // The products either side of them are untouched.
    expect(pickerRow("Thermal Printer")).not.toBeNull();
  });

  it("offers them once an admin switches them on", async () => {
    getQuoteLimits.mockResolvedValue({ unitCaps: {}, maxBillingDelayDays: 90, showTablets: true });
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    fireEvent.click(planCard(/All-in-One/));

    await waitFor(() => expect(pickTablet()).not.toBeNull());
  });

  it("keeps showing one that is already on the quote", async () => {
    // A rep mid-quote when the switch flips must not be left looking at a
    // price with no row to change it on.
    render(
      <ProductConfigurator
        layout="document"
        quoteType="all_in_one"
        picks={[{ hubspotProductId: "276751313619", qty: 2 }]}
        channels={[]}
        adjustments={{}}
        onQuoteTypeChange={() => {}}
        onPicksChange={() => {}}
        onChannelsChange={() => {}}
        onAdjustmentsChange={() => {}}
        onDerivedChange={() => {}}
      />
    );
    await waitFor(() => expect(pickTablet()).not.toBeNull());
    // The other one is still hidden: it is on nobody's quote.
    expect(pickerRow("Clock in Tablet")).toBeNull();
  });
});

// ── The note a long billing delay has to carry ──────────────────────────────
describe("the quote note", () => {
  const withDelay = (days: number, note: string) => (
    <ProductConfigurator
      layout="document"
      quoteType="all_in_one"
      picks={[{ hubspotProductId: POS, qty: 1 }]}
      channels={[]}
      adjustments={{ "335283119838": { billingStart: { mode: "days", days } } }}
      note={note}
      onNoteChange={() => {}}
      onQuoteTypeChange={() => {}}
      onPicksChange={() => {}}
      onChannelsChange={() => {}}
      onAdjustmentsChange={() => {}}
      onDerivedChange={() => {}}
    />
  );

  it("asks for a reason, naming the delay, once past the plan's own 60 days", async () => {
    render(withDelay(90, ""));
    await waitFor(() => expect(screen.getByText(/Why billing starts after 90 days/)).toBeTruthy());
    expect(screen.getByText(/Elizabeth Phillips/)).toBeTruthy();
  });

  it("is an optional box at the delay the plan itself seeds", async () => {
    render(withDelay(60, ""));
    await waitFor(() => expect(screen.getByText("Note (optional)")).toBeTruthy());
  });
});
