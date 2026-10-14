// @vitest-environment jsdom
//
// Nothing in the codebase rendered `orderPoints.channels` before 2026-10-13 —
// only the total count. The product owner picked "QR code ordering" and
// "Phone-AI ordering" on a quote and saw neither anywhere. This covers the
// rep's document-mirror half of the fix: the selected channel labels, shown
// with the rest of the configuration in the `.doc` body, never inside
// `.docTotals` and never beside a price (order points stopped pricing
// anything on 2026-10-05 — see the comment on QuoteSummary.tsx's own note).
// The customer-facing half is covered in
// src/components/customer/__tests__/QuoteSummary.test.tsx.
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

import ProductConfigurator from "@/components/quoting/ProductConfigurator";
import styles from "@/components/quoting/ProductConfigurator.module.css";

const CATALOG: CatalogProduct[] = [
  { hubspotProductId: "335283119838", name: "All-in-One Platform", price: 399, billingFrequency: "monthly", productType: "Software" },
];

function renderConfigurator(channels: string[]) {
  return render(
    <ProductConfigurator
      layout="document"
      quoteType="all_in_one"
      picks={[]}
      channels={channels}
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

describe("selected ordering channels in the document mirror", () => {
  it("names the selected channels in the .doc body, outside .docTotals", async () => {
    const { container } = renderConfigurator(["qr", "phone_ai"]);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    const note = await screen.findByText(/Ordering channels:/);
    expect(note.textContent).toContain("QR code ordering");
    expect(note.textContent).toContain("Phone-AI ordering");

    const docTotals = container.querySelector(`.${styles.docTotals}`);
    expect(docTotals?.textContent ?? "").not.toContain("Ordering channels");

    const docCol = container.querySelector(`.${styles.docCol}`);
    expect(docCol?.contains(note)).toBe(true);
  });

  it("renders nothing when no channels are selected", async () => {
    renderConfigurator([]);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    expect(screen.queryByText(/Ordering channels:/)).toBeNull();
  });

  it("drops an unrecognized channel id (e.g. a saved quote's retired 'website') instead of crashing or printing undefined", async () => {
    renderConfigurator(["qr", "some_retired_channel"]);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    const note = await screen.findByText(/Ordering channels:/);
    expect(note.textContent).toContain("QR code ordering");
    expect(note.textContent).not.toContain("some_retired_channel");
    expect(note.textContent).not.toContain("undefined");
  });

  it("renders nothing when every selected channel is unrecognized", async () => {
    renderConfigurator(["some_retired_channel"]);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    expect(screen.queryByText(/Ordering channels:/)).toBeNull();
  });
});
