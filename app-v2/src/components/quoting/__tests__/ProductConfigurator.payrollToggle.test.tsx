// @vitest-environment jsdom
//
// Payroll as a toggle at the top of the picker (2026-10-30, product owner:
// "move payroll line item to the top, as a toggle"): on adds one employee and
// opens the ordinary typed box and +/−, off takes payroll off, and it no
// longer has a row in its product group. Both layouts.
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

const PAYROLL = "223152695998";
const PAYROLL_NAME = "Payroll - AIO Platform (Per Person)";

const P: Array<[string, string, number, CatalogProduct["billingFrequency"], string]> = [
  ["335279520445", "All-in-One (Order & Pay only)", 299, "monthly", ""],
  ["335283119838", "All-in-One Platform", 399, "monthly", "Software"],
  ["343582047937", "AIO Marketing Partial Ordering", 299, "monthly", "Software"],
  ["343579168455", "Marketing (Partial Ordering)", 0, "monthly", ""],
  [PAYROLL, PAYROLL_NAME, 8, "monthly", "Software"],
  ["333275576048", "Website", 50, "monthly", "Software"],
  ["217445755632", "POS Unit", 749, "one_time", "inventory"],
  ["223511653105", "Payment Terminal - AMS1", 300, "one_time", "inventory"],
  ["276751313619", "Orders Hub Tablet", 199, "one_time", "inventory"],
  ["223452690132", "KDS (Kitchen Display System)", 399, "one_time", "inventory"],
  ["223452690133", "Onsite Installation", 999, "one_time", "Service"],
  ["223152695032", "System Onboarding and Training", 499, "one_time", "Service"],
];
const CATALOG: CatalogProduct[] = P.map(([hubspotProductId, name, price, billingFrequency, productType]) => ({
  hubspotProductId, name, price, billingFrequency, productType,
}));

function Host({ layout, initialType, initialPicks = [] }: {
  layout: "panels" | "document"; initialType: QuoteType; initialPicks?: ProductPick[];
}) {
  const [quoteType, setQuoteType] = useState<QuoteType | null>(initialType);
  const [picks, setPicks] = useState<ProductPick[]>(initialPicks);
  const [channels, setChannels] = useState<string[]>([]);
  const [adjustments, setAdjustments] = useState<QuoteAdjustments>({});
  return (
    <>
      <div data-testid="picks">{picks.map(p => `${p.hubspotProductId}:${p.qty}`).join(" ")}</div>
      <ProductConfigurator
        layout={layout}
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
const toggle = () => screen.getByRole("switch", { name: /Payroll/ });
const countBox = () => screen.queryByLabelText(`How many ${PAYROLL_NAME}`) as HTMLInputElement | null;

beforeEach(() => {
  listQuotableProductsAction.mockReset();
  listQuotableProductsAction.mockResolvedValue({ products: CATALOG, all: CATALOG, error: null });
});
afterEach(cleanup);

describe("the payroll toggle", () => {
  for (const layout of ["panels", "document"] as const) {
    it(`${layout}: on adds one employee and shows the count box; off takes payroll off`, async () => {
      render(<Host layout={layout} initialType="all_in_one" />);
      await waitFor(() => expect(toggle()).toBeTruthy());
      expect(toggle().getAttribute("aria-checked")).toBe("false");
      expect(countBox()).toBeNull();
      // Not a row in its group any more.
      expect(screen.queryByRole("button", { name: `Add one ${PAYROLL_NAME}` })).toBeNull();

      fireEvent.click(toggle());
      await waitFor(() => expect(picksText()).toContain(`${PAYROLL}:1`));
      expect(toggle().getAttribute("aria-checked")).toBe("true");

      // The same typed box and +/− as any row.
      fireEvent.change(countBox()!, { target: { value: "25" } });
      await waitFor(() => expect(picksText()).toContain(`${PAYROLL}:25`));
      fireEvent.click(screen.getByRole("button", { name: `Add one ${PAYROLL_NAME}` }));
      await waitFor(() => expect(picksText()).toContain(`${PAYROLL}:26`));

      // The box stops at one — off is the toggle's job.
      fireEvent.change(countBox()!, { target: { value: "" } });
      await waitFor(() => expect(picksText()).toContain(`${PAYROLL}:1`));
      expect(countBox()).toBeTruthy();

      fireEvent.click(toggle());
      await waitFor(() => expect(picksText()).not.toContain(PAYROLL));
      expect(countBox()).toBeNull();
    });
  }

  it("reads on from the picks a reopened quote arrives with", async () => {
    render(<Host layout="panels" initialType="all_in_one" initialPicks={[{ hubspotProductId: PAYROLL, qty: 12 }]} />);
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    expect(countBox()!.value).toBe("12");
  });

  it("isn't shown on a plan that doesn't offer payroll", async () => {
    render(<Host layout="document" initialType="marketing_partial" />);
    await waitFor(() => expect(screen.getByText("Orders Hub Tablet")).toBeTruthy());
    expect(screen.queryByRole("switch", { name: /Payroll/ })).toBeNull();
  });
});
