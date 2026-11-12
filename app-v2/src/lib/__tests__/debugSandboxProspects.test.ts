// DEBUG-SANDBOX: debug-only test (branch debug/team-preview), never merge.
//
// Quote sends under DEBUG_SANDBOX=true: every path that puts a link in front
// of a merchant refuses before the row is saved (the DB is production), while
// saving a draft — a pure DB edit — still works. Mock setup mirrors
// createProspect.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BusinessInfo, MerchantApplication, OwnerContact } from "@/types/merchant";

const getEffectiveRole = vi.fn();
const saveApplication = vi.fn();
const getApplication = vi.fn();
const getCompanyProfile = vi.fn();
const resolveDealForCompany = vi.fn();
const sendLeadLinkEmail = vi.fn();
const sendLeadLinkSms = vi.fn();
const moveDealToQuoteSentAtSend = vi.fn();
const getRateMatrix = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { saveApplication, getApplication } }));
vi.mock("@/lib/adapters/hubspot", () => ({
  getCompanyProfile, listCompanyContacts: vi.fn(), updateCompanyMerchantDetails: vi.fn(),
  ensureQuoteContact: vi.fn(), getContactById: vi.fn(), updateContactDetails: vi.fn(), moveDealToQuoteSentAtSend,
  createApprovalTicket: vi.fn(), closeApprovalTicket: vi.fn(), setDealBillingNotes: vi.fn(),
}));
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany }));
vi.mock("@/lib/adapters/email", () => ({ sendLeadLinkEmail }));
vi.mock("@/lib/adapters/sms", () => ({ sendLeadLinkSms }));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction: vi.fn() }));
vi.mock("@/lib/billing/publishBillingQuote", () => ({
  buildAndPublishBillingQuote: vi.fn(), resolveSender: vi.fn().mockResolvedValue({ ok: false, code: "no_rep_email" }),
}));
vi.mock("@/lib/actions/pricing", () => ({
  getActivePaddingPolicy: vi.fn().mockResolvedValue({ paddingAdyenCostHide: true }),
  getMaxDiscountPercent: vi.fn().mockResolvedValue(50),
  getQuoteLimits: vi.fn().mockResolvedValue({ unitCaps: {}, maxBillingDelayDays: 90 }),
  getPricingPreviewAction: vi.fn(async (input: {
    analysis?: unknown; quoteConfig?: unknown; quoteRates?: unknown; pricingModel: string; feeOverrides: unknown; activeTier: unknown;
  }) => {
    const { analysisFromQuoteConfig, derivePricingForRole } = await import("@/lib/pricing");
    const effective = await getEffectiveRole();
    const analysis = input.analysis ?? (input.quoteConfig ? analysisFromQuoteConfig(input.quoteConfig as never) : null);
    if (!analysis) throw new Error("A statement or a volume and ticket is needed to price a quote.");
    return derivePricingForRole(
      analysis as never, input.quoteRates as never, input.pricingModel, input.feeOverrides as never,
      effective.role, input.activeTier as never, { paddingAdyenCostHide: true }
    );
  }),
}));
vi.mock("@/lib/actions/rateMatrix", () => ({ getRateMatrix }));
vi.mock("@/lib/marginReqsLoader", () => ({
  loadMarginReqs: vi.fn(async () => (await import("@/lib/pricing")).MARGIN_REQS),
}));
vi.mock("@/lib/staff", () => ({ getStaffRecipient: vi.fn() }));

const FLAT_RATE_CARD = {
  cardPresentBps: Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 249)),
  cardNotPresentBps: 249,
  perTransactionFeeCents: 15,
};

const { SANDBOX_MESSAGE } = await import("@/lib/debug/sandbox");
const { createProspectAction, sendDraftAction, resendLeadLinkAction, issueCustomerQuoteLinkAction } =
  await import("@/lib/actions/prospects");

const BUSINESS: BusinessInfo = {
  legalName: "Torta Palace LLC", dba: "Torta Palace", bizType: "llc",
  address: "1200 Wilshire Blvd", city: "Los Angeles", state: "CA", zip: "90017",
  phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const OWNER: OwnerContact = { firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@tortapalace.com", phone: "5551234567" };
const COMPANY_ID = "334295287484";
type Input = Parameters<typeof createProspectAction>[0];
const baseInput = (over: Partial<Input> = {}): Input => ({
  business: BUSINESS,
  ownerContact: OWNER,
  processing: null,
  pricingModel: "2-tier",
  quoteType: "all_in_one",
  picks: [],
  channels: [],
  quoteConfig: { monthlyVolume: 100000, avgTicket: 30 },
  hubspotCompanyId: COMPANY_ID,
  deal: { mode: "existing", dealId: "deal-1" },
  ...over,
});

let savedSandbox: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSandbox = process.env.DEBUG_SANDBOX;
  process.env.DEBUG_SANDBOX = "true";
  getRateMatrix.mockResolvedValue(FLAT_RATE_CARD);
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getCompanyProfile.mockResolvedValue({ id: COMPANY_ID, name: "Torta Palace", tenantRef: null, adyenAccountHolderId: null });
  resolveDealForCompany.mockResolvedValue({
    ok: true, created: false,
    deal: { id: "deal-1", name: "Deal", pipelineId: "default", stageId: "s", stageLabel: "S", amount: 0, createdAt: "", closed: false, won: false, companyIds: [COMPANY_ID] },
  });
  sendLeadLinkEmail.mockResolvedValue({ sent: true, devUrl: null });
  sendLeadLinkSms.mockResolvedValue({ sent: true, devUrl: null });
});
afterEach(() => {
  if (savedSandbox === undefined) delete process.env.DEBUG_SANDBOX;
  else process.env.DEBUG_SANDBOX = savedSandbox;
});

function expectNothingSent() {
  expect(saveApplication).not.toHaveBeenCalled();
  expect(resolveDealForCompany).not.toHaveBeenCalled();
  expect(sendLeadLinkEmail).not.toHaveBeenCalled();
  expect(sendLeadLinkSms).not.toHaveBeenCalled();
  expect(moveDealToQuoteSentAtSend).not.toHaveBeenCalled();
}

const liveApp = (over: Partial<MerchantApplication> = {}): MerchantApplication => ({
  id: "app-1", ownerUserId: "rep-1", stage: "quote_sent", quoteStatus: null, quoteApproval: null,
  customerLinkToken: "tok-1", customerLinkPurpose: "lead_upload",
  customerLinkExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  hubspotDealId: "deal-1", tenantLink: { hubspotCompanyId: COMPANY_ID },
  quoteConfig: { monthlyVolume: 100000, avgTicket: 30 }, quoteRates: null, quoteLines: null, quoteType: "all_in_one",
  business: BUSINESS, ownerContact: OWNER,
  ...over,
} as unknown as MerchantApplication);

describe("sends refuse and save nothing", () => {
  it("createProspectAction, mode send", async () => {
    await expect(createProspectAction(baseInput())).rejects.toThrow(SANDBOX_MESSAGE);
    expectNothingSent();
  });

  it("sendDraftAction on a never-sent draft", async () => {
    // Build a real draft row first (allowed), then try to send it.
    await createProspectAction(baseInput({ mode: "draft" }));
    const draft = saveApplication.mock.calls[0][1] as MerchantApplication;
    saveApplication.mockClear();
    getApplication.mockResolvedValue(draft);
    await expect(sendDraftAction(draft.id)).rejects.toThrow(SANDBOX_MESSAGE);
    expectNothingSent();
  });

  it("resendLeadLinkAction", async () => {
    getApplication.mockResolvedValue(liveApp());
    await expect(resendLeadLinkAction("app-1")).rejects.toThrow(SANDBOX_MESSAGE);
    expectNothingSent();
  });

  it("issueCustomerQuoteLinkAction (the wizard's send)", async () => {
    getApplication.mockResolvedValue(liveApp({ customerLinkToken: null }));
    await expect(issueCustomerQuoteLinkAction("app-1")).rejects.toThrow(SANDBOX_MESSAGE);
    expectNothingSent();
  });
});

describe("pure DB edits still save", () => {
  it("createProspectAction, mode draft: saved once, nothing sent", async () => {
    const result = await createProspectAction(baseInput({ mode: "draft" }));
    expect(result.quoteStatus).toBe("draft");
    expect(saveApplication).toHaveBeenCalledTimes(1);
    expect(sendLeadLinkEmail).not.toHaveBeenCalled();
    expect(resolveDealForCompany).not.toHaveBeenCalled();
  });

  it("sendDraftAction on an approved edit whose link is already out: made live, nothing re-sent", async () => {
    getApplication.mockResolvedValue(liveApp({ quoteStatus: "draft" }));
    const result = await sendDraftAction("app-1");
    expect(result.delivered).toBe(false);
    expect(saveApplication).toHaveBeenCalledTimes(1);
    expect(sendLeadLinkEmail).not.toHaveBeenCalled();
  });
});

describe("flag unset: the same send goes out (unchanged behaviour)", () => {
  it("createProspectAction, mode send", async () => {
    delete process.env.DEBUG_SANDBOX;
    const result = await createProspectAction(baseInput());
    expect(result.linkUrl).toBeTruthy();
    expect(saveApplication).toHaveBeenCalledTimes(1);
    expect(sendLeadLinkEmail).toHaveBeenCalledTimes(1);
  });
});
