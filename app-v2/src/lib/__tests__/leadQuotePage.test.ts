import { describe, it, expect, vi, beforeEach } from "vitest";

// /lead/[token]/quote/page.tsx — the token host's quote step.

const buildCustomerSafeQuote = vi.fn();

type Row = Record<string, unknown> & { id: string };
let row: Row | null = null;

const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/leadQuote", () => ({ buildCustomerSafeQuote }));

const { default: LeadQuotePage } = await import("@/app/lead/[token]/quote/page");

const TOKEN = "tok-1";
const NOW = new Date("2026-08-21T19:49:38.000Z");
vi.useFakeTimers({ toFake: ["Date"], now: NOW });

function baseRow(extra: Partial<Row> = {}): Row {
  return {
    id: "app-1",
    ownerUserId: "rep-1",
    customerUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    stage: "quote_sent",
    hubspotDealId: null,
    dealLink: null,
    tenantLink: null,
    adyenIds: null,
    adyenOnboardingUrl: null,
    checkIds: null,
    foodbuyIds: null,
    hubspotIds: null,
    quoteType: "full_pos",
    quoteConfig: { monthlyVolume: 1000, avgTicket: 100 },
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
    targetMargin: "0.019000",
    pricingModel: "2-tier",
    customerLinkToken: TOKEN,
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: NOW,
    customerLinkExpiresAt: new Date("2026-09-04T00:00:00.000Z"),
    analysis: null,
    proposal: null,
    business: { legalName: "Torta Palace LLC", dba: "Torta Palace" },
    ownerContact: null,
    processing: null,
    agreement: null,
    ...extra,
  };
}

const page = () => LeadQuotePage({ params: Promise.resolve({ token: TOKEN }) });

// The rendered tree flattened to "every string in it, plus the name of every
// component in it". JSON.stringify can't be used on a tree holding a component
// reference (LeadQuoteView) — it's circular — and the component's NAME is
// exactly what these tests need to assert on anyway.
function flatten(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out; }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof el.type === "function") out.push((el.type as { name?: string }).name ?? "");
  flatten(el.props?.children, out);
  return out;
}
const text = async () => flatten(await page()).join(" ").toLowerCase();

beforeEach(() => {
  buildCustomerSafeQuote.mockReset();
  row = baseRow();
});

describe("the quote step", () => {
  it("builds the customer-safe quote exactly once for a valid token", async () => {
    buildCustomerSafeQuote.mockReturnValue({ basis: "config", monthlyVolume: 1000 });
    await page();
    expect(buildCustomerSafeQuote).toHaveBeenCalledTimes(1);
  });

  // The statement upload is GONE from the customer side (2026-10-13). It used
  // to be what this page rendered whenever buildCustomerSafeQuote came back
  // null, which is how a merchant with a published HubSpot quote ended up
  // being asked for a statement instead of being sent to their checkout.
  it("never asks the customer for a statement when there is no quote", async () => {
    buildCustomerSafeQuote.mockReturnValue(null);
    const rendered = await text();
    expect(rendered).not.toContain("statement");
    expect(rendered).not.toContain("upload");
    expect(rendered).toContain("your quote is on its way");
  });

  it("renders the quote itself, and no page-level fallback, when there is one", async () => {
    buildCustomerSafeQuote.mockReturnValue({ basis: "products", lines: [], lineTotals: null, orderPoints: null });
    const rendered = await text();
    expect(rendered).toContain("leadquoteview");
    expect(rendered).not.toContain("your quote is on its way");
  });
});

describe("invalid / expired links", () => {
  it("shows its own invalid-link state for an unknown token, building nothing", async () => {
    row = null;
    const el = await page();
    expect(buildCustomerSafeQuote).not.toHaveBeenCalled();
    expect(JSON.stringify(el)).toContain("Invalid Link");
  });
});
