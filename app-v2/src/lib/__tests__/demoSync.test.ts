import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CustomerApplicationPatch } from "@/lib/storage/storageInterface";
import type { DemoState, MerchantApplication } from "@/types/merchant";

// refreshDemoStatus and its wiring into getMyApplicationWithSyncAction. Same
// mock set/model as billingSync.test.ts — the module graph is shared, and
// updateApplicationAsCustomer is modeled the same faithful way (SETs only the
// columns in its patch, RETURNINGs the whole row as it then stands).
//
// deriveDemoState itself is NOT mocked — it's pure and its rules are already
// exhaustively covered by demo.test.ts — so this suite exercises the real
// derivation end to end and only mocks the HubSpot network calls around it.

const auth = vi.fn();
const getApplicationForCustomer = vi.fn();
const updateApplicationAsCustomer = vi.fn();
const getDealById = vi.fn();
const listMeetingsForDeal = vi.fn();
const listDemoMeetingsForCompany = vi.fn();
const getQuoteSnapshot = vi.fn();
const findSubscriptionsForQuote = vi.fn();
const getCheckOnboardStatus = vi.fn();

vi.mock("@/lib/auth", () => ({ auth, signIn: vi.fn() }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getApplicationForCustomer, updateApplicationAsCustomer },
}));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/adapters/check", () => ({
  checkEnvironment: vi.fn(), createCheckCompany: vi.fn(),
  createCheckOnboardLink: vi.fn(), getCheckOnboardStatus,
}));
vi.mock("@/lib/adapters/hubspot", () => ({
  pushToHubSpot: vi.fn(), getQuoteSnapshot, findSubscriptionsForQuote,
  getDealById, listMeetingsForDeal, listDemoMeetingsForCompany,
}));

const { getMyApplicationWithSyncAction } = await import("@/lib/actions/customer");

const ID = "app-1";
const CUSTOMER_SESSION = { user: { id: "cust-1", role: "customer" } };

const EMPTY_DEMO: DemoState = {
  bookedAt: null, heldAt: null, source: null,
  meetingId: null, meetingTitle: null, outcome: null,
  markedByUserId: null, checkedAt: null,
  lastSyncError: null, lastSyncErrorAt: null,
};

const meeting = (overrides: Partial<{
  id: string; title: string | null; startTime: string | null; endTime: string | null;
  activityType: string | null; outcome: string | null;
}> = {}) => ({
  id: "m-1", title: "Demo with Bob", startTime: "2026-08-15T18:00:00.000Z", endTime: null,
  activityType: "Demo", outcome: "COMPLETED",
  ...overrides,
});

let stored: MerchantApplication;
const patches: CustomerApplicationPatch[] = [];

function setStored(overrides: Partial<MerchantApplication>) {
  stored = { id: ID, hubspotDealId: "deal-1", tenantLink: null, demo: null, hubspotIds: null, checkIds: null, ...overrides } as MerchantApplication;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const m of [
    auth, getApplicationForCustomer, updateApplicationAsCustomer,
    getDealById, listMeetingsForDeal, listDemoMeetingsForCompany,
    getQuoteSnapshot, findSubscriptionsForQuote, getCheckOnboardStatus,
  ]) m.mockReset();
  patches.length = 0;
  auth.mockResolvedValue(CUSTOMER_SESSION);
  getApplicationForCustomer.mockImplementation(async () => stored);
  updateApplicationAsCustomer.mockImplementation(
    async (_userId: string, _id: string, patch: CustomerApplicationPatch) => {
      patches.push(patch);
      stored = { ...stored, ...patch };
      return stored;
    }
  );
  getDealById.mockResolvedValue({ id: "deal-1", createdAt: "2026-08-01T00:00:00.000Z" });
  listMeetingsForDeal.mockResolvedValue([]);
  listDemoMeetingsForCompany.mockResolvedValue([]);
  getQuoteSnapshot.mockResolvedValue(null);
  findSubscriptionsForQuote.mockResolvedValue([]);
  setStored({});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

describe("the demo refresh's no-op conditions", () => {
  it("does nothing when there is no HubSpot deal yet", async () => {
    setStored({ hubspotDealId: null });
    await getMyApplicationWithSyncAction(ID);
    expect(getDealById).not.toHaveBeenCalled();
    expect(listMeetingsForDeal).not.toHaveBeenCalled();
  });

  it("is terminal once heldAt is set — never reads HubSpot again", async () => {
    setStored({
      demo: { ...EMPTY_DEMO, heldAt: "2026-08-01T00:00:00.000Z", source: "manual", markedByUserId: "rep-1" },
    });
    const app = await getMyApplicationWithSyncAction(ID);
    expect(getDealById).not.toHaveBeenCalled();
    expect(listMeetingsForDeal).not.toHaveBeenCalled();
    // A manual mark surviving a later poll: nothing about it moved.
    expect(app?.demo?.heldAt).toBe("2026-08-01T00:00:00.000Z");
    expect(app?.demo?.source).toBe("manual");
    expect(app?.demo?.markedByUserId).toBe("rep-1");
  });
});

describe("the demo refresh's 5-minute TTL", () => {
  it("skips a re-read within the TTL", async () => {
    setStored({ demo: { ...EMPTY_DEMO, checkedAt: new Date(Date.now() - 60_000).toISOString() } });
    await getMyApplicationWithSyncAction(ID);
    expect(getDealById).not.toHaveBeenCalled();
  });

  it("re-reads once the 5-minute TTL has elapsed", async () => {
    setStored({ demo: { ...EMPTY_DEMO, checkedAt: new Date(Date.now() - 301_000).toISOString() } });
    await getMyApplicationWithSyncAction(ID);
    expect(getDealById).toHaveBeenCalledWith("deal-1");
  });

  it("re-reads rather than skipping forever on an unparseable checkedAt", async () => {
    setStored({ demo: { ...EMPTY_DEMO, checkedAt: "not a date" } });
    await getMyApplicationWithSyncAction(ID);
    expect(getDealById).toHaveBeenCalled();
  });

  it("re-reads immediately on a row that has never been synced (demo: null)", async () => {
    setStored({ demo: null });
    await getMyApplicationWithSyncAction(ID);
    expect(getDealById).toHaveBeenCalled();
  });
});

describe("what the demo refresh writes", () => {
  it("writes even when nothing changed, because checkedAt IS the TTL", async () => {
    await getMyApplicationWithSyncAction(ID);
    expect(patches.some(p => "demo" in p)).toBe(true);
  });

  it("picks up a newly-held demo from a deal meeting", async () => {
    listMeetingsForDeal.mockResolvedValue([meeting()]);
    const app = await getMyApplicationWithSyncAction(ID);
    expect(app?.demo?.heldAt).toBe("2026-08-15T18:00:00.000Z");
    expect(app?.demo?.source).toBe("hubspot_meeting");
  });

  it("clears a previous sync error on success", async () => {
    setStored({ demo: { ...EMPTY_DEMO, lastSyncError: "HubSpot 500", lastSyncErrorAt: "2026-08-01T00:00:00.000Z" } });
    const app = await getMyApplicationWithSyncAction(ID);
    expect(app?.demo?.lastSyncError).toBeNull();
    expect(app?.demo?.lastSyncErrorAt).toBeNull();
  });

  it("persists a HubSpot failure instead of throwing, leaving the row otherwise intact", async () => {
    getDealById.mockRejectedValue(new Error("HubSpot deal deal-1 fetch failed (500)"));
    const app = await getMyApplicationWithSyncAction(ID);
    expect(app).not.toBeNull();
    expect(app?.demo?.lastSyncError).toContain("500");
    expect(app?.demo?.lastSyncErrorAt).toBeTruthy();
    // Not a successful sync, so the TTL must not be armed by a failure.
    expect(app?.demo?.checkedAt).toBeNull();
  });

  it("returns the application even when the error write also fails", async () => {
    getDealById.mockRejectedValue(new Error("boom"));
    updateApplicationAsCustomer.mockRejectedValueOnce(new Error("db down"));
    const app = await getMyApplicationWithSyncAction(ID);
    expect(app?.id).toBe(ID);
  });
});

describe("demo runs before billing in the combined refresh", () => {
  it("loads the row once and threads it through check, demo, and billing in order", async () => {
    setStored({
      hubspotIds: {
        quoteId: "q-1", quoteTemplateId: "tpl-1", lineItemIds: [], contactId: "c-1",
        quoteLink: null, publishedAt: "2026-08-01T00:00:00.000Z", paymentStatus: "PENDING",
        paymentDate: null, subscriptions: null, subscriptionStatus: null, syncedAt: null,
        lastSyncError: null, lastSyncErrorAt: null,
      },
    });
    getQuoteSnapshot.mockResolvedValue({ quoteId: "q-1", status: "ACCEPTED", quoteLink: null, paymentStatus: "PENDING", paymentDate: null });

    await getMyApplicationWithSyncAction(ID);

    expect(getApplicationForCustomer).toHaveBeenCalledTimes(1);
    const patchKeys = patches.map(p => Object.keys(p)[0]);
    expect(patchKeys.indexOf("demo")).toBeLessThan(patchKeys.indexOf("hubspotIds"));
  });

  it("still refreshes billing even when the demo refresh fails", async () => {
    getDealById.mockRejectedValue(new Error("HubSpot down"));
    setStored({
      hubspotIds: {
        quoteId: "q-1", quoteTemplateId: "tpl-1", lineItemIds: [], contactId: "c-1",
        quoteLink: null, publishedAt: "2026-08-01T00:00:00.000Z", paymentStatus: "PENDING",
        paymentDate: null, subscriptions: null, subscriptionStatus: null, syncedAt: null,
        lastSyncError: null, lastSyncErrorAt: null,
      },
    });
    getQuoteSnapshot.mockResolvedValue({ quoteId: "q-1", status: "ACCEPTED", quoteLink: null, paymentStatus: "PAID", paymentDate: "2026-08-20T00:00:00Z" });

    const app = await getMyApplicationWithSyncAction(ID);
    expect(app?.hubspotIds?.paymentStatus).toBe("PAID");
    expect(app?.demo?.lastSyncError).toContain("HubSpot down");
  });

  it("returns null for an id that isn't the customer's, without touching HubSpot", async () => {
    getApplicationForCustomer.mockResolvedValue(null);
    expect(await getMyApplicationWithSyncAction(ID)).toBeNull();
    expect(getDealById).not.toHaveBeenCalled();
  });
});
