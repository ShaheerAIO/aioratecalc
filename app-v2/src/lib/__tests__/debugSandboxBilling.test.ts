// DEBUG-SANDBOX: debug-only test (branch debug/team-preview), never merge.
//
// The preview runs on the PRODUCTION database, so every send / publish /
// provision path must refuse under DEBUG_SANDBOX=true BEFORE it writes. The
// db stand-in here answers reads and throws on any insert/update/delete, so a
// refusal that came too late fails the test rather than passing quietly.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

const dbWrites: string[] = [];
let selectRows: unknown[] = [];
function selectChain(): unknown {
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(selectRows).then(res, rej);
      }
      return () => chain;
    },
    apply() { return chain; },
  });
  return chain;
}
const refuseWrite = (kind: string) => () => {
  dbWrites.push(kind);
  throw new Error(`db ${kind} under DEBUG_SANDBOX`);
};
const db = { select: () => selectChain(), insert: refuseWrite("insert"), update: refuseWrite("update"), delete: refuseWrite("delete") };

const getEffectiveRole = vi.fn();
const getCustomerSession = vi.fn();
const storage = {
  getApplication: vi.fn(),
  saveApplication: vi.fn(),
  getApplicationForCustomer: vi.fn(),
  updateApplicationAsCustomer: vi.fn(),
};
const getLeadApplicationByToken = vi.fn();
const after = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(), signIn: vi.fn() }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/auth/getCustomerSession", () => ({ getCustomerSession }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: storage }));
vi.mock("@/lib/leadToken", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/leadToken")>()),
  getLeadApplicationByToken,
}));
vi.mock("next/server", async importOriginal => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after,
}));

const fetchMock = vi.fn();

const { SANDBOX_MESSAGE } = await import("@/lib/debug/sandbox");
const { sendQuoteAction, retryOneTimeInvoiceAction } = await import("@/lib/actions/billing");
const { buildAndPublishBillingQuote } = await import("@/lib/billing/publishBillingQuote");
const { buildOneTimeInvoice } = await import("@/lib/billing/oneTimeInvoice");
const { recordAcceptance, applyDetectedAcceptance } = await import("@/lib/billing/acceptance");
const { provisionAioTenant } = await import("@/lib/aio/provision");
const { kickAioProvisioning } = await import("@/lib/aio/kick");
const { createPayrollInvoiceAction } = await import("@/lib/actions/checkPayroll");
const { confirmLeadDetailsAction } = await import("@/lib/actions/leadConfirm");
const { requestCustomerLoginAction, startPayrollOnboardingAction } = await import("@/lib/actions/customer");
const checkoutRoute = await import("@/app/api/lead/[token]/checkout/route");
const acceptRoute = await import("@/app/api/lead/[token]/accept/route");
const crons = {
  "adyen-actuals": await import("@/app/api/cron/adyen-actuals/route"),
  "aio-provisioning": await import("@/app/api/cron/aio-provisioning/route"),
  "hubspot-billing-sync": await import("@/app/api/cron/hubspot-billing-sync/route"),
  "hubspot-links": await import("@/app/api/cron/hubspot-links/route"),
};

const APP = {
  id: "app-1",
  ownerUserId: "rep-1",
  stage: "quote_sent",
  quoteStatus: null,
  quoteAcceptedAt: null,
  detailsConfirmedAt: null,
  hubspotDealId: "deal-1",
  tenantLink: { hubspotCompanyId: "co-1" },
  hubspotIds: { publishedAt: "2026-11-01T00:00:00.000Z", splitBilling: true, quoteId: "q-1", subscriptions: [{ status: "active" }] },
  quoteLines: [{ hubspotProductId: "p1", name: "Kiosk", qty: 1, unitPrice: 100, billingFrequency: "one_time", productType: "" }],
  business: { legalName: "Acme LLC", dba: "Acme", address: "1 Main", city: "X", state: "NY", zip: "10001" },
  ownerContact: { email: "o@x.com", firstName: "O", lastName: "W", phone: "" },
  aioTenant: null,
} as unknown as MerchantApplication;

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.clearAllMocks();
  dbWrites.length = 0;
  selectRows = [];
  for (const k of ["DEBUG_SANDBOX", "CRON_SECRET"]) savedEnv[k] = process.env[k];
  process.env.DEBUG_SANDBOX = "true";
  process.env.CRON_SECRET = "cron-secret";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectNothingWritten() {
  expect(dbWrites).toEqual([]);
  expect(storage.saveApplication).not.toHaveBeenCalled();
  expect(storage.updateApplicationAsCustomer).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
}

describe("staff billing actions refuse in the normal result shape", () => {
  beforeEach(() => getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin", name: "A", isDebug: true }));

  it("sendQuoteAction (Publish Quote Now)", async () => {
    await expect(sendQuoteAction("app-1")).resolves.toEqual({ ok: false, error: SANDBOX_MESSAGE });
    expect(storage.getApplication).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("retryOneTimeInvoiceAction", async () => {
    await expect(retryOneTimeInvoiceAction("app-1")).resolves.toEqual({ ok: false, error: SANDBOX_MESSAGE });
    expectNothingWritten();
  });

  it("createPayrollInvoiceAction (Check usage → HubSpot invoice)", async () => {
    await expect(createPayrollInvoiceAction("csv", "chk-1")).resolves.toEqual({ status: "failed", error: SANDBOX_MESSAGE });
    expectNothingWritten();
  });
});

describe("the shared lib entry points refuse before their build claim", () => {
  it("buildAndPublishBillingQuote: no claim, no lastSyncError", async () => {
    const app = { ...APP, hubspotIds: null };
    await expect(buildAndPublishBillingQuote(app)).resolves.toEqual({ status: "failed", step: "contact", error: SANDBOX_MESSAGE });
    expectNothingWritten();
  });

  it("buildOneTimeInvoice", async () => {
    await expect(buildOneTimeInvoice(APP)).resolves.toEqual({ status: "failed", step: "preflight", error: SANDBOX_MESSAGE });
    expectNothingWritten();
  });

  it("recordAcceptance / applyDetectedAcceptance record nothing", async () => {
    await expect(recordAcceptance(APP, { syncDeal: true })).resolves.toBe(APP);
    await expect(applyDetectedAcceptance(APP)).resolves.toBe(APP);
    expectNothingWritten();
  });

  it("provisionAioTenant is blocked before its claim; kickAioProvisioning schedules nothing", async () => {
    await expect(provisionAioTenant(APP)).resolves.toEqual({ status: "blocked", error: SANDBOX_MESSAGE });
    kickAioProvisioning(APP);
    expect(after).not.toHaveBeenCalled();
    expectNothingWritten();
  });
});

describe("merchant-facing doors refuse", () => {
  it("confirmLeadDetailsAction: formError, the row is not frozen", async () => {
    getLeadApplicationByToken.mockResolvedValue({ ok: true, row: { ...APP, quoteStatus: null, detailsConfirmedAt: null } });
    await expect(confirmLeadDetailsAction("tok", {})).resolves.toEqual({ ok: false, formError: SANDBOX_MESSAGE });
    expectNothingWritten();
  });

  it("POST /api/lead/[token]/checkout → 409 sandbox, before the token is even read", async () => {
    const res = await checkoutRoute.POST(new Request("http://x/api/lead/tok/checkout", { method: "POST" }) as never, {
      params: Promise.resolve({ token: "tok" }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "sandbox" });
    expect(getLeadApplicationByToken).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("POST /api/lead/[token]/accept → 409 with the sandbox message", async () => {
    const req = new Request("http://x/api/lead/tok/accept", { method: "POST", body: JSON.stringify({ email: "o@x.com" }) });
    const res = await acceptRoute.POST(req as never, { params: Promise.resolve({ token: "tok" }) });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: SANDBOX_MESSAGE });
    expectNothingWritten();
  });

  it("requestCustomerLoginAction mints no login token", async () => {
    selectRows = [{ id: "c-1", email: "o@x.com", role: "customer", disabledAt: null }];
    await expect(requestCustomerLoginAction("o@x.com")).resolves.toEqual({ sent: false, devUrl: null });
    expectNothingWritten();
  });

  it("startPayrollOnboardingAction creates no Check company", async () => {
    getCustomerSession.mockResolvedValue({ userId: "c-1" });
    storage.getApplicationForCustomer.mockResolvedValue({ ...APP, checkIds: null });
    await expect(
      startPayrollOnboardingAction("app-1", { startDate: "2026-12-01", signer: { name: "O", title: "Owner", email: "o@x.com" } })
    ).rejects.toThrow(SANDBOX_MESSAGE);
    expectNothingWritten();
  });
});

describe("crons are no-ops (they would act on prod)", () => {
  for (const [name, route] of Object.entries(crons)) {
    it(name, async () => {
      const req = new Request(`http://x/api/cron/${name}`, { headers: { authorization: "Bearer cron-secret" } });
      const res = await route.GET(req as never);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ skipped: "sandbox" });
      expectNothingWritten();
    });
  }

  it("still refuse an unauthenticated caller first", async () => {
    const res = await crons["hubspot-links"].GET(new Request("http://x/api/cron/hubspot-links") as never);
    expect(res.status).toBe(401);
  });
});
