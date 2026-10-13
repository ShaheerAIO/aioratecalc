// @vitest-environment jsdom
//
// Hardware commission on the quote receipt (2026-10-13 product-owner ask: show
// the rep their hardware commission on the quote table). The math itself lives
// in lib/commission.ts and is tested there — this file only covers what
// QuoteReceipt.tsx renders (or doesn't) from it: the per-line figure, the
// "Hardware commission" total row, the negative case, and that recurring
// lines and the RSM/cost figures never show up here.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import QuoteReceipt from "@/components/quoting/QuoteReceipt";
import type { QuoteLine, QuoteTotals } from "@/types/merchant";

afterEach(cleanup);

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  hubspotProductId: "217445755632",
  name: "POS Unit",
  qty: 1,
  unitPrice: 749,
  billingFrequency: "one_time",
  productType: "inventory",
  ...over,
});

const ZERO_TOTALS: QuoteTotals = { oneTime: 0, recurring: [], monthlyEquivalent: 0 };

function renderReceipt(lines: QuoteLine[], totals: QuoteTotals = ZERO_TOTALS) {
  return render(
    <QuoteReceipt
      lines={lines}
      totals={totals}
      packageSavings={0}
      discountTotal={0}
      dueAtCheckout={0}
      preAuthAmount={null}
    />
  );
}

describe("per-line hardware commission", () => {
  it("renders the rep's estimated commission when cost and rate are both on file", () => {
    // $749 - $400 cost = $349 margin, 10% rep rate (1000 bps) = $34.90.
    renderReceipt([
      line({ costToRep: 400, repCommissionBps: 1000, rsmCommissionBps: 500 }),
    ]);
    expect(screen.getByText(/Your est\. commission: \$34\.90/)).toBeTruthy();
  });

  it("renders nothing for a line with no cost or no rate on file (today's default state)", () => {
    renderReceipt([line()]); // no costToRep, no repCommissionBps at all
    expect(screen.queryByText(/Your est\. commission/)).toBeNull();
  });

  it("never shows a figure on a recurring line, even if it carries commission fields", () => {
    renderReceipt([
      line({
        billingFrequency: "monthly",
        unitPrice: 399,
        costToRep: 100,
        repCommissionBps: 1000,
      }),
    ]);
    expect(screen.queryByText(/Your est\. commission/)).toBeNull();
  });

  it("renders a negative figure for a 100%-off package-covered line", () => {
    // Net amount is $0 (100% off), cost is $400 -> margin -$400, 10% rep = -$40.
    renderReceipt([
      line({
        discountPercent: 100,
        coveredByPackage: "QSR Kit",
        costToRep: 400,
        repCommissionBps: 1000,
      }),
    ]);
    expect(screen.getByText(/Your est\. commission: -\$40\.00/)).toBeTruthy();
  });

  it("never renders the RSM figure or the underlying cost", () => {
    renderReceipt([
      line({ costToRep: 400, repCommissionBps: 1000, rsmCommissionBps: 500 }),
    ]);
    // The RSM commission on this line would be $17.45 (349 * 5%) — must not appear.
    expect(screen.queryByText(/17\.45/)).toBeNull();
    // The raw cost figure must not appear anywhere on the page.
    expect(screen.queryByText(/\$400\.00/)).toBeNull();
  });
});

describe("the Hardware commission total row", () => {
  it("is absent when no line has commission data (0 of 39 products populated today)", () => {
    renderReceipt([line(), line({ hubspotProductId: "223452690133", name: "Onsite Installation" })]);
    expect(screen.queryByText(/Hardware commission/)).toBeNull();
  });

  it("sums every line's rep commission once at least one line has data", () => {
    renderReceipt([
      line({ costToRep: 400, repCommissionBps: 1000 }), // $34.90
      line({
        hubspotProductId: "223452690133",
        name: "Onsite Installation",
        unitPrice: 999,
        costToRep: 0,
        repCommissionBps: 1000,
      }), // $99.90
    ]);
    expect(screen.getByText("Hardware commission (est.)")).toBeTruthy();
    expect(screen.getByText("$134.80")).toBeTruthy();
  });

  it("can go negative, and is never clamped to zero", () => {
    renderReceipt([
      line({
        discountPercent: 100,
        coveredByPackage: "QSR Kit",
        costToRep: 400,
        repCommissionBps: 1000,
      }),
    ]);
    expect(screen.getByText("Hardware commission (est.)")).toBeTruthy();
    expect(screen.getByText("-$40.00")).toBeTruthy();
  });

  it("sits after Package savings and Discounts applied, before Due at checkout", () => {
    render(
      <QuoteReceipt
        lines={[line({ costToRep: 400, repCommissionBps: 1000, discountPercent: 10 })]}
        totals={ZERO_TOTALS}
        packageSavings={50}
        discountTotal={20}
        dueAtCheckout={100}
        preAuthAmount={null}
      />
    );
    const labels = screen.getAllByText(/Package savings|Discounts applied|Hardware commission|Due at checkout/)
      .map(el => el.textContent);
    expect(labels).toEqual([
      "Package savings",
      "Discounts applied",
      "Hardware commission (est.)",
      "Due at checkout",
    ]);
  });
});

// Margin on the quote receipt (2026-10-13 product-owner ask: show the rep
// their processing margin on the surface they actually build a quote on).
// `pricingPreview` is the rep-safe slice of `getPricingPreviewAction`'s
// result (`derivePricingForRole` — already padded for a rep caller); this
// file only covers rendering, not the pricing math itself.
describe("the Processing margin total row", () => {
  it("renders the margin and the estimated commission when both are supplied", () => {
    // renderReceipt doesn't take a pricingPreview, so render directly, same
    // as the ordering test above.
    render(
      <QuoteReceipt
        lines={[line()]}
        totals={ZERO_TOTALS}
        packageSavings={0}
        discountTotal={0}
        dueAtCheckout={0}
        preAuthAmount={null}
        pricingPreview={{
          appliedTargetMargin: 0.021,
          projectedCommission: { totalArr: 21428, signingCommission: 1071.4, activationCommission: 1071.4, total: 2142.8 },
        }}
      />
    );
    expect(screen.getByText("Processing margin")).toBeTruthy();
    expect(screen.getByText(/2\.10%/)).toBeTruthy();
    expect(screen.getByText(/est\. \$2,142\.80\/yr/)).toBeTruthy();
  });

  it("renders the margin alone when no commission figure is available", () => {
    render(
      <QuoteReceipt
        lines={[line()]}
        totals={ZERO_TOTALS}
        packageSavings={0}
        discountTotal={0}
        dueAtCheckout={0}
        preAuthAmount={null}
        pricingPreview={{
          appliedTargetMargin: 0.021,
          projectedCommission: { totalArr: null, signingCommission: null, activationCommission: null, total: null },
        }}
      />
    );
    expect(screen.getByText("Processing margin")).toBeTruthy();
    expect(screen.getByText("2.10%")).toBeTruthy();
    expect(screen.queryByText(/est\./)).toBeNull();
  });

  it("renders nothing when no pricing preview is passed at all (today's default — the other two hosts)", () => {
    renderReceipt([line()]);
    expect(screen.queryByText(/Processing margin/)).toBeNull();
  });

  it("renders nothing when the pricing preview is explicitly null (marketing-only, or no volume to price against)", () => {
    render(
      <QuoteReceipt
        lines={[line()]}
        totals={ZERO_TOTALS}
        packageSavings={0}
        discountTotal={0}
        dueAtCheckout={0}
        preAuthAmount={null}
        pricingPreview={null}
      />
    );
    expect(screen.queryByText(/Processing margin/)).toBeNull();
    // And never a bare "0.00%" standing in for "we don't know" — the whole
    // row is absent, not a zeroed-out one.
    expect(screen.queryByText("0.00%")).toBeNull();
  });

  it("sits between Discounts applied and Hardware commission (est.)", () => {
    render(
      <QuoteReceipt
        lines={[line({ costToRep: 400, repCommissionBps: 1000 })]}
        totals={ZERO_TOTALS}
        packageSavings={50}
        discountTotal={20}
        dueAtCheckout={100}
        preAuthAmount={null}
        pricingPreview={{
          appliedTargetMargin: 0.021,
          projectedCommission: { totalArr: null, signingCommission: null, activationCommission: null, total: null },
        }}
      />
    );
    const labels = screen
      .getAllByText(/Package savings|Discounts applied|Processing margin|Hardware commission|Due at checkout/)
      .map(el => el.textContent);
    expect(labels).toEqual([
      "Package savings",
      "Discounts applied",
      "Processing margin",
      "Hardware commission (est.)",
      "Due at checkout",
    ]);
  });
});
