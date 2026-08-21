import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QuoteLine } from "@/types/merchant";

// The public accept route, exercised as a route handler. Its collaborators are
// stubbed the same way the Server Action tests stub theirs; `rowToApp`,
// `hasQuoteBasis` and `shouldAdvance` are deliberately the real ones, because
// what's under test is the wiring between them — a hand-rolled fake row shape
// would have hidden both bugs this file covers (a marketing-only quote refused
// as "no quote yet", and acceptance never reaching HubSpot at all).

const pushToHubSpot = vi.fn();
const sendMagicLinkEmail = vi.fn();

type Row = Record<string, unknown> & { id: string };

let row: Row | null = null;
const patches: Array<Record<string, unknown>> = [];
const loginTokens: Array<Record<string, unknown>> = [];

// Minimal chainable stand-in for the three drizzle shapes this route uses:
// select→from→where→limit, insert→values, and update→set→where — where the
// update's `.where()` is both awaited directly (the hubspotDealId write) and
// `.returning()`-ed (the acceptance write), so it's a promise carrying a method.
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }) }),
  update: () => ({
    set: (patch: Record<string, unknown>) => {
      patches.push(patch);
      if (row) row = { ...row, ...patch };
      const applied = row ? [{ ...row }] : [];
      return {
        where: () => Object.assign(Promise.resolve(undefined), { returning: async () => applied }),
      };
    },
  }),
  insert: () => ({ values: async (v: Record<string, unknown>) => { loginTokens.push(v); } }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail }));
vi.mock("@/lib/adapters/hubspot", () => ({ pushToHubSpot }));

const { POST } = await import("@/app/api/lead/[token]/accept/route");

const TOKEN = "tok-1";
const NOW = new Date("2026-08-21T19:49:38.000Z");

const MARKETING_LINES: QuoteLine[] = [
  { name: "AIO Marketing Platform", hubspotProductId: "223152695997", qty: 1, unitPrice: 49, billingFrequency: "weekly", productType: "Software" },
];

function baseRow(extra: Partial<Row> = {}): Row {
  return {
    id: "prospect-1",
    ownerUserId: "rep-1",
    customerUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    stage: "quote_sent",
    hubspotDealId: null,
    tenantLink: { hubspotCompanyId: "334295287484", companyName: "Torta Palace", tenantRef: null, adyenAccountHolderId: null, linkedAt: NOW.toISOString(), linkedByUserId: "rep-1" },
    adyenIds: null,
    adyenOnboardingUrl: null,
    checkIds: null,
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

const post = (email = "ana@tortapalace.com") =>
  POST(
    { json: async () => ({ email }) } as never,
    { params: Promise.resolve({ token: TOKEN }) }
  );

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pushToHubSpot.mockReset();
  sendMagicLinkEmail.mockReset();
  patches.length = 0;
  loginTokens.length = 0;
  row = baseRow();
  pushToHubSpot.mockResolvedValue("deal-99");
  sendMagicLinkEmail.mockResolvedValue({ sent: true, devUrl: null });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

describe("accepting a quote", () => {
  it("pushes the deal to HubSpot and stores the id", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(pushToHubSpot).toHaveBeenCalledTimes(1);
    // The stage the push carries is the accepted one, not the pre-acceptance
    // row — the deal must land in HubSpot as accepted, not as quote_sent.
    expect(pushToHubSpot.mock.calls[0][0].stage).toBe("quote_accepted");
    expect(patches.some(p => p.hubspotDealId === "deal-99")).toBe(true);
  });

  it("still logs the customer in when HubSpot is down", async () => {
    pushToHubSpot.mockRejectedValue(new Error("HUBSPOT_BILLING_PRIVATE_APP_TOKEN is not set"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(loginTokens).toHaveLength(1);
    expect(sendMagicLinkEmail).toHaveBeenCalled();
    expect(patches.some(p => "hubspotDealId" in p)).toBe(false);
  });

  it("accepts a marketing-only quote, whose basis is its priced lines", async () => {
    row = baseRow({ quoteType: "marketing_only", quoteConfig: null, quoteLines: MARKETING_LINES });
    const res = await post();
    expect(res.status).toBe(200);
    expect(pushToHubSpot).toHaveBeenCalledTimes(1);
  });

  it("refuses a marketing-only quote with no lines on it yet", async () => {
    row = baseRow({ quoteType: "marketing_only", quoteConfig: null, quoteLines: [] });
    const res = await post();
    expect(res.status).toBe(409);
    expect(pushToHubSpot).not.toHaveBeenCalled();
  });

  it("does not re-push a deal backwards once onboarding has started", async () => {
    row = baseRow({ stage: "adyen_kyc_pending", quoteAcceptedAt: NOW, hubspotDealId: "deal-99" });
    const res = await post();
    expect(res.status).toBe(200);
    // Still synced (the stage may have moved on HubSpot's side), but as the
    // stage the row actually holds.
    expect(pushToHubSpot.mock.calls[0][0].stage).toBe("adyen_kyc_pending");
    // Already the same id — no redundant write.
    expect(patches.some(p => "hubspotDealId" in p)).toBe(false);
  });

  it("refuses a link with no quote basis at all", async () => {
    row = baseRow({ quoteConfig: null });
    const res = await post();
    expect(res.status).toBe(409);
    expect(pushToHubSpot).not.toHaveBeenCalled();
  });
});
