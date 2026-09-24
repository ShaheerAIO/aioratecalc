import { describe, it, expect, vi, beforeEach } from "vitest";

// The public statement-analyze route, exercised as a route handler. Same
// pattern as leadAccept.test.ts: a minimal chainable drizzle stand-in, real
// collaborators (buildCustomerSafeQuote, quoteTypeOf/isProcessingQuote,
// shouldAdvance) except the network edge (analyzeStatement/Claude), which is
// stubbed.

const analyzeStatement = vi.fn();

type Row = Record<string, unknown> & { id: string };

let row: Row | null = null;
const patches: Array<Record<string, unknown>> = [];

const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
  update: () => ({
    set: (patch: Record<string, unknown>) => {
      patches.push(patch);
      if (row) row = { ...row, ...patch };
      return { where: async () => undefined };
    },
  }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/claude", () => ({ analyzeStatement }));

const { POST } = await import("@/app/api/lead/[token]/analyze/route");

const TOKEN = "tok-1";
const NOW = new Date("2026-08-21T19:49:38.000Z");
vi.useFakeTimers({ toFake: ["Date"], now: NOW });

function baseRow(extra: Partial<Row> = {}): Row {
  return {
    id: "prospect-1",
    stage: "quote_sent",
    quoteType: "full_pos",
    quoteConfig: { monthlyVolume: 1000, avgTicket: 100 },
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
    targetMargin: "0.019000",
    pricingModel: "2-tier",
    customerLinkToken: TOKEN,
    customerLinkPurpose: "lead_upload",
    customerLinkExpiresAt: new Date("2026-09-04T00:00:00.000Z"),
    analysis: null,
    ...extra,
  };
}

const post = (body: Record<string, unknown> = { fileData: "abc", mediaType: "application/pdf" }) =>
  POST(
    { json: async () => body } as never,
    { params: Promise.resolve({ token: TOKEN }) }
  );

beforeEach(() => {
  analyzeStatement.mockReset();
  patches.length = 0;
  row = baseRow();
  analyzeStatement.mockResolvedValue({
    merchantName: "Torta Palace", totalVolume: 40000, totalFees: 1200, totalTransactions: 800,
    averageTicket: 50, effectiveRate: 0.03, cardPresentVolume: 40000, cardNotPresentVolume: 0,
    currentPricingModel: "tiered",
  });
});

describe("the happy path", () => {
  it("analyzes a statement and returns a quote", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(analyzeStatement).toHaveBeenCalledTimes(1);
  });
});

describe("existing guards, unchanged", () => {
  it("refuses a marketing-only quote — nothing to compare a statement against", async () => {
    row = baseRow({ quoteType: "marketing_only", quoteConfig: null, quoteLines: [] });
    const res = await post();
    expect(res.status).toBe(409);
    expect(analyzeStatement).not.toHaveBeenCalled();
  });

  it("refuses to replace the analysis behind an already-accepted quote", async () => {
    row = baseRow({ quoteAcceptedAt: NOW, stage: "quote_accepted", analysis: null, quoteConfig: null });
    const res = await post();
    expect(res.status).toBe(409);
    expect(analyzeStatement).not.toHaveBeenCalled();
  });

  it("rejects an invalid token", async () => {
    row = null;
    const res = await post();
    expect(res.status).toBe(404);
  });

  it("rejects an expired link", async () => {
    row = baseRow({ customerLinkExpiresAt: new Date("2020-01-01T00:00:00.000Z") });
    const res = await post();
    expect(res.status).toBe(410);
  });
});
