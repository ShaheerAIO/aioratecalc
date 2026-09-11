import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

// retryBillingQuoteAction — the rep's only billing affordance. The orchestrator
// itself is covered by leadAcceptBilling.test.ts against the real thing; what's
// under test here is only what the action adds around it: the role/ownership
// hand-off, the already-published refusal, and the missing-deal backfill.

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const pushToHubSpot = vi.fn();
const buildAndPublishBillingQuote = vi.fn();

const patches: Array<Record<string, unknown>> = [];

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplication } }));
// Partial mock: the pure helpers — including the tenant-link gate — stay real,
// only the network call is stubbed.
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  pushToHubSpot,
}));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote }));
vi.mock("@/lib/db/schema", () => ({ merchantApplications: { id: "id" } }));
vi.mock("@/lib/db/client", () => ({
  db: {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        patches.push(patch);
        return { where: async () => undefined };
      },
    }),
  },
}));

const { retryBillingQuoteAction } = await import("@/lib/actions/billing");

// Linked by default — an unlinked account can't create a deal at all, which
// is its own case below.
const TENANT_LINK = {
  hubspotCompanyId: "334295287484",
  companyName: "TEST COMPANY",
  tenantRef: "prod-1024",
  adyenAccountHolderId: null,
  linkedAt: "2026-08-21T00:00:00.000Z",
  linkedByUserId: "rep-1",
};

const app = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: "rep-1",
    hubspotDealId: null,
    hubspotIds: null,
    tenantLink: TENANT_LINK,
    quoteLines: [{ name: "AIO Platform", qty: 1, unitPrice: 99, billingFrequency: "weekly", productType: "Software", hubspotProductId: "p-1" }],
    ...over,
  }) as unknown as MerchantApplication;

beforeEach(() => {
  vi.clearAllMocks();
  patches.length = 0;
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  buildAndPublishBillingQuote.mockResolvedValue({ status: "published", quoteLink: "https://customers.aioapp.com/abc" });
});

describe("retryBillingQuoteAction", () => {
  it("refuses once the quote is published, without touching HubSpot at all", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "d-1", hubspotIds: { publishedAt: "2026-08-22T00:00:00Z" } as never }));

    const result = await retryBillingQuoteAction("app-1");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already published");
    expect(pushToHubSpot).not.toHaveBeenCalled();
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("creates the missing deal, persists it, and publishes against it", async () => {
    getApplication.mockResolvedValue(app());
    pushToHubSpot.mockResolvedValue("deal-new");

    const result = await retryBillingQuoteAction("app-1");

    expect(result).toEqual({ ok: true, quoteLink: "https://customers.aioapp.com/abc" });
    expect(patches).toEqual([expect.objectContaining({ hubspotDealId: "deal-new" })]);
    // The id has to reach the orchestrator on the in-memory row too, or the
    // publish refuses `no_deal` on the copy it was handed.
    expect(buildAndPublishBillingQuote).toHaveBeenCalledWith(expect.objectContaining({ hubspotDealId: "deal-new" }));
  });

  it("refuses to create the deal while no HubSpot company is linked", async () => {
    getApplication.mockResolvedValue(app({ tenantLink: null }));

    const result = await retryBillingQuoteAction("app-1");

    expect(result.ok).toBe(false);
    expect(result.reasons?.map(r => r.code)).toEqual(["no_tenant_company"]);
    expect(pushToHubSpot).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("never re-pushes a deal that already exists", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "d-1" }));

    await retryBillingQuoteAction("app-1");

    expect(pushToHubSpot).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
    expect(buildAndPublishBillingQuote).toHaveBeenCalledWith(expect.objectContaining({ hubspotDealId: "d-1" }));
  });

  it("stops at a failed deal push rather than letting the publish refuse no_deal", async () => {
    getApplication.mockResolvedValue(app());
    pushToHubSpot.mockRejectedValue(new Error("403 Forbidden"));

    const result = await retryBillingQuoteAction("app-1");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("403 Forbidden");
    expect(patches).toEqual([]);
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("passes a refusal's reasons straight through for the rep's checklist", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "d-1" }));
    buildAndPublishBillingQuote.mockResolvedValue({
      status: "refused",
      reasons: [{ code: "order_points_need_review", message: "Tablet (×2) needs a human decision" }],
    });

    const result = await retryBillingQuoteAction("app-1");

    expect(result.ok).toBe(false);
    expect(result.reasons?.[0].code).toBe("order_points_need_review");
  });
});
