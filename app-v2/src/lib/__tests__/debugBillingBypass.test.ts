import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DEBUG-BILLING-BYPASS — delete with lib/debug/billingBypass.ts.
// What matters is what it does NOT do: run without the flag, or move a real
// HubSpot deal for a test click.

const syncDealFromApplication = vi.fn();
const sendMagicLinkEmail = vi.fn();
const getApplication = vi.fn();
const updates: Array<Record<string, unknown>> = [];

const db = {
  update: () => ({
    set: (patch: Record<string, unknown>) => ({
      where: () => ({
        returning: async () => {
          updates.push(patch);
          return [{ id: "app-1" }];
        },
      }),
    }),
  }),
  insert: () => ({ values: async () => undefined }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/adapters/hubspot", () => ({ syncDealFromApplication }));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplication } }));
vi.mock("@/lib/auth/getEffectiveRole", () => ({
  getEffectiveRole: async () => ({ userId: "rep-1", role: "rep" }),
}));

const { bypassBillingAction } = await import("@/lib/actions/debugBilling");

const app = (extra: Record<string, unknown> = {}) => ({
  id: "app-1",
  stage: "quote_sent",
  quoteAcceptedAt: null,
  hubspotDealId: "deal-1",
  hubspotIds: null,
  ownerContact: { email: "owner@example.com" },
  quoteLines: [{ productId: "p-1" }],
  ...extra,
});

beforeEach(() => {
  process.env.ENABLE_DEBUG_BILLING_BYPASS = "true";
  syncDealFromApplication.mockReset();
  sendMagicLinkEmail.mockReset();
  getApplication.mockReset();
  updates.length = 0;
});

afterEach(() => {
  delete process.env.ENABLE_DEBUG_BILLING_BYPASS;
});

describe("bypassBillingAction", () => {
  it("does nothing unless the flag is exactly 'true'", async () => {
    process.env.ENABLE_DEBUG_BILLING_BYPASS = "1";
    getApplication.mockResolvedValue(app());
    const res = await bypassBillingAction("app-1");
    expect(res.ok).toBe(false);
    expect(getApplication).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("records the acceptance and sends the account link, without touching the HubSpot deal", async () => {
    getApplication.mockResolvedValue(app());
    const res = await bypassBillingAction("app-1");
    expect(res.ok).toBe(true);
    expect(updates[0]).toMatchObject({ stage: "quote_accepted" });
    expect(updates[0].quoteAcceptedAt).toBeInstanceOf(Date);
    expect(sendMagicLinkEmail).toHaveBeenCalledTimes(1);
    expect(syncDealFromApplication).not.toHaveBeenCalled();
  });

  it("refuses an already-accepted quote", async () => {
    getApplication.mockResolvedValue(app({ quoteAcceptedAt: "2026-10-01T00:00:00.000Z" }));
    expect((await bypassBillingAction("app-1")).ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("refuses a rate-only quote — it has its own accept button", async () => {
    getApplication.mockResolvedValue(app({ quoteLines: [] }));
    expect((await bypassBillingAction("app-1")).ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("refuses a row the caller can't see", async () => {
    getApplication.mockResolvedValue(null);
    expect((await bypassBillingAction("app-1")).ok).toBe(false);
  });
});
