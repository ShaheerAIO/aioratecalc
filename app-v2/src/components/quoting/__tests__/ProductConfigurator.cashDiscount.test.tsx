// @vitest-environment jsdom
//
// The cash discount (product owner, 2026-10-14: "add a cash discount option
// for each line item ... just do that math to see what percent discount u
// would need to have to achieve the desired price and fill that").
//
// It stores NOTHING of its own. `discountPercent` stays the only lever on a
// line, because it is the only one that reaches HubSpot
// (`hs_discount_percentage`) — so these tests assert the conversion, and that
// what the rep is SHOWN is the real net rather than the dollars they typed. A
// percentage can't always land exactly on a dollar figure, and the document
// it lands on can't be amended once published.
//
// Every percent is rounded to ONE DECIMAL (product owner, 2026-10-14), which
// makes that gap the normal case rather than an edge one: $747 off a $2,247
// line is 33.244326%, stored as 33.2%, which bills $1,501.00 and not the
// $1,500.00 the rep typed toward. These tests pin the real figures on
// purpose — if the rounding ever changes, the numbers that move are the ones
// a merchant is charged.
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
  // Every line on the quote has one of these and they are not individually
  // labelled, so all of them are opened and the POS drawer is then found by
  // its inputs' own labels.
  const openAdjust = async () => {
    const toggles = await screen.findAllByRole("button", { name: /Adjust/ });
    for (const t of toggles) fireEvent.click(t);
  };

  it("back-fills the percent that reaches that figure, and stores only the percent", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount, percent } = await openPosDrawer();

    // $100 off a $749 unit is 13.351135%, held at one decimal.
    fireEvent.change(amount, { target: { value: "100" } });
    await waitFor(() => expect(storedPercent()).toBe(13.4));
    // The percent box shows what was derived — the two are one number.
    expect(Number(percent.value)).toBe(13.4);
    // And so does the DOLLAR box, which is why a rep who types 100 sees
    // 100.37 settle in: 13.4% of $749 is what the quote actually takes off.
    // Surprising, and the honest reading of one decimal place — the
    // alternative is storing the typed dollars as a second lever.
    expect(Number(amount.value)).toBeCloseTo(100.37, 2);
    // And nothing of its own was persisted: no discountAmount field exists.
    const adj = JSON.parse(screen.getByTestId("adj").textContent || "{}")[POS];
    expect(Object.keys(adj)).toEqual(["discountPercent"]);
  });

  it("counts the WHOLE line, not one unit", async () => {
    render(<Host qty={3} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount } = await openPosDrawer();

    // $747 off 3 × $749 = $2,247 is 33.244326%, held at 33.2%.
    fireEvent.change(amount, { target: { value: "747" } });
    await waitFor(() => expect(storedPercent()).toBe(33.2));
  });

  it("clamps to the line — a rep cannot give away more than the line is worth", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount } = await openPosDrawer();

    fireEvent.change(amount, { target: { value: "5000" } });
    await waitFor(() => expect(storedPercent()).toBe(100));
  });

  it("clears the discount when the box is emptied", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount } = await openPosDrawer();

    fireEvent.change(amount, { target: { value: "100" } });
    await waitFor(() => expect(storedPercent()).toBe(13.4));
    fireEvent.change(amount, { target: { value: "" } });
    await waitFor(() => expect(storedPercent()).toBeUndefined());
  });

  it("shows the REAL net, so a figure a percentage can't reach exactly is visible", async () => {
    render(<Host qty={3} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount } = await openPosDrawer();

    fireEvent.change(amount, { target: { value: "747" } });
    // 33.2% of $2,247 leaves $1,501.00 — a dollar off what the rep typed
    // toward, and stated rather than hidden. This is the whole reason the
    // result line exists.
    await waitFor(() => {
      expect(screen.getAllByText((_, el) => el?.textContent === "3 × $749.00 → $1,501.00").length)
        .toBeGreaterThan(0);
    });
  });

  it("round-trips a percent typed by hand back into dollars", async () => {
    render(<Host qty={2} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { amount, percent } = await openPosDrawer();

    // 25% of 2 × $749 = $374.50.
    fireEvent.change(percent, { target: { value: "25" } });
    await waitFor(() => expect(Number(amount.value)).toBeCloseTo(374.5, 2));
  });
});

describe("one decimal place, everywhere a percent is set", () => {
  const openAdjust = async () => {
    const toggles = await screen.findAllByRole("button", { name: /Adjust/ });
    for (const t of toggles) fireEvent.click(t);
  };

  it("rounds a percent typed by HAND too, not just a derived one", async () => {
    // Otherwise 33.25 typed in the percent box would outlive anything the
    // dollar box could produce, and "one decimal" would be true of one
    // entry path rather than of the line.
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { percent } = await openPosDrawer();

    fireEvent.change(percent, { target: { value: "33.25" } });
    await waitFor(() => expect(storedPercent()).toBe(33.3));
  });

  it("still clamps over 100 before rounding", async () => {
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { percent } = await openPosDrawer();

    fireEvent.change(percent, { target: { value: "150" } });
    await waitFor(() => expect(storedPercent()).toBe(100));
  });

  it("treats a figure under a twentieth of a percent as no discount at all", async () => {
    // 0.04% rounds to 0, and 0 has always cleared the adjustment rather than
    // being stored — nobody means a four-hundredth of the price.
    render(<Host qty={1} />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await openAdjust();
    const { percent } = await openPosDrawer();

    fireEvent.change(percent, { target: { value: "0.04" } });
    await waitFor(() => expect(storedPercent()).toBeUndefined());
  });
});
