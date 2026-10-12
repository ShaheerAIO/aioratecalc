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
const { listQuotableProductsAction } = vi.hoisted(() => ({ listQuotableProductsAction: vi.fn() }));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
vi.mock("@/lib/actions/pricing", () => ({
  getMaxDiscountPercent: () => Promise.resolve(50),
  getQuoteLimits: () => Promise.resolve({ unitCaps: {}, maxBillingDelayDays: 90 }),
}));

import ProductConfigurator, { type ProductPick } from "@/components/quoting/ProductConfigurator";

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
  ["223452690133", "Onsite Installation", 999, "one_time", "Service"],
  ["223152695032", "System Onboarding and Training", 499, "one_time", "Service"],
  ["335280960199", "Additional Software License", 19, "monthly", "Software"],
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
});
afterEach(cleanup);

describe("a new quote opens on no plan at all", () => {
  it("highlights nothing, picks nothing, and shows no catalog until a plan is chosen", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());

    for (const label of [/Order & Pay Only/, /All-in-One/, /Marketing Only/, /Marketing — 2-Year/]) {
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
