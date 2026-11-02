import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

// kickAioProvisioning: start provisioning from a signed-in page view instead of
// waiting for the cron. What matters is that it only fires when the cron
// would, and never makes a page view wait on AIO.

const afterCallbacks: Array<() => unknown> = [];
const provisionAioTenant = vi.fn();
let enabled = true;
let ready = true;

vi.mock("next/server", () => ({ after: (cb: () => unknown) => { afterCallbacks.push(cb); } }));
vi.mock("@/lib/aio/provision", () => ({ provisionAioTenant }));
vi.mock("@/lib/adapters/aioDashboard", () => ({ aioDashboardEnabled: () => enabled }));
vi.mock("@/lib/aio/provisioningGate", () => ({
  isReadyForAioProvisioning: () => (ready ? { ready: true } : { ready: false, reason: "billing_not_paid" }),
}));

const { kickAioProvisioning, aioAllowlisted } = await import("@/lib/aio/kick");

const app = (aioTenant: Partial<NonNullable<MerchantApplication["aioTenant"]>> | null = null) =>
  ({ id: "prospect_1", aioTenant }) as unknown as MerchantApplication;

beforeEach(() => {
  afterCallbacks.length = 0;
  provisionAioTenant.mockReset().mockResolvedValue({ status: "provisioned", businessId: 1, locationId: 2 });
  enabled = true;
  ready = true;
  delete process.env.AIO_DASHBOARD_APP_ALLOWLIST;
});

describe("kickAioProvisioning", () => {
  it("provisions after the response, not during it", async () => {
    kickAioProvisioning(app());
    expect(provisionAioTenant).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(provisionAioTenant).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the gate isn't ready", () => {
    ready = false;
    kickAioProvisioning(app());
    expect(afterCallbacks).toHaveLength(0);
  });

  it("does nothing when AIO provisioning is switched off", () => {
    enabled = false;
    kickAioProvisioning(app());
    expect(afterCallbacks).toHaveLength(0);
  });

  it("respects the canary allowlist exactly as the cron does", () => {
    process.env.AIO_DASHBOARD_APP_ALLOWLIST = "prospect_other";
    kickAioProvisioning(app());
    expect(afterCallbacks).toHaveLength(0);
    expect(aioAllowlisted("prospect_other")).toBe(true);
  });

  it("skips inside the schema warm-up, where there is nothing to do yet", () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    kickAioProvisioning(app({ businessId: 5217, locationId: null, locationNotBefore: soon }));
    expect(afterCallbacks).toHaveLength(0);
  });

  it("creates the location once the warm-up has passed", () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    kickAioProvisioning(app({ businessId: 5217, locationId: null, locationNotBefore: past }));
    expect(afterCallbacks).toHaveLength(1);
  });
});
