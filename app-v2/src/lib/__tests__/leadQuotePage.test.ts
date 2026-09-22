import { describe, it, expect, vi, beforeEach } from "vitest";

// /lead/[token]/quote/page.tsx — the second, independent enforcement point
// for the demo gate (the checklist page never calls buildCustomerSafeQuote at
// all pre-demo; the two API routes refuse with 409 demo_not_held; this route
// redirects back to the checklist rather than trusting that nobody linked
// here directly).

const buildCustomerSafeQuote = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});

type Row = Record<string, unknown> & { id: string };
let row: Row | null = null;

const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/leadQuote", () => ({ buildCustomerSafeQuote }));
vi.mock("next/navigation", () => ({ redirect }));

const { default: LeadQuotePage } = await import("@/app/lead/[token]/quote/page");

const TOKEN = "tok-1";
const NOW = new Date("2026-08-21T19:49:38.000Z");
vi.useFakeTimers({ toFake: ["Date"], now: NOW });

const HELD_DEMO = {
  bookedAt: null, heldAt: "2026-08-10T18:00:00.000Z", source: "manual" as const,
  meetingId: null, meetingTitle: null, outcome: null,
  markedByUserId: "rep-1", checkedAt: "2026-08-10T18:00:00.000Z",
  lastSyncError: null, lastSyncErrorAt: null,
};

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
    demo: HELD_DEMO,
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
  redirect.mockClear();
  row = baseRow();
});

describe("the demo gate", () => {
  it("redirects to the checklist when the demo hasn't been held", async () => {
    row = baseRow({ demo: null });
    await expect(page()).rejects.toThrow(`REDIRECT:/lead/${TOKEN}`);
    expect(buildCustomerSafeQuote).not.toHaveBeenCalled();
  });

  it("renders once the demo is held, without redirecting", async () => {
    buildCustomerSafeQuote.mockReturnValue({ basis: "config", monthlyVolume: 1000 });
    await page();
    expect(redirect).not.toHaveBeenCalled();
    expect(buildCustomerSafeQuote).toHaveBeenCalledTimes(1);
  });
});

describe("invalid / expired links", () => {
  it("does not redirect an unknown token — it shows its own invalid-link state", async () => {
    row = null;
    const el = await page();
    expect(redirect).not.toHaveBeenCalled();
    expect(JSON.stringify(el)).toContain("Invalid Link");
  });
});
