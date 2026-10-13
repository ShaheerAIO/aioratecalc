// @vitest-environment jsdom
//
// The processing-margin task (2026-10-13) added a "Processing margin" row to
// QuoteReceipt.tsx, but QuoteReceipt is only rendered in the default "panels"
// layout — the "document" layout `/rep/prospects/new` actually uses never
// renders it, so the margin was invisible on the one screen the product
// owner tests. This covers the fix: the same figure, rendered separately
// inside the document layout's rep-only BUILD column (`.buildCol`), never
// inside the `.docCol` mirror captioned "what the customer will see".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { CatalogProduct } from "@/types/merchant";
import type { QuoteMarginPreview } from "@/components/quoting/QuoteReceipt";

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
// Same CSS module the component imports, resolved to the same module
// instance — so these keys are whatever class names the component actually
// rendered, regardless of how vitest's CSS-modules transform names them.
import styles from "@/components/quoting/ProductConfigurator.module.css";

const CATALOG: CatalogProduct[] = [
  { hubspotProductId: "335283119838", name: "All-in-One Platform", price: 399, billingFrequency: "monthly", productType: "Software" },
];

function renderConfigurator(pricingPreview?: QuoteMarginPreview | null) {
  return render(
    <ProductConfigurator
      layout="document"
      // A plan must be chosen for the document layout to render anything past
      // the "pick a plan to start" screen (ProductConfigurator.tsx:1141) —
      // unrelated to this margin note, but the host never has a preview to
      // show before a plan is picked either, so this matches how the prop is
      // actually supplied in practice.
      quoteType="all_in_one"
      picks={[]}
      channels={[]}
      adjustments={{}}
      pricingPreview={pricingPreview}
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

describe("processing margin in the document layout's build column", () => {
  it("renders the margin and projected commission when a preview is supplied", async () => {
    const { container } = renderConfigurator({
      appliedTargetMargin: 0.021,
      projectedCommission: { totalArr: 102038, signingCommission: 2551, activationCommission: 2551, total: 2142.8 },
    });
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    // Both pieces sit in one node ("2.10% (est. $2,142.80/yr)"), same as the
    // QuoteReceipt row's format — match on content, not an exact full string.
    expect(screen.getByText(/2\.10%/)).toBeTruthy();
    expect(screen.getByText(/\(est\. \$2,142\.80\/yr\)/)).toBeTruthy();

    const buildCol = container.querySelector(`.${styles.buildCol}`);
    const docCol = container.querySelector(`.${styles.docCol}`);
    expect(buildCol).toBeTruthy();
    expect(docCol).toBeTruthy();
    expect(buildCol?.textContent).toContain("Processing margin");
    // The customer-facing mirror never carries AIO's margin.
    expect(docCol?.textContent).not.toContain("Processing margin");
  });

  it("renders the margin alone when there's no projected-commission figure", async () => {
    renderConfigurator({
      appliedTargetMargin: 0.0325,
      projectedCommission: { totalArr: null, signingCommission: null, activationCommission: null, total: null },
    });
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());

    expect(screen.getByText(/3\.25%/)).toBeTruthy();
    expect(screen.queryByText(/est\./)).toBeNull();
  });

  it("renders nothing when no preview prop is passed at all", async () => {
    renderConfigurator(undefined);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());

    expect(screen.queryByText("Processing margin")).toBeNull();
    expect(screen.queryByText(/0\.00%/)).toBeNull();
  });

  it("renders nothing when the preview is explicitly null (marketing-only / no volume)", async () => {
    renderConfigurator(null);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());

    expect(screen.queryByText("Processing margin")).toBeNull();
    expect(screen.queryByText(/0\.00%/)).toBeNull();
  });
});
