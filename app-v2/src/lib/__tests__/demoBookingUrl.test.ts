import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppSettings } from "@/types/merchant";

// updateDemoBookingUrlAction (admin-only) and saveSettingsAction's refusal to
// let a rep move demoBookingUrl through the same AppSettings shape
// /rep/settings posts for processors/adyenConfig.

const getEffectiveRole = vi.fn();
const getSettings = vi.fn();
const saveSettings = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getSettings, saveSettings, getApplication: vi.fn(), saveApplication: vi.fn() },
}));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/db/schema", () => ({ customerLoginTokens: {}, users: {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
}));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote: vi.fn() }));

const { updateDemoBookingUrlAction, saveSettingsAction } = await import("@/lib/actions/applications");

const SETTINGS: AppSettings = { processors: [], demoBookingUrl: "https://meetings.hubspot.com/aio/demo" };

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(SETTINGS);
  saveSettings.mockResolvedValue(undefined);
});

describe("updateDemoBookingUrlAction", () => {
  it("admin can set a valid https URL", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });
    const result = await updateDemoBookingUrlAction("https://meetings.hubspot.com/aio/new-demo");
    expect(result.demoBookingUrl).toBe("https://meetings.hubspot.com/aio/new-demo");
    expect(saveSettings).toHaveBeenCalledWith(
      { userId: "admin-1", role: "admin" },
      expect.objectContaining({ demoBookingUrl: "https://meetings.hubspot.com/aio/new-demo" }),
    );
  });

  it("admin can clear it back to null", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });
    const result = await updateDemoBookingUrlAction(null);
    expect(result.demoBookingUrl).toBeNull();
  });

  it("refuses a rep", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
    await expect(updateDemoBookingUrlAction("https://example.com")).rejects.toThrow("Admin only");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("rejects a non-absolute or non-http(s) URL", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });
    await expect(updateDemoBookingUrlAction("not-a-url")).rejects.toThrow(/http/i);
    await expect(updateDemoBookingUrlAction("ftp://example.com")).rejects.toThrow(/http/i);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});

describe("saveSettingsAction", () => {
  it("never lets demoBookingUrl move through it, even for an admin", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });
    await saveSettingsAction({ processors: [], demoBookingUrl: "https://evil.example.com" });
    expect(saveSettings).toHaveBeenCalledWith(
      { userId: "admin-1", role: "admin" },
      expect.objectContaining({ demoBookingUrl: SETTINGS.demoBookingUrl }),
    );
  });

  it("a rep's payload can't repoint the org-wide link", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
    await saveSettingsAction({ processors: [{ id: "p1", name: "Test", isDefault: true, tiers: [] }], demoBookingUrl: "https://rep-typed-this.example.com" });
    const written = saveSettings.mock.calls[0][1] as AppSettings;
    expect(written.demoBookingUrl).toBe(SETTINGS.demoBookingUrl);
    expect(written.processors).toEqual([{ id: "p1", name: "Test", isDefault: true, tiers: [] }]);
  });
});
