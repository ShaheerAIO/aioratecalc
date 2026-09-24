import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QuoteLine } from "@/types/merchant";

// The public accept route, exercised as a route handler. Its collaborators are
// stubbed the same way the Server Action tests stub theirs; `rowToApp`,
// `hasQuoteBasis` and `shouldAdvance` are deliberately the real ones, because
// what's under test is the wiring between them — a hand-rolled fake row shape
// would have hidden both bugs this file covers (a marketing-only quote refused
// as "no quote yet", and acceptance never reaching HubSpot at all).
//
// Under the mandatory-deal model a row reaches this route with a
// `hubspotDealId` already on it (`createProspectAction` resolves one before
// the row exists), so the deal sync here is PATCH-only (`syncDealFromApplication`,
// formerly `pushToHubSpot`) — it is a no-op for the sole remaining exception, a
// legacy row created before deal adoption existed.

const syncDealFromApplication = vi.fn();
const sendMagicLinkEmail = vi.fn();
// The Phase E billing build is stubbed here and exercised for real in
// publishBillingQuote.test.ts — this file is about the acceptance wiring, and a
// real orchestrator would drag the whole HubSpot quote graph into every case.
const buildAndPublishBillingQuote = vi.fn();

type Row = Record<string, unknown> & { id: string };

let row: Row | null = null;
const patches: Array<Record<string, unknown>> = [];
const loginTokens: Array<Record<string, unknown>> = [];

// Minimal chainable stand-in for the three drizzle shapes this route uses:
// select→from→where→limit, insert→values, and update→set→where — where the
// update's `.where()` is both awaited directly and `.returning()`-ed (the
// acceptance write), so it's a promise carrying a method.
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
// Partial mock: the pure helpers — including the tenant-link gate — stay real,
// only the network call is stubbed.
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  syncDealFromApplication,
}));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote }));

const { POST } = await import("@/app/api/lead/[token]/accept/route");

const TOKEN = "tok-1";
const NOW = new Date("2026-08-21T19:49:38.000Z");

// The clock is pinned: the fixture row carries a fixed customerLinkExpiresAt,
// and against a real clock every case in this file silently turned into a 410
// the day that date passed. Only Date is faked — the billing build waits on a
// real setTimeout for hs_quote_link.
vi.useFakeTimers({ toFake: ["Date"], now: NOW });

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
    // A deal already on the row is the normal, new-model case — it's resolved
    // at prospect creation, long before a customer ever reaches this route.
    // Individual tests below override this to null to exercise the one
    // remaining case that leaves: a legacy row from before deal adoption
    // existed.
    hubspotDealId: "deal-99",
    dealLink: null,
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
// The route logs the billing outcome; silenced so the suite output stays readable.
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  syncDealFromApplication.mockReset();
  sendMagicLinkEmail.mockReset();
  buildAndPublishBillingQuote.mockReset();
  buildAndPublishBillingQuote.mockResolvedValue({ status: "skipped", reason: "nothing_to_bill" });
  patches.length = 0;
  loginTokens.length = 0;
  row = baseRow();
  syncDealFromApplication.mockResolvedValue("deal-99");
  sendMagicLinkEmail.mockResolvedValue({ sent: true, devUrl: null });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe("accepting a quote", () => {
  it("syncs the deal to HubSpot (PATCH-only) when one already exists", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(syncDealFromApplication).toHaveBeenCalledTimes(1);
    // The stage the sync carries is the accepted one, not the pre-acceptance
    // row — the deal must land in HubSpot as accepted, not as quote_sent.
    expect(syncDealFromApplication.mock.calls[0][0].stage).toBe("quote_accepted");
    // A PATCH can't change the id it's targeting — nothing to persist locally.
    expect(patches.some(p => "hubspotDealId" in p)).toBe(false);
  });

  it("still logs the customer in when HubSpot is down", async () => {
    syncDealFromApplication.mockRejectedValue(new Error("HUBSPOT_BILLING_PRIVATE_APP_TOKEN is not set"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(loginTokens).toHaveLength(1);
    expect(sendMagicLinkEmail).toHaveBeenCalled();
  });

  // THE gate this route now exists behind. A quote with billable lines is
  // signed and paid on HubSpot's hosted page — that IS the acceptance — so
  // accepting it here would record one the merchant never made.
  it("refuses a quote that has billable lines — those are accepted on HubSpot", async () => {
    row = baseRow({ quoteType: "marketing_only", quoteConfig: null, quoteLines: MARKETING_LINES });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("billed_quote");
    expect(syncDealFromApplication).not.toHaveBeenCalled();
    expect(loginTokens).toHaveLength(0);
  });

  it("refuses a marketing-only quote with no lines on it yet", async () => {
    // Refused earlier, by hasQuoteBasis — a marketing-only quote's basis IS
    // its lines, so an empty one is "no quote yet", not a rate-only quote.
    row = baseRow({ quoteType: "marketing_only", quoteConfig: null, quoteLines: [] });
    const res = await post();
    expect(res.status).toBe(409);
    expect(syncDealFromApplication).not.toHaveBeenCalled();
  });

  it("re-opening an accepted link only re-issues the login, touching no CRM state", async () => {
    // "Email Me a New Link" comes through this same route. It means the
    // merchant lost their login, nothing more — syncing again here would be
    // pointless CRM traffic for a no-op acceptance.
    row = baseRow({ stage: "adyen_kyc_pending", quoteAcceptedAt: NOW, hubspotDealId: "deal-99" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(loginTokens).toHaveLength(1);
    expect(syncDealFromApplication).not.toHaveBeenCalled();
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("keeps the original acceptance timestamp and stage on a re-open", async () => {
    row = baseRow({ stage: "adyen_kyc_pending", quoteAcceptedAt: NOW, hubspotDealId: "deal-99" });
    await post();
    expect(row!.stage).toBe("adyen_kyc_pending"); // forward-only, never dragged back
    expect(row!.quoteAcceptedAt).toEqual(NOW);
  });

  it("does nothing for a legacy row with no HubSpot deal at all", async () => {
    // syncDealFromApplication has no CREATE branch any more — a null
    // hubspotDealId is only reachable on a row from before deal adoption
    // existed, and its recovery is adoptDealAction/linkTenantCompanyAction,
    // never this route minting one on the fly.
    row = baseRow({ hubspotDealId: null });
    const res = await post();
    expect(res.status).toBe(200);
    expect(loginTokens).toHaveLength(1); // the customer still gets in
    expect(syncDealFromApplication).not.toHaveBeenCalled();
  });

  it("syncs regardless of whether a HubSpot company is linked — a PATCH needs no association", async () => {
    row = baseRow({ tenantLink: null, hubspotDealId: "deal-legacy" });
    await post();
    expect(syncDealFromApplication).toHaveBeenCalledTimes(1);
  });

  // The publish moved OFF this route entirely. It is the rep's deliberate
  // "Send Quote" click now (sendQuoteAction), which has to happen before the
  // merchant can accept at all — so a rate-only acceptance, the only kind this
  // route still handles, must never touch the billing graph.
  it("never builds or publishes a billing quote — a rate-only quote has nothing to bill", async () => {
    await post();
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("refuses a link with no quote basis at all", async () => {
    row = baseRow({ quoteConfig: null });
    const res = await post();
    expect(res.status).toBe(409);
    expect(syncDealFromApplication).not.toHaveBeenCalled();
  });
});

