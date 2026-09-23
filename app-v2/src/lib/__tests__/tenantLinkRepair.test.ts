import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MerchantApplication } from "@/types/merchant";

// linkTenantCompanyAction's deal-company REPAIR branch: a pre-existing deal
// (adopted via the deal picker, or a legacy orphan) may be missing its
// company association, or — much more rarely — carry a different one.
// `associateDealToCompany`'s v4 PUT is verified live (2026-09-21, see its
// comment in adapters/hubspot.ts) to attach one to an EXISTING deal, so this
// is now repaired here. Everything else the action does (the deal CREATE
// path, billing catch-up) is untouched by this suite — it mocks the network
// calls at the module boundary, the same way billingRetry.test.ts does for
// the sibling action.
//
// The CREATE path itself goes through `createDeal` — `syncDealFromApplication`
// (formerly `pushToHubSpot`) has no CREATE branch any more, so this legacy
// row (from before deal adoption existed) is the one remaining caller.

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const saveApplication = vi.fn();
const getTenantCompany = vi.fn();
const createDeal = vi.fn();
const getDealById = vi.fn();
const associateDealToCompany = vi.fn();
const buildAndPublishBillingQuote = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { getApplication, saveApplication } }));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/db/schema", () => ({ customerLoginTokens: {}, users: {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
// Partial mock: keep the real pure helpers (buildDealAssociations, etc.),
// stub only the network calls this suite exercises.
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  getTenantCompany,
  createDeal,
  getDealById,
  associateDealToCompany,
}));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote }));

const { linkTenantCompanyAction } = await import("@/lib/actions/applications");

const COMPANY = {
  id: "company-1",
  name: "Torta Palace",
  tenantRef: "prod-1024",
  adyenAccountHolderId: null,
  mid: null,
  phone: null,
  email: null,
};

const app = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: "rep-1",
    hubspotDealId: "deal-existing",
    hubspotIds: null,
    tenantLink: null,
    quoteAcceptedAt: null,
    ...over,
  }) as unknown as MerchantApplication;

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getTenantCompany.mockResolvedValue(COMPANY);
  saveApplication.mockImplementation(async (_scope: unknown, a: MerchantApplication) => a);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("linkTenantCompanyAction — deal-company repair", () => {
  it("attaches the company to a pre-existing deal that has none", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-orphan" }));
    getDealById.mockResolvedValue({ id: "deal-orphan", companyIds: [] });

    const result = await linkTenantCompanyAction("app-1", "company-1");

    expect(associateDealToCompany).toHaveBeenCalledWith("deal-orphan", "company-1");
    expect(result.dealCompanyRepaired).toBe(true);
    expect(result.dealCompanyMismatch).toBeUndefined();
    expect(result.dealCreated).toBe(false);
  });

  it("never touches a deal that's already on a DIFFERENT company — reports it instead", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-other" }));
    getDealById.mockResolvedValue({ id: "deal-other", companyIds: ["some-other-company"] });

    const result = await linkTenantCompanyAction("app-1", "company-1");

    expect(associateDealToCompany).not.toHaveBeenCalled();
    expect(result.dealCompanyRepaired).toBeFalsy();
    expect(result.dealCompanyMismatch).toEqual({ dealId: "deal-other", otherCompanyIds: ["some-other-company"] });
  });

  it("does nothing when the deal already carries the right company", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-ok" }));
    getDealById.mockResolvedValue({ id: "deal-ok", companyIds: ["company-1"] });

    const result = await linkTenantCompanyAction("app-1", "company-1");

    expect(associateDealToCompany).not.toHaveBeenCalled();
    expect(result.dealCompanyRepaired).toBeFalsy();
    expect(result.dealCompanyMismatch).toBeUndefined();
  });

  it("leaves the link intact when the repair itself fails", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-orphan" }));
    getDealById.mockResolvedValue({ id: "deal-orphan", companyIds: [] });
    associateDealToCompany.mockRejectedValue(new Error("HubSpot 500"));

    const result = await linkTenantCompanyAction("app-1", "company-1");

    expect(result.app.tenantLink?.hubspotCompanyId).toBe("company-1"); // link saved regardless
    expect(saveApplication).toHaveBeenCalledTimes(1); // only the link save — never rolled back
    expect(result.dealCompanyRepaired).toBeFalsy();
    expect(result.error).toBeUndefined(); // a repair failure is logged, not surfaced as the link's error
    expect(errorSpy).toHaveBeenCalled();
  });

  it("skips the repair entirely for a deal this same call just created", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: null }));
    createDeal.mockResolvedValue("deal-brand-new");

    const result = await linkTenantCompanyAction("app-1", "company-1");

    expect(result.dealCreated).toBe(true);
    expect(createDeal).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-1" }));
    expect(getDealById).not.toHaveBeenCalled();
    expect(associateDealToCompany).not.toHaveBeenCalled();
  });

  it("stamps dealLink with origin 'created' when this legacy path creates the deal", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: null }));
    createDeal.mockResolvedValue("deal-brand-new");

    const result = await linkTenantCompanyAction("app-1", "company-1");

    expect(result.app.dealLink).toEqual({
      origin: "created",
      dealName: "New Deal", // no business.dba/legalName/analysis on this fixture
      pipelineStageAtLink: null, // app.stage is unset on this fixture — unmapped
      linkedAt: expect.any(String),
      linkedByUserId: "rep-1",
    });
  });

  it("still works: linkTenantCompanyAction's legacy create path (the only remaining caller of createDeal here)", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: null }));
    createDeal.mockResolvedValue("deal-brand-new");

    const result = await linkTenantCompanyAction("app-1", "company-1");

    expect(result.app.hubspotDealId).toBe("deal-brand-new");
    expect(result.error).toBeUndefined();
  });
});
