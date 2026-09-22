import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication, DemoState } from "@/types/merchant";

// markDemoHeldAction / clearDemoHeldAction — the rep/admin override for a demo
// AIO can't see in HubSpot. Mocks at the module boundary, same style as
// tenantLinkRepair.test.ts for the sibling actions in this file.

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const saveApplication = vi.fn();
const advanceDealStage = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getApplication, saveApplication, getSettings: vi.fn(), saveSettings: vi.fn() },
}));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/adapters/adyen", () => ({ applyTenantNumber: vi.fn() }));
vi.mock("@/lib/db/schema", () => ({ customerLoginTokens: {}, users: {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  advanceDealStage,
}));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote: vi.fn() }));

const { markDemoHeldAction, clearDemoHeldAction } = await import("@/lib/actions/applications");

const app = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: "rep-1",
    hubspotDealId: "deal-1",
    demo: null,
    ...over,
  }) as unknown as MerchantApplication;

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getApplication.mockResolvedValue(app());
  saveApplication.mockImplementation(async (_scope: unknown, a: MerchantApplication) => a);
  advanceDealStage.mockResolvedValue("advanced");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("markDemoHeldAction", () => {
  it("writes heldAt (defaulting to now), source: manual, and the marking user", async () => {
    const before = Date.now();
    const updated = await markDemoHeldAction("app-1");
    const demo = updated.demo as DemoState;

    expect(demo.source).toBe("manual");
    expect(demo.markedByUserId).toBe("rep-1");
    expect(Date.parse(demo.heldAt!)).toBeGreaterThanOrEqual(before);
    expect(demo.lastSyncError).toBeNull();
    expect(saveApplication).toHaveBeenCalledWith(
      { userId: "rep-1", role: "rep" },
      expect.objectContaining({ demo: expect.objectContaining({ source: "manual" }) }),
    );
  });

  it("accepts an explicit heldAt instead of defaulting to now", async () => {
    const updated = await markDemoHeldAction("app-1", "2026-08-01T00:00:00.000Z");
    expect((updated.demo as DemoState).heldAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("preserves bookedAt/meetingId/meetingTitle/outcome already on the row", async () => {
    getApplication.mockResolvedValue(app({
      demo: {
        bookedAt: "2026-09-25T00:00:00.000Z", heldAt: null, source: "hubspot_meeting",
        meetingId: "m-1", meetingTitle: "Demo with Bob", outcome: null,
        markedByUserId: null, checkedAt: "2026-09-01T00:00:00.000Z",
        lastSyncError: null, lastSyncErrorAt: null,
      },
    }));
    const updated = await markDemoHeldAction("app-1");
    const demo = updated.demo as DemoState;
    expect(demo.meetingId).toBe("m-1");
    expect(demo.meetingTitle).toBe("Demo with Bob");
  });

  it("advances the deal to the Demo Meeting stage, best-effort", async () => {
    await markDemoHeldAction("app-1");
    expect(advanceDealStage).toHaveBeenCalledWith("deal-1", "stage_0");
  });

  it("does not fail the mark when advanceDealStage throws — the demo state is already saved", async () => {
    advanceDealStage.mockRejectedValue(new Error("HubSpot 500"));
    const updated = await markDemoHeldAction("app-1");
    expect((updated.demo as DemoState).heldAt).toBeTruthy();
    expect(saveApplication).toHaveBeenCalledTimes(1);
  });

  it("skips advanceDealStage entirely when there's no HubSpot deal yet", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: null }));
    await markDemoHeldAction("app-1");
    expect(advanceDealStage).not.toHaveBeenCalled();
  });

  it("is not admin-only — a rep may mark their own deal's demo held", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
    await expect(markDemoHeldAction("app-1")).resolves.toBeTruthy();
  });

  it("throws when the scoped read returns nothing", async () => {
    getApplication.mockResolvedValue(null);
    await expect(markDemoHeldAction("app-1")).rejects.toThrow("Application not found");
  });
});

describe("clearDemoHeldAction", () => {
  const HELD: DemoState = {
    bookedAt: null, heldAt: "2026-08-01T00:00:00.000Z", source: "manual",
    meetingId: null, meetingTitle: null, outcome: null,
    markedByUserId: "rep-1", checkedAt: "2026-08-01T00:00:00.000Z",
    lastSyncError: null, lastSyncErrorAt: null,
  };

  it("nulls heldAt, source, and markedByUserId so the poller resumes", async () => {
    getApplication.mockResolvedValue(app({ demo: HELD }));
    const updated = await clearDemoHeldAction("app-1");
    const demo = updated.demo as DemoState;
    expect(demo.heldAt).toBeNull();
    expect(demo.source).toBeNull();
    expect(demo.markedByUserId).toBeNull();
  });

  it("leaves the rest of the demo snapshot (checkedAt, bookedAt) alone", async () => {
    getApplication.mockResolvedValue(app({
      demo: { ...HELD, bookedAt: "2026-09-25T00:00:00.000Z", checkedAt: "2026-08-05T00:00:00.000Z" },
    }));
    const updated = await clearDemoHeldAction("app-1");
    const demo = updated.demo as DemoState;
    expect(demo.bookedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(demo.checkedAt).toBe("2026-08-05T00:00:00.000Z");
  });

  it("is not admin-only — a rep who mis-clicked mark-held can undo it themselves", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
    getApplication.mockResolvedValue(app({ demo: HELD }));
    await expect(clearDemoHeldAction("app-1")).resolves.toBeTruthy();
  });

  it("does not call advanceDealStage", async () => {
    getApplication.mockResolvedValue(app({ demo: HELD }));
    await clearDemoHeldAction("app-1");
    expect(advanceDealStage).not.toHaveBeenCalled();
  });

  it("throws when the scoped read returns nothing", async () => {
    getApplication.mockResolvedValue(null);
    await expect(clearDemoHeldAction("app-1")).rejects.toThrow("Application not found");
  });
});
