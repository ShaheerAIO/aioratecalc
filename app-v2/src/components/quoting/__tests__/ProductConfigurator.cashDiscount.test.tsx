// @vitest-environment jsdom
//
// The cash discount — its OWN lever, in dollars, since 2026-10-14.
//
// It was built the other way first: the dollars were converted to a
// percentage, on the belief that `hs_discount_percentage` was the only
// discount HubSpot would take. It isn't. The line-item `discount` property is
// a cash amount, and the conversion meant a figure a rep typed could not be
// billed — $100 off a $749 line became 13.4% and charged $100.37. These tests
// exist mostly to pin the thing that fixed: dollars in, the SAME dollars out,
// at every quantity, with nothing rounded in between.
//
// `discount` is PER UNIT in HubSpot (scripts/probe-cash-discount.ts), so the
// division happens once at the boundary — asserted in quoteDiscounts.test.ts
// against `toLineItemProperties`, not here.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { PACKAGES } from "@/lib/quotePackages";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { CatalogProduct, QuoteAdjustments, QuoteType } from "@/types/merchant";

const { listQuotableProductsAction, getQuoteLimits } = vi.hoisted(() => ({
  listQuotableProductsAction: vi.fn(),
  getQuoteLimits: vi.fn(),
}));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
vi.mock("@/lib/actions/pricing", () => ({
  // Deliberately 100, not the usual 50: these tests are about the arithmetic,
  // and a cap would refuse the larger figures before the conversion is visible.
  getMaxDiscountPercent: () => Promise.resolve(100),
  getQuoteLimits,
}));

import ProductConfigurator, { type ProductPick } from "@/components/quoting/ProductConfigurator";

// The free hardware kit is off for this file: it covers the POS at 100%,
// and a package-covered line carries no adjust control at all (nothing to
// discount — the package price already bought it). These tests are about
// the arithmetic on a line a rep CAN discount.
beforeAll(() => { for (const pkg of PACKAGES) pkg.active = false; });

const POS = "217445755632";
const P: Array<[string, string, number, CatalogProduct["billingFrequency"], string]> = [
  ["335283119838", "All-in-One Platform", 399, "monthly", "Software"],
  [POS, "POS Unit", 749, "one_time", "inventory"],
  ["223511653105", "Payment Terminal - AMS1", 300, "one_time", "inventory"],
  ["338690209525", "AIO Wifi Network Package - Unifi", 698, "one_time", "inventory"],
  ["223452690133", "Onsite Installation", 999, "one_time", "Service"],
  ["223152695032", "System Onboarding and Training", 499, "one_time", "Service"],
  ["281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"],
  ["260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"],
];
const CATALOG: CatalogProduct[] = P.map(([hubspotProductId, name, price, billingFrequency, productType]) => ({
  hubspotProductId, name, price, billingFrequency, productType,
}));

function Host({ qty }: { qty: number }) {
  const [quoteType] = useState<QuoteType | null>("all_in_one");
  const [picks, setPicks] = useState<ProductPick[]>([{ hubspotProductId: POS, qty }]);
  const [channels, setChannels] = useState<string[]>([]);
  const [adjustments, setAdjustments] = useState<QuoteAdjustments>({});
  return (
    <>
      <div data-testid="adj">{JSON.stringify(adjustments)}</div>
      <ProductConfigurator
        layout="document"
        quoteType={quoteType}
        picks={picks}
        channels={channels}
        adjustments={adjustments}
        onQuoteTypeChange={() => {}}
        onPicksChange={setPicks}
        onChannelsChange={setChannels}
        onAdjustmentsChange={setAdjustments}
        onDerivedChange={() => {}}
      />
    </>
  );
}

const storedPercent = () =>
  (JSON.parse(screen.getByTestId("adj").textContent || "{}") as QuoteAdjustments)[POS]?.discountPercent;

/** Opens the POS line's adjust drawer and returns its two discount inputs. */
async function openPosDrawer() {
  const amountField = await screen.findByLabelText("Discount amount in dollars for POS Unit");
  return {
    amount: amountField as HTMLInputElement,
    percent: screen.getByLabelText("Discount percent for POS Unit") as HTMLInputElement,
  };
}

beforeEach(() => {
  listQuotableProductsAction.mockReset();
  listQuotableProductsAction.mockResolvedValue({ products: CATALOG, all: CATALOG, error: null });
  getQuoteLimits.mockReset();
  getQuoteLimits.mockResolvedValue({ unitCaps: {}, maxBillingDelayDays: 90, showTablets: false });
});
afterEach(cleanup);

describe("a discount typed in dollars", () => {
  const openAdjust = async () => {
    const toggles = await screen.findAllByRole("button", { name: /Adjust/ });
    for (const t of toggles) fireEvent.click(t);
  };

  const storedAmount = () =>
    (JSON.parse(screen.getByTestId("adj").textContent || "{}") as QuoteAdjustments)[POS]?.discountAmount;

  it("stores the dollars as dollars, and bills exactly them", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount, percent } = await openPosDrawer();

    fireEvent.change(amount, { target: { value: "100" } });
    await waitFor(() => expect(storedAmount()).toBe(100));
    // No percentage anywhere — this is the whole point. The old build turned
    // $100 into 13.4% and charged $100.37.
    expect(storedPercent()).toBeUndefined();
    // The box holds what the rep typed, rather than settling to a conversion.
    expect(Number(amount.value)).toBe(100);
    // And the percent box is empty: the line is on the other lever.
    expect(percent.value).toBe("");
    // $749 − $100.
    await waitFor(() => {
      expect(screen.getAllByText((_, el) => el?.textContent === "1 × $749.00 → $649.00").length)
        .toBeGreaterThan(0);
    });
  });

  it("is the LINE total, not per unit — the figure a rep says out loud", async () => {
    render(<Host qty={3} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount } = await openPosDrawer();

    fireEvent.change(amount, { target: { value: "747" } });
    await waitFor(() => expect(storedAmount()).toBe(747));
    // 3 × $749 = $2,247, less $747, is $1,500.00 exactly — the figure the
    // percentage build could only get to $1,501.00.
    await waitFor(() => {
      expect(screen.getAllByText((_, el) => el?.textContent === "3 × $749.00 → $1,500.00").length)
        .toBeGreaterThan(0);
    });
  });

  it("is exact at a quantity that does not divide evenly", async () => {
    // $100 across 3 units is $33.333... each, and this is where a per-unit
    // design rounds. It is stored as the line total and divided once, at the
    // HubSpot boundary, so nothing rounds here at all.
    render(<Host qty={3} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount } = await openPosDrawer();

    fireEvent.change(amount, { target: { value: "100" } });
    await waitFor(() => expect(storedAmount()).toBe(100));
    await waitFor(() => {
      expect(screen.getAllByText((_, el) => el?.textContent === "3 × $749.00 → $2,147.00").length)
        .toBeGreaterThan(0);
    });
  });

  it("holds cents", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount } = await openPosDrawer();

    fireEvent.change(amount, { target: { value: "12.34" } });
    await waitFor(() => expect(storedAmount()).toBe(12.34));
  });

  it("clears the discount when the box is emptied", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount } = await openPosDrawer();

    fireEvent.change(amount, { target: { value: "100" } });
    await waitFor(() => expect(storedAmount()).toBe(100));
    fireEvent.change(amount, { target: { value: "" } });
    await waitFor(() => expect(storedAmount()).toBeUndefined());
  });
});

describe("the two levers are mutually exclusive", () => {
  const openAdjust = async () => {
    const toggles = await screen.findAllByRole("button", { name: /Adjust/ });
    for (const t of toggles) fireEvent.click(t);
  };
  const storedAmount = () =>
    (JSON.parse(screen.getByTestId("adj").textContent || "{}") as QuoteAdjustments)[POS]?.discountAmount;

  it("typing a percent abandons a cash discount already on the line", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount, percent } = await openPosDrawer();

    fireEvent.change(amount, { target: { value: "100" } });
    await waitFor(() => expect(storedAmount()).toBe(100));

    fireEvent.change(percent, { target: { value: "20" } });
    await waitFor(() => expect(storedPercent()).toBe(20));
    // A line carrying both would bill one figure and display the other.
    expect(storedAmount()).toBeUndefined();
    await waitFor(() => expect(Number(amount.value) || 0).toBe(0));
  });

  it("typing a cash amount abandons a percentage already on the line", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount, percent } = await openPosDrawer();

    fireEvent.change(percent, { target: { value: "20" } });
    await waitFor(() => expect(storedPercent()).toBe(20));

    fireEvent.change(amount, { target: { value: "100" } });
    await waitFor(() => expect(storedAmount()).toBe(100));
    expect(storedPercent()).toBeUndefined();
    expect(percent.value).toBe("");
  });
});

describe("the percentage lever still rounds to one decimal", () => {
  const openAdjust = async () => {
    const toggles = await screen.findAllByRole("button", { name: /Adjust/ });
    for (const t of toggles) fireEvent.click(t);
  };

  it("rounds a hand-typed percent", async () => {
    // Kept from the percentage-only build. It costs nothing now: a rep who
    // wants an exact PRICE types dollars, so the percent box is only ever
    // for a figure someone chose ("20% off").
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { percent } = await openPosDrawer();

    fireEvent.change(percent, { target: { value: "33.25" } });
    await waitFor(() => expect(storedPercent()).toBe(33.3));
  });

  it("still clamps a percent over 100", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { percent } = await openPosDrawer();

    fireEvent.change(percent, { target: { value: "150" } });
    await waitFor(() => expect(storedPercent()).toBe(100));
  });
});
