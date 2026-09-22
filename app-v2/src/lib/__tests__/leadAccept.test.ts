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
// leadAcceptBilling.test.ts — this file is about the acceptance wiring, and a
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

// Every acceptance test in this file is about what happens AFTER the demo
// gate, so the row defaults to a held demo — the same posture as a customer
// who reached the accept route for real, through the checklist. The
// `demo_not_held` describe block below overrides this back to null.
const HELD_DEMO = {
  bookedAt: null, heldAt: "2026-08-10T18:00:00.000Z", source: "manual" as const,
  meetingId: null, meetingTitle: null, outcome: null,
  markedByUserId: "rep-1", checkedAt: "2026-08-10T18:00:00.000Z",
  lastSyncError: null, lastSyncErrorAt: null,
};

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
    demo: HELD_DEMO,
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

  it("accepts a marketing-only quote, whose basis is its priced lines", async () => {
    row = baseRow({ quoteType: "marketing_only", quoteConfig: null, quoteLines: MARKETING_LINES });
    const res = await post();
    expect(res.status).toBe(200);
    expect(syncDealFromApplication).toHaveBeenCalledTimes(1);
  });

  it("refuses a marketing-only quote with no lines on it yet", async () => {
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

  it("hands the billing build the row's existing deal id", async () => {
    await post();
    expect(buildAndPublishBillingQuote.mock.calls[0][0].hubspotDealId).toBe("deal-99");
    expect(buildAndPublishBillingQuote.mock.calls[0][1]).toEqual({ acceptedByEmail: "ana@tortapalace.com" });
  });

  it("still logs the customer in when the billing build blows up", async () => {
    buildAndPublishBillingQuote.mockRejectedValue(new Error("HubSpot 500"));
    const res = await post();
    // The acceptance is already recorded and the email already sent — a billing
    // failure must never cost the customer their login.
    expect(res.status).toBe(200);
    expect(sendMagicLinkEmail).toHaveBeenCalled();
    expect(loginTokens).toHaveLength(1);
  });

  it("refuses a link with no quote basis at all", async () => {
    row = baseRow({ quoteConfig: null });
    const res = await post();
    expect(res.status).toBe(409);
    expect(syncDealFromApplication).not.toHaveBeenCalled();
  });
});

describe("the demo gate", () => {
  it("refuses acceptance before the demo is held, even with a quote basis on the row", async () => {
    row = baseRow({ demo: null });
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("demo_not_held");
    expect(syncDealFromApplication).not.toHaveBeenCalled();
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("accepts once the demo is held", async () => {
    row = baseRow({ demo: { ...HELD_DEMO } });
    const res = await post();
    expect(res.status).toBe(200);
  });
});
