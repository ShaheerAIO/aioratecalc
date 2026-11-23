import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-11-11: Skip Billing (Debug) is admin-only (product owner).
const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const recordAcceptance = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplication } }));
vi.mock("@/lib/billing/acceptance", () => ({ recordAcceptance }));
vi.mock("@/lib/debug/billingBypass", () => ({ isBillingBypassEnabled: () => true }));

const { bypassBillingAction } = await import("@/lib/actions/debugBilling");

describe("bypassBillingAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a rep before touching any data", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "u1", role: "rep" });
    const res = await bypassBillingAction("app1");
    expect(res.ok).toBe(false);
    expect(getApplication).not.toHaveBeenCalled();
    expect(recordAcceptance).not.toHaveBeenCalled();
  });

  it("lets an admin through to the ownership lookup", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "a1", role: "admin" });
    getApplication.mockResolvedValue(null);
    const res = await bypassBillingAction("app1");
    expect(res.error).toBe("Application not found");
  });
});
