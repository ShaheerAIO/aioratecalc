// @vitest-environment jsdom
//
// Two builder controls the product owner asked for:
//  - Marketing Partial Ordering's Kiosk / Online Ordering chips, with the
//    "Marketing (Partial Ordering)" row hidden from the list (2026-10-28) —
//    and since 2026-10-30 no Marketing chip: the plan always carries it;
//  - the first kiosk as an ordinary line at list whose one unit the rep may
//    discount up to 100%, replacing the "Charge for kiosk" button (2026-10-29).
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
  ["343373224660", "Mega Kiosk Loaner", 100, "monthly", "inventory"],
];
const CATALOG: CatalogProduct[] = P.map(([hubspotProductId, name, price, billingFrequency, productType]) => ({
  hubspotProductId, name, price, billingFrequency, productType,
}));

const LATER = "343373224660"; // Mega Kiosk Loaner: recurring, not seeded by the plan

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

const startSelect = () => screen.getAllByRole("combobox").find(el => Array.from((el as HTMLSelectElement).options).some(o => o.value === "days")) as HTMLSelectElement;
const adjustmentsNow = () => JSON.parse(screen.getByTestId("adjustments").textContent!);

beforeEach(() => {
  listQuotableProductsAction.mockReset();
  listQuotableProductsAction.mockResolvedValue({ products: CATALOG, all: CATALOG, error: null });
});
afterEach(cleanup);

describe("recurring lines added later keep the plan's billing start (2026-11-11)", () => {
  it("gives a later recurring line the 45-day start, never Mixed", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /All-in-One Platform|All-in-One/ }));
    await waitFor(() => expect(startSelect().value).toBe("days"));

    fireEvent.click(await screen.findByRole("button", { name: "Add one Mega Kiosk Loaner" }));
    await waitFor(() => expect(adjustmentsNow()[LATER]?.billingStart).toEqual({ mode: "days", days: 45 }));
    expect(startSelect().value).toBe("days");
    expect(Array.from(startSelect().options).some(o => o.value === "")).toBe(false);
  });

  it("keeps a quote set to at-checkout at checkout", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /All-in-One Platform|All-in-One/ }));
    await waitFor(() => expect(startSelect().value).toBe("days"));
    fireEvent.change(startSelect(), { target: { value: "now" } });
    await waitFor(() => expect(startSelect().value).toBe("now"));

    fireEvent.click(await screen.findByRole("button", { name: "Add one Mega Kiosk Loaner" }));
    await waitFor(() => expect(screen.getByTestId("picks").textContent).toContain(LATER));
    expect(adjustmentsNow()[LATER]).toBeUndefined();
    expect(startSelect().value).toBe("now");
  });
});
