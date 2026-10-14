// @vitest-environment jsdom
//
// The processing-margin task (2026-10-13 a.m.) added a "Processing margin" row
// to QuoteReceipt.tsx, but QuoteReceipt is only rendered in the default
// "panels" layout — the "document" layout `/rep/prospects/new` actually uses
// never renders it, so the margin was invisible on the one screen the product
// owner tests. The fix at the time rendered the same figure separately inside
// the document layout's rep-only BUILD column (`.buildCol`), never inside the
// `.docCol` mirror of what the merchant will see.
//
// Later that day the product owner asked for it moved AGAIN — into the
// `.docCol` mirror's own totals block (`.docTotals`), the thing the earlier
// fix was built specifically to avoid — but marked unmistakably internal:
// a muted "Internal" label directly above the row, set off from the
// customer-facing rows above it. This file now covers THAT placement, and
// inverts the `.buildCol`/`.docCol` expectations the first fix asserted.
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

function renderConfigurator(pricingPreview?: QuoteMarginPreview | null, channels: string[] = ["qr"]) {
  return render(
    <ProductConfigurator
      layout="document"
      // A plan must be chosen for the document layout to render anything past
      // the "pick a plan to start" screen (ProductConfigurator.tsx:1141) —
      // unrelated to this margin note, but the host never has a preview to
      // show before a plan is picked either, so this matches how the prop is
      // actually supplied in practice. A processing quote with no picks AND no
      // declared channels is rate-only and derives no platform line at all
      // (`resolvePlatformLine` → `none_needed`), so one channel is declared
      // by default purely to give the quote a line — `.docTotals` is gated on
      // `quoteLines.length > 0`. The rate-only regression test below passes
      // `channels={[]}` deliberately, to land on zero quote lines.
      quoteType="all_in_one"
      picks={[]}
      channels={channels}
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

describe("processing margin in the document layout's totals block", () => {
  it("renders the margin and projected commission inside .docTotals, marked internal, when a preview is supplied", async () => {
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

    const docCol = container.querySelector(`.${styles.docCol}`);
    const buildCol = container.querySelector(`.${styles.buildCol}`);
    const docTotals = container.querySelector(`.${styles.docTotals}`);
    expect(docCol).toBeTruthy();
    expect(buildCol).toBeTruthy();
    expect(docTotals).toBeTruthy();

    // It lives in the customer-document mirror's totals block now, not the
    // rep-only build column — the opposite of the earlier fix.
    expect(docTotals?.textContent).toContain("Processing margin");
    expect(docCol?.textContent).toContain("Processing margin");
    expect(buildCol?.textContent).not.toContain("Processing margin");

    // And it's unmistakably marked as not part of the document the merchant
    // actually sees, right alongside the row.
    expect(docTotals?.textContent).toMatch(/internal/i);
    expect(docTotals?.textContent).toMatch(/not shown to merchant/i);
  });

  it("renders the margin and its internal marking on a RATE-ONLY quote (no picks, no channels, no quote lines)", async () => {
    // The regression this task exists for: `resolvePlatformLine` gives a
    // processing quote with no picks and no declared channels NO platform
    // line at all (`none_needed`), so `quoteLines` is empty and `.docTotals`
    // — gated on `quoteLines.length > 0` — never mounts. A rate-only quote is
    // pure card processing, so the margin is the entire economics of the
    // deal and must still show up, just outside that gate.
    const { container } = renderConfigurator(
      {
        appliedTargetMargin: 0.021,
        projectedCommission: { totalArr: 102038, signingCommission: 2551, activationCommission: 2551, total: 2142.8 },
      },
      []
    );
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());
    await screen.findByTestId("mirror-heading");

    const docTotals = container.querySelector(`.${styles.docTotals}`);
    expect(docTotals).toBeNull();

    const docCol = container.querySelector(`.${styles.docCol}`);
    expect(docCol?.textContent).toContain("Processing margin");
    expect(screen.getByText(/2\.10%/)).toBeTruthy();
    expect(screen.getByText(/\(est\. \$2,142\.80\/yr\)/)).toBeTruthy();
    expect(docCol?.textContent).toMatch(/internal/i);
    expect(docCol?.textContent).toMatch(/not shown to merchant/i);
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
    expect(screen.queryByText(/not shown to merchant/i)).toBeNull();
  });

  it("renders nothing when the preview is explicitly null (marketing-only / no volume)", async () => {
    renderConfigurator(null);
    await waitFor(() => expect(listQuotableProductsAction).toHaveBeenCalled());

    expect(screen.queryByText("Processing margin")).toBeNull();
    expect(screen.queryByText(/0\.00%/)).toBeNull();
  });
});
