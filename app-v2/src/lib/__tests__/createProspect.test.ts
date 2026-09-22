import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusinessInfo, MerchantApplication, OwnerContact } from "@/types/merchant";
import type { HubspotDeal } from "@/lib/adapters/hubspot";

// createProspectAction — the "Company & Deal" + "Review What We Know" write
// path. Under test: the hard blocks (company, deal, legalName, owner email,
// malformed-but-not-merely-missing fields), that a deal refusal saves nothing,
// and that a successful resolution persists the picked deal id plus the rep's
// own reviewed business/owner/processing verbatim (no server-side re-merge —
// see the comment on this in prospects.ts).

const getEffectiveRole = vi.fn();
const saveApplication = vi.fn();
const getCompanyProfile = vi.fn();
const getCompanyOwnerContact = vi.fn();
const resolveDealForCompany = vi.fn();
const sendLeadLinkEmail = vi.fn();
const sendLeadLinkSms = vi.fn();
const listQuotableProductsAction = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { saveApplication } }));
vi.mock("@/lib/adapters/hubspot", () => ({ getCompanyProfile, getCompanyOwnerContact }));
// The Company & Deal picker's resolution service — mocked so the real module
// (which pulls in the server-only db client) is never loaded here.
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany }));
vi.mock("@/lib/adapters/email", () => ({ sendLeadLinkEmail }));
vi.mock("@/lib/adapters/sms", () => ({ sendLeadLinkSms }));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
vi.mock("@/lib/actions/pricing", () => ({
  getActivePaddingPolicy: vi.fn().mockResolvedValue({
    paddingPct: 0.5, paddingMinMrrAdd: 0, paddingAdyenCostHide: true,
  }),
}));

const { createProspectAction } = await import("@/lib/actions/prospects");

const BUSINESS: BusinessInfo = {
  legalName: "Torta Palace LLC", dba: "Torta Palace", bizType: "llc",
  address: "1200 Wilshire Blvd", city: "Los Angeles", state: "CA", zip: "90017",
  phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const OWNER: OwnerContact = { firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@tortapalace.com", phone: "" };

const DEAL: HubspotDeal = {
  id: "deal-1", name: "Torta Palace / Deal - 1", pipelineId: "default", stageId: "2717103849",
  stageLabel: "Discovery Meeting", amount: 12000, createdAt: "2026-09-01T00:00:00.000Z",
  closed: false, won: false, companyIds: ["334295287484"],
};

const COMPANY_ID = "334295287484";

type Input = Parameters<typeof createProspectAction>[0];

function baseInput(over: Partial<Input> = {}): Input {
  return {
    business: BUSINESS,
    ownerContact: OWNER,
    processing: null,
    targetMargin: 0.008,
    pricingModel: "2-tier",
    // marketing_only + no picks/channels short-circuits deriveQuoteLines
    // before it ever reaches the catalog — this suite is about the
    // company/deal/field gates, not quote derivation.
    quoteType: "marketing_only",
    picks: [],
    channels: [],
    hubspotCompanyId: COMPANY_ID,
    deal: { mode: "existing", dealId: DEAL.id },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getCompanyProfile.mockResolvedValue({ id: COMPANY_ID, name: "Torta Palace", tenantRef: null, adyenAccountHolderId: null });
  resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: false });
  sendLeadLinkEmail.mockResolvedValue({ sent: true });
  sendLeadLinkSms.mockResolvedValue({ sent: false });
});

describe("createProspectAction — hard blocks", () => {
  it("throws when the legal business name is blank, and saves nothing", async () => {
    await expect(createProspectAction(baseInput({ business: { ...BUSINESS, legalName: "" } })))
      .rejects.toThrow(/legal business name/i);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("throws when the owner contact email is blank, and saves nothing", async () => {
    await expect(createProspectAction(baseInput({ ownerContact: { ...OWNER, email: "" } })))
      .rejects.toThrow(/contact email/i);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("throws on a malformed field (present but wrong), and saves nothing", async () => {
    await expect(createProspectAction(baseInput({ business: { ...BUSINESS, state: "XX" } })))
      .rejects.toThrow(/state/i);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("does NOT block on a merely missing field like a blank street address", async () => {
    // Missing (not malformed) — warn-on-missing territory, not a hard block.
    await createProspectAction(baseInput({ business: { ...BUSINESS, address: "" } }));
    expect(saveApplication).toHaveBeenCalledTimes(1);
  });

  it("throws when the linked HubSpot company can't be read, and saves nothing", async () => {
    getCompanyProfile.mockResolvedValue(null);
    await expect(createProspectAction(baseInput())).rejects.toThrow(/wasn't found/i);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("throws the deal resolution's own refusal message, and saves nothing", async () => {
    resolveDealForCompany.mockResolvedValue({ ok: false, code: "closed", message: "Deal is closed and can't be adopted." });
    await expect(createProspectAction(baseInput())).rejects.toThrow("Deal is closed and can't be adopted.");
    expect(saveApplication).not.toHaveBeenCalled();
  });
});

describe("createProspectAction — success", () => {
  it("resolves the deal against the linked company id", async () => {
    await createProspectAction(baseInput());
    expect(resolveDealForCompany).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      choice: { mode: "existing", dealId: DEAL.id },
    });
  });

  it("persists the resolved deal id and the rep-reviewed fields verbatim — no server-side re-merge", async () => {
    await createProspectAction(baseInput());
    expect(saveApplication).toHaveBeenCalledTimes(1);
    const [, app] = saveApplication.mock.calls[0] as [unknown, MerchantApplication];
    expect(app.hubspotDealId).toBe("deal-1");
    expect(app.business).toEqual(BUSINESS);
    expect(app.ownerContact).toEqual(OWNER);
    expect(app.tenantLink?.hubspotCompanyId).toBe(COMPANY_ID);
  });

  it("stamps dealLink with origin 'adopted' when resolveDealForCompany found a pre-existing deal", async () => {
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: false });
    await createProspectAction(baseInput());
    const [, app] = saveApplication.mock.calls[0] as [unknown, MerchantApplication];
    expect(app.dealLink).toEqual({
      origin: "adopted",
      dealName: DEAL.name,
      pipelineStageAtLink: DEAL.stageId,
      linkedAt: expect.any(String),
      linkedByUserId: "rep-1",
    });
  });

  it("stamps dealLink with origin 'created' when resolveDealForCompany minted a brand-new deal", async () => {
    resolveDealForCompany.mockResolvedValue({ ok: true, deal: DEAL, created: true });
    await createProspectAction(baseInput({ deal: { mode: "create", dealName: "Torta Palace" } }));
    const [, app] = saveApplication.mock.calls[0] as [unknown, MerchantApplication];
    expect(app.dealLink?.origin).toBe("created");
  });
});
