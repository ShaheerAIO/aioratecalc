import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";
import type { HubspotDeal } from "@/lib/adapters/hubspot";

// adoptDealAction — the other half of the dead end retryBillingQuoteAction's
// `ambiguous` refusal points reps at: attaching an EXISTING HubSpot deal to a
// row that has none at all (hubspotDealId: null), most commonly a legacy
// account from before deal adoption existed. resolveDealForCompany itself
// (its own refusal codes, the already_adopted/ambiguous invariant) is covered
// by resolveDealForCompany.test.ts — mocked here at the module boundary, the
// same way tenantLinkRepair.test.ts mocks its neighbors. What's under test
// here is only what this action adds around it: the already-has-a-deal
// refusal, the missing-company refusal, surfacing resolveDealForCompany's
// refusal readably, persisting hubspotDealId/dealLink on success, and the
// deferred billing catch-up.

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const saveApplication = vi.fn();
const resolveDealForCompany = vi.fn();
const buildAndPublishBillingQuote = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplication, saveApplication } }));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/db/schema", () => ({ customerLoginTokens: {}, users: {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany }));
// Partial mock: keep the real pure helpers (buildDealProperties, etc.) —
// adoptDealAction itself never calls into the network side of this module.
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
}));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote }));

const { adoptDealAction } = await import("@/lib/actions/applications");

const TENANT_LINK = {
  hubspotCompanyId: "company-1",
  companyName: "Torta Palace",
  tenantRef: "prod-1024",
  adyenAccountHolderId: null,
  linkedAt: "2026-08-21T00:00:00.000Z",
  linkedByUserId: "rep-1",
};

const DEAL: HubspotDeal = {
  id: "deal-9", name: "Torta Palace / Deal", pipelineId: "default", stageId: "2717103849",
  stageLabel: "Discovery Meeting", amount: 12000, createdAt: "2026-09-01T00:00:00.000Z",
  closed: false, won: false, companyIds: ["company-1"],
};

const app = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: "rep-1",
    hubspotDealId: null,
    tenantLink: TENANT_LINK,
    quoteAcceptedAt: null,
    ...over,
  }) as unknown as MerchantApplication;

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  saveApplication.mockImplementation(async (_scope: unknown, a: MerchantApplication) => a);
});

describe("adoptDealAction", () => {
  it("refuses when the account already has a HubSpot deal", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-existing" }));

    const result = await adoptDealAction("app-1", "deal-9");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatch(/already attached to HubSpot deal deal-existing/);
    expect(resolveDealForCompany).not.toHaveBeenCalled();
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("refuses when the account has no HubSpot company linked", async () => {
    getApplication.mockResolvedValue(app({ tenantLink: null }));

    const result = await adoptDealAction("app-1", "deal-9");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toMatch(/isn't linked to a HubSpot company/);
    expect(resolveDealForCompany).not.toHaveBeenCalled();
  });

  it("surfaces a resolveDealForCompany refusal readably", async () => {
    getApplication.mockResolvedValue(app());
    resolveDealForCompany.mockResolvedValue({
      ok: false, code: "wrong_company",
      message: "Deal 'X' isn't associated with this company in HubSpot.",
    });

    const result = await adoptDealAction("app-1", "deal-9");

    expect(result).toEqual({ ok: false, error: "Deal 'X' isn't associated with this company in HubSpot." });
  });

  it("resolves via resolveDealForCompany with mode: existing, excluding this application", async () => {
    getApplication.mockResolvedValue(app());
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: false });

    await adoptDealAction("app-1", "deal-9");

    expect(resolveDealForCompany).toHaveBeenCalledWith({
      companyId: "company-1",
      choice: { mode: "existing", dealId: "deal-9" },
      excludeApplicationId: "app-1",
    });
  });

  it("stamps hubspotDealId and a dealLink with origin 'adopted' on success", async () => {
    getApplication.mockResolvedValue(app());
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: false });

    const result = await adoptDealAction("app-1", "deal-9");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.app.hubspotDealId).toBe("deal-9");
    expect(result.app.dealLink).toEqual({
      origin: "adopted",
      dealName: "Torta Palace / Deal",
      pipelineStageAtLink: "2717103849",
      linkedAt: expect.any(String),
      linkedByUserId: "rep-1",
    });
    expect(saveApplication).toHaveBeenCalledTimes(1);
  });

  it("does not run the billing catch-up for a row that hasn't been accepted", async () => {
    getApplication.mockResolvedValue(app({ quoteAcceptedAt: null }));
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: false });

    const result = await adoptDealAction("app-1", "deal-9");

    expect(buildAndPublishBillingQuote).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quotePublished).toBe(false);
  });

  it("runs and reports the billing catch-up for an already-accepted row", async () => {
    getApplication
      .mockResolvedValueOnce(app({ quoteAcceptedAt: "2026-09-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(app({ quoteAcceptedAt: "2026-09-01T00:00:00.000Z", hubspotDealId: "deal-9" }));
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: false });
    buildAndPublishBillingQuote.mockResolvedValue({ status: "published", quoteLink: "https://customers.aioapp.com/abc" });

    const result = await adoptDealAction("app-1", "deal-9");

    expect(buildAndPublishBillingQuote).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.quotePublished).toBe(true);
  });

  it("surfaces refused billing preconditions without failing the adoption itself", async () => {
    getApplication.mockResolvedValue(app({ quoteAcceptedAt: "2026-09-01T00:00:00.000Z" }));
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: false });
    buildAndPublishBillingQuote.mockResolvedValue({
      status: "refused", reasons: [{ code: "no_deal", message: "nope" }],
    });

    const result = await adoptDealAction("app-1", "deal-9");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quotePublished).toBe(false);
      expect(result.billingReasons).toEqual([{ code: "no_deal", message: "nope" }]);
    }
  });
});
