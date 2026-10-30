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
  it("opens with marketing and its boards on, offers no Marketing chip, and toggles the other two", async () => {
    render(<Host />);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Marketing Partial Ordering/ }));
    await waitFor(() => expect(chip("Kiosk")).toBeTruthy());

    // Marketing isn't optional on MPO (2026-10-30): the plan opens with the
    // line and the three boards it makes free, and there is no chip to take
    // it off.
    await waitFor(() => expect(picksText()).toContain(`${MARKETING}:1`));
    expect(picksText()).toContain(`${BOARD}:3`);
    expect(screen.queryByRole("button", { name: "Marketing" })).toBeNull();

    // Hidden from the list; Online Ordering keeps its row.
    expect(screen.queryByRole("button", { name: "Add one Marketing (Partial Ordering)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add one Online Ordering" })).toBeTruthy();
    for (const name of ["Kiosk", "Online Ordering"]) {
      expect(chip(name).getAttribute("aria-pressed"), name).toBe("false");
    }

    fireEvent.click(chip("Kiosk"));
    await waitFor(() => expect(picksText()).toContain(`${KIOSK}:1`));
    expect(chip("Kiosk").getAttribute("aria-pressed")).toBe("true");
    // The kiosk it adds is the first kiosk.
    expect(screen.getByText("The first kiosk can be discounted up to 100%.")).toBeTruthy();

    fireEvent.click(chip("Online Ordering"));
    await waitFor(() => expect(picksText()).toContain(`${ONLINE}:1`));

    fireEvent.click(chip("Kiosk"));
    await waitFor(() => expect(picksText()).not.toContain(KIOSK));
    expect(picksText()).toContain(`${ONLINE}:1`);
    expect(picksText()).toContain(`${MARKETING}:1`);
  });

  it("lights from the picks a reopened quote arrives with", async () => {
    render(<Host initialType="marketing_partial" initialPicks={[{ hubspotProductId: KIOSK, qty: 1 }]} />);
    await waitFor(() => expect(chip("Kiosk").getAttribute("aria-pressed")).toBe("true"));
    expect(chip("Online Ordering").getAttribute("aria-pressed")).toBe("false");
  });

  it("puts marketing on a quote reopened from before 2026-10-30 without it", async () => {
    // The picks carry no marketing line; buildQuote forces it onto the document.
    render(<Host initialType="marketing_partial" initialPicks={[{ hubspotProductId: ONLINE, qty: 1 }]} />);
    await screen.findByText("Marketing (Partial Ordering)");
    expect(picksText()).not.toContain(MARKETING);
  });

  it("isn't shown on any other plan", async () => {
    render(<Host initialType="all_in_one" />);
    await waitFor(() => expect(screen.getByText("POS Unit")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Kiosk" })).toBeNull();
  });
});

describe("the first kiosk's discount (2026-10-29)", () => {
  const KIOSK_DISCOUNT = "Discount percent for Kiosk 27\" + Payment Terminal (AMS1) and Mount";
  const adjustmentsNow = () => JSON.parse(screen.getByTestId("adjustments").textContent!);
  const openDrawers = () => {
    for (const b of screen.getAllByRole("button").filter(b => b.hasAttribute("aria-expanded"))) {
      if (b.getAttribute("aria-expanded") === "false") fireEvent.click(b);
    }
  };
  const QSR_PICKS: ProductPick[] = [{ hubspotProductId: "217445755632", qty: 1 }, { hubspotProductId: KIOSK, qty: 1 }];

  it("goes on at list with a note and no button; the rep discounts it like any line", async () => {
    render(<Host initialType="all_in_one" initialPicks={QSR_PICKS} />);
    await screen.findByText("The first kiosk can be discounted up to 100%.");
    expect(screen.queryByRole("button", { name: "Charge for kiosk" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make it free" })).toBeNull();
    expect(screen.getByTestId("adjustments").textContent).toBe("{}");

    openDrawers();
    const box = await screen.findByLabelText(KIOSK_DISCOUNT) as HTMLInputElement;
    expect(box.value).toBe("");

    fireEvent.change(box, { target: { value: "100" } });
    await waitFor(() => expect(adjustmentsNow()).toEqual({ [KIOSK]: { discountPercent: 100 } }));

    // Clearing it charges list again — no adjustment left behind.
    fireEvent.change(screen.getByLabelText(KIOSK_DISCOUNT), { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("adjustments").textContent).toBe("{}"));
  });
});

describe("the Mega Kiosk Loaner in the picker (2026-10-29)", () => {
  const LOANER = "343373224660";
  const row = () => screen.queryByRole("button", { name: "Add one Mega Kiosk Loaner" });

  it("isn't offered on All-in-One or Order & Pay", async () => {
    for (const plan of ["all_in_one", "order_pay_only"] as const) {
      render(<Host initialType={plan} />);
      await waitFor(() => expect(screen.getByText("POS Unit")).toBeTruthy());
      expect(row(), plan).toBeNull();
      cleanup();
    }
  });

  it("stays listed on a POS plan when a draft already carries one", async () => {
    render(<Host initialType="all_in_one" initialPicks={[{ hubspotProductId: LOANER, qty: 1 }]} />);
    await waitFor(() => expect(row()).toBeTruthy());
  });

  it("is still offered on Marketing Partial Ordering", async () => {
    render(<Host initialType="marketing_partial" />);
    await waitFor(() => expect(row()).toBeTruthy());
  });
});
