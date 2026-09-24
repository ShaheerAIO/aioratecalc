import { describe, it, expect, vi, beforeEach } from "vitest";

// /lead/[token]/quote/page.tsx — the token host's quote/upload step.

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
});

describe("invalid / expired links", () => {
  it("shows its own invalid-link state for an unknown token, building nothing", async () => {
    row = null;
    const el = await page();
    expect(buildCustomerSafeQuote).not.toHaveBeenCalled();
    expect(JSON.stringify(el)).toContain("Invalid Link");
  });
});
