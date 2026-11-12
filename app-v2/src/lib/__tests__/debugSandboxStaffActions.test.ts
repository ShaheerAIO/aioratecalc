// DEBUG-SANDBOX: debug-only test (branch debug/team-preview), never merge.
//
// Staff actions under DEBUG_SANDBOX=true, against the REAL email and HubSpot
// adapters (fetch stubbed): the onboarding-link send refuses before it moves
// the stage or mints a login token; an admin approval still saves but neither
// the rep's email nor the HubSpot ticket close leaves the process.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const saveApplication = vi.fn();
const dbInsert = vi.fn();
const getStaffRecipient = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ db: { insert: dbInsert } }));
vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplication, saveApplication } }));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote: vi.fn() }));
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany: vi.fn() }));
vi.mock("@/lib/staff", () => ({ getStaffRecipient }));
vi.mock("@/lib/quoteEvaluation", () => ({
  appBaseUrl: () => "https://preview.example.com",
  approvalCovers: () => true,
  evaluateQuoteOverrides: vi.fn().mockResolvedValue([]),
}));

const fetchMock = vi.fn();

const { SANDBOX_MESSAGE } = await import("@/lib/debug/sandbox");
const { sendMerchantOnboardingLinkAction, markApplicationClosedLostAction } = await import("@/lib/actions/applications");
const { approveQuoteAction } = await import("@/lib/actions/quoteApproval");

const APP = {
  id: "app-1", ownerUserId: "rep-1", stage: "quote_accepted", quoteStatus: "pending_approval",
  quoteApproval: { overrides: [], fingerprint: "f", requestedAt: "2026-11-10T00:00:00.000Z", requestedByUserId: "rep-1", ticketId: "t-1" },
  customerLinkToken: null, ownerContact: { email: "o@x.com" }, business: { legalName: "Acme LLC" },
} as unknown as MerchantApplication;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["DEBUG_SANDBOX", "RESEND_API_KEY", "HUBSPOT_PRIVATE_APP_TOKEN"]) saved[k] = process.env[k];
  process.env.DEBUG_SANDBOX = "true";
  process.env.RESEND_API_KEY = "re_test";
  process.env.HUBSPOT_PRIVATE_APP_TOKEN = "pat-test";
  fetchMock.mockReset();
  // Reads answer (the ticket pipeline lookup); a write must never be attempted.
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({
    id: "p", stages: [{ id: "open", displayOrder: 0 }, { id: "closed", displayOrder: 1, metadata: { ticketState: "CLOSED" } }],
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  getApplication.mockResolvedValue(APP);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const nonGetCalls = () =>
  fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") !== "GET");

describe("sendMerchantOnboardingLinkAction", () => {
  it("refuses before the stage move and the login token", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
    await expect(sendMerchantOnboardingLinkAction("app-1")).rejects.toThrow(SANDBOX_MESSAGE);
    expect(saveApplication).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pure DB edits", () => {
  it("markApplicationClosedLostAction saves", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
    const updated = await markApplicationClosedLostAction("app-1");
    expect(updated.stage).toBe("closed_lost");
    expect(saveApplication).toHaveBeenCalledTimes(1);
  });

  it("approveQuoteAction saves the approval; the rep email and ticket close never leave", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin", name: "Admin" });
    getStaffRecipient.mockImplementation(async (id: string) => ({ id, email: `${id}@aioapp.com`, name: id }));
    const result = await approveQuoteAction("app-1");
    expect(result.quoteStatus).toBe("approved");
    expect(result.repNotified).toBe(false);
    expect(saveApplication).toHaveBeenCalledTimes(1);
    expect(nonGetCalls()).toEqual([]);
  });
});
