// DEBUG-SANDBOX: debug-only test (branch debug/team-preview), never merge.
//
// The adapter-boundary half of DEBUG_SANDBOX: reads still leave the process,
// writes don't, and email/SMS answer "not sent" as if unconfigured. With the
// flag unset every adapter is a pass-through (same call, same arity).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

const ENV_KEYS = [
  "DEBUG_SANDBOX", "HUBSPOT_PRIVATE_APP_TOKEN", "HUBSPOT_BILLING_PRIVATE_APP_TOKEN", "RESEND_API_KEY",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "CHECK_API_KEY",
  "AIO_DASHBOARD_ENABLED", "AIO_DASHBOARD_BASE_URL", "AIO_DASHBOARD_USERNAME", "AIO_DASHBOARD_PASSWORD",
] as const;
const saved: Record<string, string | undefined> = {};

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HUBSPOT_PRIVATE_APP_TOKEN = "pat-test";
  process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN = "pat-billing-test";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sandboxOn = () => { process.env.DEBUG_SANDBOX = "true"; };

const {
  isSandbox, isSandboxReadRequest, sandboxFetch, assertNotSandbox, SandboxError, SANDBOX_MESSAGE,
} = await import("@/lib/debug/sandbox");
const hubspot = await import("@/lib/adapters/hubspot");
const { sendLeadLinkEmail } = await import("@/lib/adapters/email");
const { sendLeadLinkSms } = await import("@/lib/adapters/sms");
const check = await import("@/lib/adapters/check");
const aio = await import("@/lib/adapters/aioDashboard");

describe("isSandbox / assertNotSandbox", () => {
  it("is off unless DEBUG_SANDBOX is exactly 'true'", () => {
    delete process.env.DEBUG_SANDBOX;
    expect(isSandbox()).toBe(false);
    process.env.DEBUG_SANDBOX = "1";
    expect(isSandbox()).toBe(false);
    expect(() => assertNotSandbox()).not.toThrow();
    sandboxOn();
    expect(isSandbox()).toBe(true);
    expect(() => assertNotSandbox()).toThrow(SANDBOX_MESSAGE);
    expect(() => assertNotSandbox()).toThrow(SandboxError);
  });
});

describe("isSandboxReadRequest", () => {
  it.each([
    ["GET", "https://api.hubapi.com/crm/v3/objects/products?limit=100", true],
    ["HEAD", "https://example.com/x", true],
    ["POST", "https://api.hubapi.com/crm/v3/objects/companies/search", true],
    ["POST", "https://api.hubapi.com/crm/v3/objects/contacts/batch/read", true],
    ["POST", "https://api.hubapi.com/crm/v4/associations/deals/companies/batch/read", true],
    ["POST", "https://api.hubapi.com/crm/v3/objects/deals", false],
    ["POST", "https://api.hubapi.com/crm/v3/objects/deals/batch/update", false],
    ["PATCH", "https://api.hubapi.com/crm/v3/objects/quotes/1", false],
    ["PUT", "https://api.hubapi.com/crm/v4/objects/deals/1/associations/companies/2", false],
    ["DELETE", "https://api.hubapi.com/crm/v3/objects/line_items/1", false],
    // Only HubSpot's read-POSTs pass: a "/search" anywhere else is still a write.
    ["POST", "https://sandbox.checkhq.com/companies/search", false],
    ["POST", "https://graph.microsoft.com/v1.0/users/x/sendMail", false],
    ["POST", "https://api.resend.com/emails", false],
    ["POST", "not a url", false],
  ])("%s %s → %s", (method, url, read) => {
    expect(isSandboxReadRequest(url, method)).toBe(read);
  });
});

describe("sandboxFetch", () => {
  it("off: a pure pass-through with the caller's exact arguments", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await sandboxFetch("https://api.hubapi.com/crm/v3/objects/deals", { method: "POST", body: "{}" });
    await sandboxFetch("https://example.com/only-url");
    expect(fetchMock.mock.calls[0]).toEqual(["https://api.hubapi.com/crm/v3/objects/deals", { method: "POST", body: "{}" }]);
    // Arity preserved: no trailing `undefined` init.
    expect(fetchMock.mock.calls[1]).toEqual(["https://example.com/only-url"]);
  });

  it("on: refuses a write without calling fetch", async () => {
    sandboxOn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      sandboxFetch("https://api.hubapi.com/crm/v3/objects/deals", { method: "POST", body: "{}" })
    ).rejects.toBeInstanceOf(SandboxError);
    await expect(
      sandboxFetch(new Request("https://api.hubapi.com/crm/v3/objects/quotes/1", { method: "PATCH" }))
    ).rejects.toThrow(/Blocked: PATCH api\.hubapi\.com\/crm\/v3\/objects\/quotes\/1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on: lets reads through", async () => {
    sandboxOn();
    fetchMock.mockResolvedValue(json({ results: [] }));
    await sandboxFetch("https://api.hubapi.com/crm/v3/objects/products?limit=1");
    await sandboxFetch("https://api.hubapi.com/crm/v3/objects/companies/search", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("HubSpot adapter under DEBUG_SANDBOX", () => {
  it("writes are refused before any request leaves", async () => {
    sandboxOn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Reads (the ticket pipeline lookup) answer; anything else must never be attempted.
    fetchMock.mockImplementation(async () =>
      json({ id: "p", stages: [{ id: "open", displayOrder: 0 }, { id: "closed", displayOrder: 1, metadata: { ticketState: "CLOSED" } }] })
    );
    await expect(hubspot.createDeal({ name: "X", companyId: "1" })).rejects.toThrow(SANDBOX_MESSAGE);
    await expect(hubspot.setDealBillingNotes("1", "note")).rejects.toThrow(SANDBOX_MESSAGE);
    await expect(hubspot.closeApprovalTicket("1")).rejects.toThrow(SANDBOX_MESSAGE);
    await expect(hubspot.publishQuote("1", { senderEmail: "a@b.c" } as never)).rejects.toThrow(SANDBOX_MESSAGE);
    await expect(hubspot.createDraftInvoice({})).rejects.toThrow(SANDBOX_MESSAGE);
    await expect(hubspot.deleteQuoteLineItem("1")).rejects.toThrow(SANDBOX_MESSAGE);
    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET");
    expect(methods.every(m => m === "GET")).toBe(true);
  });

  it("reads still work: company search (POST /search) and a GET", async () => {
    sandboxOn();
    fetchMock.mockImplementation(async () => json({ results: [] }));
    await expect(hubspot.searchTenantCompanies("acme")).resolves.toEqual([]);
    await hubspot.getTenantCompany("123").catch(() => null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.hubapi.com/crm/v3/objects/companies/search");
  });

  it("off: a write goes out exactly as before", async () => {
    fetchMock.mockResolvedValue(json({ id: "999" }));
    await hubspot.setDealBillingNotes("1", "note").catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("email and SMS under DEBUG_SANDBOX", () => {
  it("email answers sent:false and never calls a transport", async () => {
    process.env.RESEND_API_KEY = "re_test";
    sandboxOn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendLeadLinkEmail("m@x.com", "https://app/lead/t", "Acme")).resolves.toEqual({
      sent: false, devUrl: "https://app/lead/t",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("email off: Resend is called as before", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchMock.mockResolvedValue(json({ id: "e1" }));
    const result = await sendLeadLinkEmail("m@x.com", "https://app/lead/t", "Acme");
    expect(result.sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SMS answers sent:false and never calls Twilio", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "t";
    process.env.TWILIO_FROM_NUMBER = "+15550000000";
    sandboxOn();
    await expect(sendLeadLinkSms("5551234567", "https://app/lead/t")).resolves.toEqual({
      sent: false, devUrl: "https://app/lead/t",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Check and the AIO dashboard under DEBUG_SANDBOX", () => {
  const app = {
    id: "app-1",
    business: { legalName: "Acme LLC", dba: "Acme", address: "1 Main", city: "X", state: "NY", zip: "10001" },
    ownerContact: { email: "o@x.com", firstName: "O", lastName: "W", phone: "5551234567" },
    processing: { mcc: "5812" },
  } as unknown as MerchantApplication;

  it("Check: company creation and onboard links are refused; the status read still goes out", async () => {
    process.env.CHECK_API_KEY = "ck";
    sandboxOn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(check.createCheckCompany(app, "2026-12-01")).rejects.toThrow(SANDBOX_MESSAGE);
    await expect(check.createCheckOnboardLink("co_1", { name: "O", title: "Owner", email: "o@x.com" })).rejects.toThrow(SANDBOX_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(json({ onboard: { status: "completed" } }));
    await expect(check.getCheckOnboardStatus("co_1")).resolves.toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("AIO dashboard: provisioning never reaches AIO (its login is a POST)", async () => {
    process.env.AIO_DASHBOARD_ENABLED = "true";
    process.env.AIO_DASHBOARD_BASE_URL = "https://backend.example.aioapp.com";
    process.env.AIO_DASHBOARD_USERNAME = "svc";
    process.env.AIO_DASHBOARD_PASSWORD = "pw";
    aio.__resetAioSession();
    sandboxOn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(aio.createAioBusiness(app, { alias: "easyob_app_1" })).rejects.toThrow(SANDBOX_MESSAGE);
    await expect(aio.createAioAdyenOnboardingLink({ businessId: 1, locationId: 2 } as never)).rejects.toThrow(SANDBOX_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
