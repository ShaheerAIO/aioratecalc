// @vitest-environment jsdom
//
// The rate/savings headline (effective rate, projected cost, estimated
// savings) was removed 2026-10-15 (product owner: "get rid of the whole rate
// breakdown in the customer preview of the quote just show the line items").
// leadQuote.test.ts still pins the DATA contract on CustomerSafeQuote; this
// file now only guards that none of those fields ever render here, on any
// basis, and exercises the line-item rendering itself.
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
  payment: { cardPresentRate: 0.0249, cardNotPresentRate: 0.033, perTransactionFee: 0.15, monthlyVolume: 100_000 },
  oneTimeInvoiced: true, invoice: null,
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

describe("QuoteSummary — no rate/savings breakdown, on any basis", () => {
  it("never renders the rate headline, on a config-basis quote", () => {
    render(<QuoteSummary quote={CONFIG_QUOTE_NO_SAVINGS} />);
    expect(screen.queryByText("Your AIO Effective Rate")).toBeNull();
    expect(screen.queryByText("Estimated Monthly Cost")).toBeNull();
    expect(screen.queryByText("Average Ticket")).toBeNull();
  });

  it("never renders the savings headline, even when a statement supplies real savings", () => {
    render(<QuoteSummary quote={STATEMENT_QUOTE_WITH_SAVINGS} />);
    expect(screen.queryByText("Estimated Annual Savings")).toBeNull();
    expect(screen.queryByText("Monthly Savings")).toBeNull();
    expect(screen.queryByText("New Effective Rate")).toBeNull();
  });

  it("never prints $0.00, 0.00% or a negative figure left over from a removed stat", () => {
    render(<QuoteSummary quote={CONFIG_QUOTE_NO_SAVINGS} />);
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/\$0\.00 saved/i);
    expect(body).not.toMatch(/0\.00% saved/i);
    expect(body).not.toMatch(/-\$/);
  });
});

// The quoted rates came back on 2026-10-18 in their own card — the rates, the
// volume they were quoted on, and the incident fees. Still no effective rate,
// projected cost or savings (asserted above).
describe("QuoteSummary — payment details card", () => {
  const card = () => screen.getByRole("region", { name: "Payment details" });

  it("lists card present and card not present as equal rows, not a headline", () => {
    render(<QuoteSummary quote={CONFIG_QUOTE_NO_SAVINGS} />);
    const text = card().textContent ?? "";
    expect(text.indexOf("Card present")).toBeLessThan(text.indexOf("Card not present"));
    expect(text).toContain("2.49%");
    expect(text).toContain("3.30%");
    expect(text).toContain("+ $0.15 per transaction");
  });

  it("shows the monthly volume and the chargeback and retrieval fees", () => {
    render(<QuoteSummary quote={CONFIG_QUOTE_NO_SAVINGS} />);
    const text = card().textContent ?? "";
    expect(text).toContain("$100,000");
    expect(text).toMatch(/Chargeback fee\$25\.00 each/);
    expect(text).toMatch(/Retrieval fee\$15\.00 each/);
  });

  it("headlines card-not-present alone for a merchant with no card-present lane", () => {
    render(<QuoteSummary quote={{ ...CONFIG_QUOTE_NO_SAVINGS, payment: { ...CONFIG_QUOTE_NO_SAVINGS.payment!, cardPresentRate: null } }} />);
    const text = card().textContent ?? "";
    expect(text).not.toContain("Card present");
    expect(text).toContain("Card not present3.30%");
  });

  it("still shows the rates on a quote with no rate basis, leaving out only the volume", () => {
    // A rep who enters a volume but no average ticket saves no rate basis, so
    // the quote renders on the "products" basis — the card must not vanish.
    render(<QuoteSummary quote={{
      ...PRODUCTS_QUOTE_WITH_POINTS,
      payment: { cardPresentRate: 0.0249, cardNotPresentRate: 0.033, perTransactionFee: 0.15, monthlyVolume: null },
    }} />);
    const text = card().textContent ?? "";
    expect(text).toContain("2.49%");
    expect(text).not.toContain("Monthly card volume");
    expect(text).toContain("Chargeback fee");
  });

  it("is absent from a quote with no processing behind it", () => {
    render(<QuoteSummary quote={PRODUCTS_QUOTE_WITH_POINTS} />);
    expect(screen.queryByRole("region", { name: "Payment details" })).toBeNull();
  });
});

describe("QuoteSummary — line descriptions", () => {
  it("prints the description under a line it knows", () => {
    render(<QuoteSummary quote={{
      ...PRODUCTS_QUOTE_WITH_POINTS,
      lines: [{ hubspotProductId: "223452690132", name: "KDS (Kitchen Display System)", qty: 1, unitPrice: 499, billingFrequency: "one_time", productType: "inventory" }],
      lineTotals: { oneTime: 499, recurring: [], monthlyEquivalent: 0 },
    }} />);
    expect(screen.getByText("A kitchen screen that shows your staff incoming orders.")).toBeTruthy();
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
  payment: null,
  oneTimeInvoiced: true, invoice: null,
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

// ── How a discount reads to the MERCHANT ────────────────────────────────────
// A cash discount prints the dollars the rep agreed, not the percentage they
// happen to work out as (2026-10-14). "$747 off" is the thing that was said
// in the room; "33.244326% off" is an artifact of dividing, and printing it
// would undo the reason the cash lever was built.
const DISCOUNTED_QUOTE: CustomerSafeQuote = {
  basis: "products",
  lines: [
    { hubspotProductId: "217445755632", name: "POS Unit", qty: 3, unitPrice: 749, billingFrequency: "one_time", productType: "inventory", discountAmount: 747 },
    { hubspotProductId: "223511653105", name: "Payment Terminal - AMS1", qty: 1, unitPrice: 300, billingFrequency: "one_time", productType: "inventory", discountPercent: 20 },
    { hubspotProductId: "223452690133", name: "Onsite Installation", qty: 1, unitPrice: 999, billingFrequency: "one_time", productType: "Service", discountPercent: 100 },
  ],
  lineTotals: { oneTime: 1740, recurring: [], monthlyEquivalent: 0 },
  orderPoints: null,
  payment: null,
  oneTimeInvoiced: true, invoice: null,
};

describe("QuoteSummary — how a discount is described", () => {
  it("states a cash discount in dollars, never as the percentage it works out as", () => {
    render(<QuoteSummary quote={DISCOUNTED_QUOTE} />);
    expect(screen.getByText("$747.00 off")).toBeTruthy();
    expect(screen.queryByText(/33\.2/)).toBeNull();
  });

  it("still states a percentage discount as a percentage", () => {
    render(<QuoteSummary quote={DISCOUNTED_QUOTE} />);
    expect(screen.getByText("20% off")).toBeTruthy();
  });

  it("says 'Included' at 100%, whichever lever got there", () => {
    render(<QuoteSummary quote={DISCOUNTED_QUOTE} />);
    expect(screen.getByText("Included")).toBeTruthy();
  });

  it("says '100% off' on the free first kiosk — it reads as a discount (2026-10-29)", () => {
    render(<QuoteSummary quote={{ ...DISCOUNTED_QUOTE, lines: [
      { hubspotProductId: "222497165009", name: "Kiosk 27\" + Payment Terminal (AMS1) and Mount", qty: 1, unitPrice: 999, billingFrequency: "one_time", productType: "inventory", discountPercent: 100, firstKiosk: true },
    ] }} />);
    expect(screen.getByText("100% off")).toBeTruthy();
    expect(screen.queryByText("Included")).toBeNull();
  });

  it("prices the cash-discounted line at the figure the rep agreed", () => {
    // 3 × $749 = $2,247, less $747, is $1,500.00 exactly.
    render(<QuoteSummary quote={DISCOUNTED_QUOTE} />);
    expect(screen.getByText("$1,500.00")).toBeTruthy();
  });
});

// ── Recurring lines render under "Software" ─────────────────────────────────
// Renamed from "Ongoing" 2026-10-15 (product owner).
const RECURRING_ONLY_QUOTE: CustomerSafeQuote = {
  basis: "products",
  lines: [
    { hubspotProductId: "217526517443", name: "AIO Platform", qty: 1, unitPrice: 399, billingFrequency: "monthly", productType: "Software" },
  ],
  lineTotals: { oneTime: 0, recurring: [{ frequency: "monthly", amount: 399 }], monthlyEquivalent: 399 },
  orderPoints: null,
  payment: null,
  oneTimeInvoiced: true, invoice: null,
};

describe("QuoteSummary — recurring section heading", () => {
  it("labels the recurring section 'Software', not 'Ongoing'", () => {
    render(<QuoteSummary quote={RECURRING_ONLY_QUOTE} />);
    expect(screen.getByText("Software")).toBeTruthy();
    expect(screen.queryByText("Ongoing")).toBeNull();
  });
});

// ── Package-covered one-time lines are grouped separately ───────────────────
// A pre-made package (or a plan-included item) covers a one-time line at MSRP
// less a 100% discount, carrying `coveredByPackage` with the package/plan
// name (lib/quotePackages.ts, types/merchant.ts). The customer preview groups
// those under their own heading rather than interleaving them with what's
// actually being charged (2026-10-15, "block the preview by package and not
// package").
const PACKAGE_QUOTE: CustomerSafeQuote = {
  basis: "products",
  lines: [
    { hubspotProductId: "217445755632", name: "POS Unit", qty: 2, unitPrice: 749, billingFrequency: "one_time", productType: "inventory", discountPercent: 100, coveredByPackage: "QSR Kit" },
    { hubspotProductId: "223452690133", name: "Onsite Installation", qty: 1, unitPrice: 999, billingFrequency: "one_time", productType: "Service", discountPercent: 100, coveredByPackage: "QSR Kit" },
    { hubspotProductId: "223511653105", name: "Payment Terminal - AMS1", qty: 1, unitPrice: 300, billingFrequency: "one_time", productType: "inventory" },
  ],
  lineTotals: { oneTime: 300, recurring: [], monthlyEquivalent: 0 },
  orderPoints: null,
  payment: null,
  oneTimeInvoiced: true, invoice: null,
};

describe("QuoteSummary — package-covered lines are grouped, not interleaved", () => {
  it("groups covered lines under a heading naming the package", () => {
    render(<QuoteSummary quote={PACKAGE_QUOTE} />);
    expect(screen.getByText("Included in your QSR Kit")).toBeTruthy();
  });

  it("shows covered lines as 'Included' rather than a $0.00 charge", () => {
    render(<QuoteSummary quote={PACKAGE_QUOTE} />);
    expect(screen.getAllByText("Included")).toHaveLength(2);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("still shows the list price struck through on a covered line", () => {
    render(<QuoteSummary quote={PACKAGE_QUOTE} />);
    // 2 × $749 = $1,498.00
    expect(screen.getByText("$1,498.00")).toBeTruthy();
  });

  it("keeps the uncovered line priced normally, outside the package heading", () => {
    render(<QuoteSummary quote={PACKAGE_QUOTE} />);
    const name = screen.getByText("Payment Terminal - AMS1");
    const row = name.parentElement?.parentElement; // the name sits beside its description
    expect(row?.textContent).toContain("$300.00");
  });

  it("the invoice total still reflects only what's actually charged", () => {
    render(<QuoteSummary quote={PACKAGE_QUOTE} />);
    const total = screen.getByText("Invoice total").closest("div");
    expect(total?.textContent).toContain("$300.00");
  });
});

describe("QuoteSummary — one-time lines are invoiced separately", () => {
  const PRE_AUTH = {
    hubspotProductId: "281354281678", name: "AIO Pre Auth", qty: 1, unitPrice: 0.5,
    billingFrequency: "one_time" as const, productType: "Service",
  };

  it("labels the one-time section as a separate invoice, paid by the merchant", () => {
    render(<QuoteSummary quote={PACKAGE_QUOTE} />);
    expect(screen.getByText("One-Time — invoiced separately")).toBeTruthy();
    expect(screen.getByText(/fill in your payment details to pay it/)).toBeTruthy();
  });

  // The pre-auth is the one one-time charge the quote's own checkout takes, so
  // it sits apart from the invoice and out of its total.
  // Published before split billing: its one-time lines are on the HubSpot
  // quote and paid at checkout, so it keeps the old single list.
  it("keeps a quote published before split billing as one list, due once", () => {
    render(<QuoteSummary quote={{ ...PACKAGE_QUOTE, oneTimeInvoiced: false }} />);
    expect(screen.queryByText("One-Time — invoiced separately")).toBeNull();
    expect(screen.getByText("One-Time")).toBeTruthy();
    expect(screen.getByText("Total due once").closest("div")?.textContent).toContain("$300.00");
    expect(screen.queryByText(/fill in your payment details to pay it/)).toBeNull();
  });

  it("shows the pre-auth as due at checkout, not on the invoice", () => {
    const quote = { ...PACKAGE_QUOTE, lines: [...PACKAGE_QUOTE.lines, PRE_AUTH] };
    render(<QuoteSummary quote={quote} />);
    const checkout = screen.getByText("Due at checkout").closest("section");
    expect(checkout?.textContent).toContain("AIO Pre Auth");
    expect(screen.getByText("Invoice total").closest("div")?.textContent).toContain("$300.00");
  });

  it("renders no package heading when nothing is package-covered", () => {
    render(<QuoteSummary quote={DISCOUNTED_QUOTE} />);
    expect(screen.queryByText(/Included in your/)).toBeNull();
  });
});

describe("QuoteSummary — payroll box, ordering points, payment order", () => {
  const MIXED: CustomerSafeQuote = {
    ...CONFIG_QUOTE_NO_SAVINGS,
    basis: "products",
    lines: [
      { hubspotProductId: "217526517443", name: "AIO Platform", qty: 1, unitPrice: 399, billingFrequency: "monthly", productType: "Software" },
      { hubspotProductId: "223152695998", name: "Payroll", qty: 1, unitPrice: 39, billingFrequency: "monthly", productType: "Software" },
      { hubspotProductId: "335280960199", name: "Additional Software License", qty: 2, unitPrice: 19, billingFrequency: "monthly", productType: "Software" },
    ],
    lineTotals: { oneTime: 0, recurring: [{ frequency: "monthly", amount: 476 }], monthlyEquivalent: 476 },
  } as CustomerSafeQuote;

  it("renders payroll in its own section with its own total, out of Software", () => {
    render(<QuoteSummary quote={MIXED} />);
    const payroll = screen.getByText("Payroll", { selector: "h2" }).closest("section")!;
    const software = screen.getByText("Software", { selector: "h2" }).closest("section")!;
    expect(payroll.textContent).toContain("$39.00/mo");
    expect(software.textContent).not.toContain("Payroll");
    expect(software.textContent).toContain("$437.00/mo");
    expect(software.textContent).not.toContain("$476.00");
  });

  it("shows the license line as an ordering point", () => {
    render(<QuoteSummary quote={MIXED} />);
    expect(screen.getByText("Additional Ordering Point ×2")).toBeTruthy();
    expect(screen.queryByText(/license/i)).toBeNull();
  });

  it("renders Payment Details last", () => {
    render(<QuoteSummary quote={MIXED} />);
    const headings = screen.getAllByRole("heading", { level: 2 }).map(h => h.textContent);
    expect(headings[headings.length - 1]).toBe("Payment Details");
  });
});
