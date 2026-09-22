import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";
import type { HubspotDeal } from "@/lib/adapters/hubspot";

// retryBillingQuoteAction — the rep's only billing affordance. The orchestrator
// itself is covered by leadAcceptBilling.test.ts against the real thing; what's
// under test here is only what the action adds around it: the role/ownership
// hand-off, the already-published refusal, and the missing-deal backfill —
// which now goes through resolveDealForCompany (mode: "create") rather than
// creating blind, so a company that already has deals refuses `ambiguous`
// instead of minting a duplicate.

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const resolveDealForCompany = vi.fn();
const buildAndPublishBillingQuote = vi.fn();

const patches: Array<Record<string, unknown>> = [];

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplication } }));
// The Company & Deal resolution service — mocked so the real module (which
// pulls in the server-only db client) is never loaded here. Same pattern as
// createProspect.test.ts.
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany }));
// Partial mock: the pure property builder stays real, nothing here makes a
// network call.
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
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

const NEW_DEAL: HubspotDeal = {
  id: "deal-new", name: "Torta Palace", pipelineId: "default", stageId: null,
  stageLabel: null, amount: 12000, createdAt: "2026-09-21T00:00:00.000Z",
  closed: false, won: false, companyIds: ["334295287484"],
};

const app = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: "rep-1",
    hubspotDealId: null,
    hubspotIds: null,
    tenantLink: TENANT_LINK,
    business: { legalName: "Torta Palace LLC", dba: "Torta Palace" },
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
    expect(resolveDealForCompany).not.toHaveBeenCalled();
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("creates the missing deal via resolveDealForCompany, persists it, and publishes against it", async () => {
    getApplication.mockResolvedValue(app());
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: NEW_DEAL, created: true });

    const result = await retryBillingQuoteAction("app-1");

    expect(resolveDealForCompany).toHaveBeenCalledWith({
      companyId: "334295287484",
      choice: { mode: "create", dealName: "Torta Palace", amount: 0 },
      excludeApplicationId: "app-1",
    });
    expect(result).toEqual({ ok: true, quoteLink: "https://customers.aioapp.com/abc" });
    expect(patches).toEqual([expect.objectContaining({ hubspotDealId: "deal-new" })]);
    // The id has to reach the orchestrator on the in-memory row too, or the
    // publish refuses `no_deal` on the copy it was handed.
    expect(buildAndPublishBillingQuote).toHaveBeenCalledWith(expect.objectContaining({ hubspotDealId: "deal-new" }));
  });

  it("stamps dealLink with origin 'created' when the deal was just minted", async () => {
    getApplication.mockResolvedValue(app());
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: NEW_DEAL, created: true });

    await retryBillingQuoteAction("app-1");

    expect(patches[0].dealLink).toEqual(expect.objectContaining({ origin: "created", dealName: NEW_DEAL.name }));
  });

  it("refuses to create the deal while no HubSpot company is linked", async () => {
    getApplication.mockResolvedValue(app({ tenantLink: null }));

    const result = await retryBillingQuoteAction("app-1");

    expect(result.ok).toBe(false);
    expect(result.reasons?.map(r => r.code)).toEqual(["no_tenant_company"]);
    expect(resolveDealForCompany).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("refuses ambiguous — forcing a human to pick — rather than minting a duplicate deal", async () => {
    getApplication.mockResolvedValue(app());
    resolveDealForCompany.mockResolvedValue({
      ok: false,
      code: "ambiguous",
      message: "This company already has 2 deals in HubSpot. Pick one instead of creating a new one.",
      candidates: [NEW_DEAL, { ...NEW_DEAL, id: "deal-other" }],
    });

    const result = await retryBillingQuoteAction("app-1");

    expect(result.ok).toBe(false);
    expect(result.reasons?.map(r => r.code)).toEqual(["deal_ambiguous"]);
    expect(patches).toEqual([]);
    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
  });

  it("never re-resolves a deal that already exists", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "d-1" }));

    await retryBillingQuoteAction("app-1");

    expect(resolveDealForCompany).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
    expect(buildAndPublishBillingQuote).toHaveBeenCalledWith(expect.objectContaining({ hubspotDealId: "d-1" }));
  });

  it("stops at a failed deal resolution rather than letting the publish refuse no_deal", async () => {
    getApplication.mockResolvedValue(app());
    resolveDealForCompany.mockResolvedValue({ ok: false, code: "hubspot_error", message: "403 Forbidden" });

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
