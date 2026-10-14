// @vitest-environment jsdom
//
// The rep-side statement dropzone is gone (2026-10-13) and the customer was
// never given one to begin with, so a "config" basis quote (priced on the
// rep's own volume/ticket entry, no statement) is now the ORDINARY rated
// quote rather than a rare edge case. leadQuote.test.ts already pins the DATA
// contract — every savings field comes back null on that path, never a $0 or
// a negative — but this is the render, and the render is what the merchant
// actually sees. It must omit the savings section entirely rather than print
// "$0 saved", "0.00% saved" or a negative number.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import QuoteSummary from "@/components/customer/QuoteSummary";
import type { CustomerSafeQuote } from "@/types/merchant";

afterEach(cleanup);

const CONFIG_QUOTE_NO_SAVINGS: CustomerSafeQuote = {
  basis: "config",
  monthlyVolume: 100_000,
  averageTicket: 25,
  effectiveRate: 0.0279,
  projectedMonthlyCost: 2790,
  projectedAnnualCost: 2790 * 12,
  currentMonthlyCost: null,
  currentEffectiveRate: null,
  monthlySavings: null,
  annualSavings: null,
  savingsPct: null,
  lines: [],
  lineTotals: null,
  orderPoints: null,
};

const STATEMENT_QUOTE_WITH_SAVINGS: CustomerSafeQuote = {
  ...CONFIG_QUOTE_NO_SAVINGS,
  basis: "statement",
  currentMonthlyCost: 3500,
  currentEffectiveRate: 0.035,
  monthlySavings: 710,
  annualSavings: 8520,
  savingsPct: 0.2029,
};

describe("QuoteSummary — savings section with no current cost on file", () => {
  it("renders the AIO effective rate, not a savings hero, when there's no statement", () => {
    render(<QuoteSummary quote={CONFIG_QUOTE_NO_SAVINGS} />);
    expect(screen.getByText("Your AIO Effective Rate")).toBeTruthy();
    expect(screen.queryByText("Estimated Annual Savings")).toBeNull();
    expect(screen.queryByText("Monthly Savings")).toBeNull();
  });

  it("never prints $0.00, 0.00% or a negative figure for the savings labels", () => {
    render(<QuoteSummary quote={CONFIG_QUOTE_NO_SAVINGS} />);
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/\$0\.00 saved/i);
    expect(body).not.toMatch(/0\.00% saved/i);
    expect(body).not.toMatch(/-\$/);
    expect(body).not.toContain("Monthly Savings");
    expect(body).not.toContain("New Effective Rate");
  });

  it("still shows the savings hero once a statement supplies a current cost", () => {
    render(<QuoteSummary quote={STATEMENT_QUOTE_WITH_SAVINGS} />);
    expect(screen.getByText("Estimated Annual Savings")).toBeTruthy();
    expect(screen.getByText("Monthly Savings")).toBeTruthy();
  });

  it("also omits the savings section for a quote with zero savings (never a $0 headline)", () => {
    render(<QuoteSummary quote={{ ...STATEMENT_QUOTE_WITH_SAVINGS, monthlySavings: 0, annualSavings: 0, savingsPct: 0 }} />);
    expect(screen.queryByText("Estimated Annual Savings")).toBeNull();
    expect(screen.getByText("Your AIO Effective Rate")).toBeTruthy();
  });
});

// Ordering points — threaded into CustomerSafeQuote since OrderPoints existed,
// but never rendered until 10/13 ("ordering points must show up on quote").
// Order points stopped pricing anything on 2026-10-05, so this is a plain
// configuration fact: it must render, it must never be $0/negative-styled
// like a price, and it must not sit next to a priced line (the platform line
// above all) the way the old, deleted "Based on N ordering points" copy did.
const PRODUCTS_QUOTE_WITH_POINTS: CustomerSafeQuote = {
  basis: "products",
  lines: [
    { hubspotProductId: "217526517443", name: "AIO Platform", qty: 1, unitPrice: 399, billingFrequency: "monthly", productType: "Software" },
  ],
  lineTotals: { oneTime: 0, recurring: [{ frequency: "monthly", amount: 399 }], monthlyEquivalent: 399 },
  // No declared channels here on purpose — these fixtures are about the
  // COUNT, not the channel names (that's its own describe block below), so
  // `channels` stays empty and `total` is set directly.
  orderPoints: { hardware: { "POS Unit": 2 }, channels: [], total: 3 },
};

describe("QuoteSummary — ordering-point count", () => {
  it("renders the count as a plain configuration fact", () => {
    render(<QuoteSummary quote={PRODUCTS_QUOTE_WITH_POINTS} />);
    expect(screen.getByText("Configured for 3 ordering points.")).toBeTruthy();
  });

  it("singularizes a count of exactly one", () => {
    render(<QuoteSummary quote={{ ...PRODUCTS_QUOTE_WITH_POINTS, orderPoints: { hardware: {}, channels: [], total: 1 } }} />);
    expect(screen.getByText("Configured for 1 ordering point.")).toBeTruthy();
  });

  it("renders nothing when there's no order-point basis at all", () => {
    render(<QuoteSummary quote={{ ...PRODUCTS_QUOTE_WITH_POINTS, orderPoints: null }} />);
    expect(screen.queryByText(/ordering point/i)).toBeNull();
  });

  it("renders nothing for a zero count rather than printing it like a price", () => {
    render(<QuoteSummary quote={{ ...PRODUCTS_QUOTE_WITH_POINTS, orderPoints: { hardware: {}, channels: [], total: 0 } }} />);
    expect(screen.queryByText(/ordering point/i)).toBeNull();
  });

  it("also renders on a rated quote, not only a rate-only one", () => {
    render(<QuoteSummary quote={{
      ...CONFIG_QUOTE_NO_SAVINGS,
      lines: PRODUCTS_QUOTE_WITH_POINTS.lines,
      lineTotals: PRODUCTS_QUOTE_WITH_POINTS.lineTotals,
      orderPoints: { hardware: {}, channels: [], total: 2 },
    }} />);
    expect(screen.getByText("Configured for 2 ordering points.")).toBeTruthy();
  });

  it("never ends up inside a line row — it's a sibling of the lines, not an addition to one", () => {
    render(<QuoteSummary quote={PRODUCTS_QUOTE_WITH_POINTS} />);
    const note = screen.getByText("Configured for 3 ordering points.");
    expect(note.closest("section")).toBeNull();
  });
});

// Channel labels (2026-10-13 p.m.) — `orderPoints.channels` existed since
// OrderPoints did but nothing ever named them; the product owner picked "QR
// code ordering" and "Phone-AI ordering" and saw neither on the quote. Same
// placement rule as the count above: configuration content, never beside a
// price or the platform line.
describe("QuoteSummary — ordering-channel names", () => {
  it("names the selected channels alongside the count", () => {
    render(<QuoteSummary quote={{
      ...PRODUCTS_QUOTE_WITH_POINTS,
      orderPoints: { hardware: {}, channels: ["qr", "phone_ai"], total: 2 },
    }} />);
    expect(screen.getByText("Configured for 2 ordering points (QR code ordering, Phone-AI ordering).")).toBeTruthy();
  });

  it("renders no channel list when none were declared, even with a nonzero count", () => {
    render(<QuoteSummary quote={PRODUCTS_QUOTE_WITH_POINTS} />);
    const note = screen.getByText("Configured for 3 ordering points.");
    expect(note.textContent).not.toContain("(");
  });

  it("drops an unrecognized channel id instead of printing it raw or crashing", () => {
    render(<QuoteSummary quote={{
      ...PRODUCTS_QUOTE_WITH_POINTS,
      orderPoints: { hardware: {}, channels: ["qr", "some_retired_channel"], total: 2 },
    }} />);
    const note = screen.getByText(/Configured for 2 ordering points/);
    expect(note.textContent).toContain("QR code ordering");
    expect(note.textContent).not.toContain("some_retired_channel");
    expect(note.textContent).not.toContain("undefined");
  });

  it("renders nothing at all (no stray parens) when every declared channel is unrecognized", () => {
    render(<QuoteSummary quote={{
      ...PRODUCTS_QUOTE_WITH_POINTS,
      orderPoints: { hardware: {}, channels: ["some_retired_channel"], total: 1 },
    }} />);
    const note = screen.getByText("Configured for 1 ordering point.");
    expect(note.textContent).not.toContain("(");
    expect(note.textContent).not.toContain("undefined");
  });
});
