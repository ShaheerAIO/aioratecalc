// @vitest-environment jsdom
//
// The AE's own hardware commission in the DOCUMENT layout (2026-10-14).
// `QuoteReceipt` has shown a per-line figure since 10/13, but it is only
// rendered in the "panels" layout — `/rep/prospects/new`, the surface a rep
// actually builds a quote on, uses the document layout and showed none of it.
//
// Two things this file pins that are easy to undo by accident:
//   * The figure is marked internal IN ITS OWN RIGHT on each line, not only by
//     the "Internal · not shown to merchant" header down in the totals block.
//     `.docCol` is a live mirror of the merchant's document; a rep reads a
//     line there, not the block boundary it happens to sit inside.
//   * Hardware AIO comps earns NOTHING and says nothing, while hardware
//     HubSpot hasn't priced says so out loud. Those two must never collapse
//     into one silent case — see `isPolicyComped` in lib/commission.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { CatalogProduct } from "@/types/merchant";

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
import styles from "@/components/quoting/ProductConfigurator.module.css";

// Real ids and real 2026-10-14 figures, so a change to the live catalog that
// breaks an assumption here shows up as a failing test rather than as a wrong
// number on a quote. Mega Kiosk: $2,250 at a $1,495 cost and a 60% rep rate
// -> $453.00. Customer Facing Display is one of the five products with NO
// cost on file.
const MEGA_KIOSK = "260674226888";
const DISPLAY = "318736467644";

const CATALOG: CatalogProduct[] = [
  { hubspotProductId: "335283119838", name: "All-in-One Platform", price: 399, billingFrequency: "monthly", productType: "Software", costToRep: 399, repCommissionBps: 6000, rsmCommissionBps: 1000 },
  { hubspotProductId: MEGA_KIOSK, name: "Mega Kiosk", price: 2250, billingFrequency: "one_time", productType: "inventory", costToRep: 1495, repCommissionBps: 6000, rsmCommissionBps: 1000 },
  { hubspotProductId: DISPLAY, name: "Customer Facing Display", price: 299, billingFrequency: "one_time", productType: "inventory", costToRep: null, repCommissionBps: null, rsmCommissionBps: null },
  // The two comped services and the WiFi package, so a built quote carries
  // the real derived lines rather than reporting them missing.
  { hubspotProductId: "223452690133", name: "Onsite Installation", price: 999, billingFrequency: "one_time", productType: "Service", costToRep: 999, repCommissionBps: 4500, rsmCommissionBps: 500 },
  { hubspotProductId: "223152695032", name: "System Onboarding and Training", price: 499, billingFrequency: "one_time", productType: "Service", costToRep: 499, repCommissionBps: 4500, rsmCommissionBps: 500 },
  { hubspotProductId: "338690209525", name: "AIO Wifi Network Package - Unifi", price: 698, billingFrequency: "one_time", productType: "inventory", costToRep: 698, repCommissionBps: 6000, rsmCommissionBps: 1000 },
  { hubspotProductId: "281354281678", name: "AIO Pre Auth", price: 0.5, billingFrequency: "one_time", productType: "Service" },
];

function renderConfigurator(picks: ProductPick[]) {
  return render(
    <ProductConfigurator
      layout="document"
      quoteType="all_in_one"
      picks={picks}
      channels={["qr"]}
      adjustments={{}}
      documentHeader={<h2 data-testid="mirror-heading">Live quote · what Test Co will see</h2>}
      onQuoteTypeChange={() => {}}
      onPicksChange={() => {}}
      onChannelsChange={() => {}}
      onAdjustmentsChange={() => {}}
      onDerivedChange={() => {}}
    />
  );
}

beforeEach(() => {
  listQuotableProductsAction.mockReset();
  listQuotableProductsAction.mockResolvedValue({ products: CATALOG, all: CATALOG, error: null });
  getQuoteLimits.mockReset();
  getQuoteLimits.mockResolvedValue({ unitCaps: {}, maxBillingDelayDays: 90, showTablets: false });
});
afterEach(cleanup);

describe("the AE's hardware commission in the document layout", () => {
  it("shows the per-line figure on a priced line, inside the merchant mirror", async () => {
    const { container } = renderConfigurator([{ hubspotProductId: MEGA_KIOSK, qty: 1 }]);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    // Since 2026-10-14 it is a COLUMN beside the price, so the cell carries
    // the figure alone and the group's column head says whose it is.
    const note = container.querySelector(`.${styles.docCommission}`);
    expect(note?.textContent).toBe("$453.00");
    const docCol = container.querySelector(`.${styles.docCol}`);
    expect(docCol?.textContent).toContain("$453.00");
  });

  it("marks the per-line figure internal on the line itself, not only in the totals", async () => {
    const { container } = renderConfigurator([{ hubspotProductId: MEGA_KIOSK, qty: 1 }]);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    const note = container.querySelector(`.${styles.docCommission}`);
    expect(note).toBeTruthy();
    expect(note?.textContent).toContain("$453.00");
    // A bare figure in a column needs the column to name it — otherwise the
    // only thing saying it isn't the merchant's is the totals block below.
    const head = container.querySelector(`.${styles.docCommissionHead}`);
    expect(head?.textContent).toContain("Your comm.");
  });

  it("totals it under the one 'not shown to merchant' header", async () => {
    const { container } = renderConfigurator([{ hubspotProductId: MEGA_KIOSK, qty: 2 }]);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    const docTotals = container.querySelector(`.${styles.docTotals}`);
    expect(docTotals?.textContent).toContain("Your hardware commission (est.)");
    expect(docTotals?.textContent).toContain("$906.00"); // 2 × $453
    expect(docTotals?.textContent).toMatch(/not shown to merchant/i);
  });

  it("says nothing on hardware AIO comps — install and training carry no figure", async () => {
    const { container } = renderConfigurator([{ hubspotProductId: MEGA_KIOSK, qty: 1 }]);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    // Both comped services ARE on the quote (they're derived and included)…
    const docCol = container.querySelector(`.${styles.docCol}`);
    expect(docCol?.textContent).toContain("Onsite Installation");
    expect(docCol?.textContent).toContain("System Onboarding and Training");
    // …and neither drags the total down. Were they counted as a loss, this
    // quote would read −$224.55 instead of $453.00.
    expect(container.querySelector(`.${styles.docTotals}`)?.textContent).toContain("$453.00");
    expect(screen.queryByText(/-\$/)).toBeNull();
  });

  it("says an unpriced product is unpriced rather than going quiet", async () => {
    const { container } = renderConfigurator([{ hubspotProductId: DISPLAY, qty: 1 }]);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    // In the column it reads "n/a" rather than nothing — the full reason is
    // on the cell, but an empty cell would read as "this earns $0".
    const note = container.querySelector(`.${styles.docCommission}`);
    expect(note?.getAttribute("data-commission")).toBe("unknown");
    expect(note?.textContent).toBe("n/a");
    expect(note?.getAttribute("title")).toMatch(/No cost on file/);
    // And the totals name it, so an AE reading only the bottom line still
    // knows a product on this quote wasn't counted.
    const docTotals = container.querySelector(`.${styles.docTotals}`);
    expect(docTotals?.textContent).toContain("Customer Facing Display");
    // Since 2026-10-28 install AND training are both comped, so nothing else
    // on this quote earns a figure and the total row is omitted entirely: the
    // footnote above is the only commission line, rather than a misleading
    // "$0.00" beside the missing display.
    expect(docTotals?.textContent).not.toContain("Your hardware commission (est.)");
  });
});
