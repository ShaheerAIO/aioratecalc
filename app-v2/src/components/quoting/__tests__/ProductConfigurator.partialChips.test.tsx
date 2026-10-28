// @vitest-environment jsdom
//
// The two builder controls the product owner asked for on 2026-10-28:
//  - Marketing Partial Ordering's Kiosk / Online Ordering / Marketing chips,
//    with the "Marketing (Partial Ordering)" row hidden from the list;
//  - "Charge for kiosk" on the QSR Kit's free kiosk.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { CatalogProduct, QuoteAdjustments, QuoteType } from "@/types/merchant";

const { listQuotableProductsAction } = vi.hoisted(() => ({ listQuotableProductsAction: vi.fn() }));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
vi.mock("@/lib/actions/pricing", () => ({
  getMaxDiscountPercent: () => Promise.resolve(50),
  getQuoteLimits: () => Promise.resolve({ unitCaps: {}, maxBillingDelayDays: 90, showTablets: false }),
}));

import ProductConfigurator, { type ProductPick } from "@/components/quoting/ProductConfigurator";

const P: Array<[string, string, number, CatalogProduct["billingFrequency"], string]> = [
  ["335279520445", "All-in-One (Order & Pay only)", 299, "monthly", ""],
  ["335283119838", "All-in-One Platform", 399, "monthly", "Software"],
  ["343582047937", "AIO Marketing Partial Ordering", 299, "monthly", "Software"],
  ["343374665412", "Online Ordering", 0, "monthly", "Software"],
  ["343579168455", "Marketing (Partial Ordering)", 0, "monthly", ""],
  ["333275576048", "Website", 50, "monthly", "Software"],
  ["217445755632", "POS Unit", 749, "one_time", "inventory"],
  ["318736467644", "Customer Facing Display", 299, "one_time", ""],
  ["222497165009", "Kiosk 27\" + Payment Terminal (AMS1) and Mount", 999, "one_time", "inventory"],
  ["223511653105", "Payment Terminal - AMS1", 300, "one_time", "inventory"],
  ["223452690132", "KDS (Kitchen Display System)", 399, "one_time", "inventory"],
  ["223511653104", "Thermal Printer", 199, "one_time", "inventory"],
  ["222497165011", "Cash Drawer", 70, "one_time", "inventory"],
  ["223511653103", "Menu Board Computer", 99, "one_time", "inventory"],
  ["338690209525", "AIO Wifi Network Package - Unifi", 698, "one_time", "inventory"],
  ["223452690133", "Onsite Installation", 999, "one_time", "Service"],
  ["223152695032", "System Onboarding and Training", 499, "one_time", "Service"],
  ["276751313619", "Orders Hub Tablet", 199, "one_time", "inventory"],
];
const CATALOG: CatalogProduct[] = P.map(([hubspotProductId, name, price, billingFrequency, productType]) => ({
  hubspotProductId, name, price, billingFrequency, productType,
}));

const KIOSK = "222497165009";
const ONLINE = "343374665412";
const MARKETING = "343579168455";
const BOARD = "223511653103";

function Host({ initialType = null, initialPicks = [] }: { initialType?: QuoteType | null; initialPicks?: ProductPick[] }) {
  const [quoteType, setQuoteType] = useState<QuoteType | null>(initialType);
  const [picks, setPicks] = useState<ProductPick[]>(initialPicks);
  const [channels, setChannels] = useState<string[]>([]);
  const [adjustments, setAdjustments] = useState<QuoteAdjustments>({});
  return (
    <>
      <div data-testid="picks">{picks.map(p => `${p.hubspotProductId}:${p.qty}`).join(" ")}</div>
      <div data-testid="adjustments">{JSON.stringify(adjustments)}</div>
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
const chip = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  listQuotableProductsAction.mockReset();
  listQuotableProductsAction.mockResolvedValue({ products: CATALOG, all: CATALOG, error: null });
});
afterEach(cleanup);

describe("Marketing Partial Ordering chips", () => {
  it("toggles the picks behind each chip, and the marketing line has no row of its own", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Marketing Partial Ordering/ }));
    await waitFor(() => expect(chip("Kiosk")).toBeTruthy());

    // Hidden from the list; Online Ordering keeps its row.
    expect(screen.queryByText("Marketing (Partial Ordering)")).toBeNull();
    expect(screen.getByRole("button", { name: "Add one Online Ordering" })).toBeTruthy();
    for (const name of ["Kiosk", "Online Ordering", "Marketing"]) {
      expect(chip(name).getAttribute("aria-pressed"), name).toBe("false");
    }

    fireEvent.click(chip("Kiosk"));
    await waitFor(() => expect(picksText()).toContain(`${KIOSK}:1`));
    expect(chip("Kiosk").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip("Online Ordering"));
    await waitFor(() => expect(picksText()).toContain(`${ONLINE}:1`));

    fireEvent.click(chip("Marketing"));
    await waitFor(() => expect(picksText()).toContain(`${MARKETING}:1`));
    expect(picksText()).toContain(`${BOARD}:3`);
    expect(chip("Marketing").getAttribute("aria-pressed")).toBe("true");
    // Still hidden from the list once it is on the quote.
    expect(screen.queryByRole("button", { name: "Add one Marketing (Partial Ordering)" })).toBeNull();

    fireEvent.click(chip("Marketing"));
    await waitFor(() => expect(picksText()).not.toContain(MARKETING));
    expect(picksText()).not.toContain(BOARD);

    fireEvent.click(chip("Kiosk"));
    await waitFor(() => expect(picksText()).not.toContain(KIOSK));
    expect(picksText()).toContain(`${ONLINE}:1`);
  });

  it("lights from the picks a reopened quote arrives with", async () => {
    render(<Host initialType="marketing_partial" initialPicks={[{ hubspotProductId: MARKETING, qty: 1 }]} />);
    await waitFor(() => expect(chip("Marketing").getAttribute("aria-pressed")).toBe("true"));
    expect(chip("Kiosk").getAttribute("aria-pressed")).toBe("false");
  });

  it("isn't shown on any other plan", async () => {
    render(<Host initialType="all_in_one" />);
    await waitFor(() => expect(screen.getByText("POS Unit")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Kiosk" })).toBeNull();
  });
});

describe("Charge for kiosk on the QSR Kit", () => {
  it("defaults to free, and the button flips the kiosk out of the kit and back", async () => {
    render(<Host initialType="all_in_one" initialPicks={[{ hubspotProductId: "217445755632", qty: 1 }, { hubspotProductId: KIOSK, qty: 1 }]} />);
    const charge = await screen.findByRole("button", { name: "Charge for kiosk" });
    expect(screen.getByTestId("adjustments").textContent).toBe("{}");

    fireEvent.click(charge);
    const free = await screen.findByRole("button", { name: "Make it free" });
    expect(JSON.parse(screen.getByTestId("adjustments").textContent!)).toEqual({ [KIOSK]: { outsideKit: true } });
    expect(screen.getByText(/Charged at its price/)).toBeTruthy();

    fireEvent.click(free);
    await screen.findByRole("button", { name: "Charge for kiosk" });
    expect(screen.getByTestId("adjustments").textContent).toBe("{}");
  });

  it("isn't offered on Marketing Partial Ordering's kiosk", async () => {
    render(<Host initialType="marketing_partial" initialPicks={[{ hubspotProductId: KIOSK, qty: 1 }]} />);
    await waitFor(() => expect(chip("Kiosk").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("button", { name: "Charge for kiosk" })).toBeNull();
  });
});
