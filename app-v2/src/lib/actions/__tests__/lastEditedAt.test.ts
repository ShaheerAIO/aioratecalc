import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusinessInfo, CatalogProduct, OwnerContact, QuoteRates } from "@/types/merchant";

// lastEditedAt (product owner, 2026-11-11): stamped by the staff edit actions
// (create and quote save), preserved by nothing else.

const getEffectiveRole = vi.fn();
const saveApplication = vi.fn();
const getApplication = vi.fn();
const getCompanyProfile = vi.fn();
const listQuotableProductsAction = vi.fn();
const getRateMatrix = vi.fn();
const createApprovalTicket = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { saveApplication, getApplication } }));
vi.mock("@/lib/adapters/hubspot", () => ({
  getCompanyProfile, listCompanyContacts: vi.fn(), updateCompanyMerchantDetails: vi.fn(),
  ensureQuoteContact: vi.fn(), getContactById: vi.fn(), updateContactDetails: vi.fn(),
  moveDealToQuoteSentAtSend: vi.fn(), createApprovalTicket, closeApprovalTicket: vi.fn(),
}));
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany: vi.fn() }));
vi.mock("@/lib/adapters/email", () => ({ sendLeadLinkEmail: vi.fn() }));
vi.mock("@/lib/adapters/sms", () => ({ sendLeadLinkSms: vi.fn() }));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote: vi.fn(), resolveSender: vi.fn() }));
const PADDING = { paddingAdyenCostHide: true };
vi.mock("@/lib/actions/pricing", () => ({
  getActivePaddingPolicy: vi.fn().mockResolvedValue(PADDING),
  getMaxDiscountPercent: vi.fn().mockResolvedValue(50),
  getQuoteLimits: vi.fn().mockResolvedValue({ unitCaps: {}, maxBillingDelayDays: 90 }),
  // The real role-scoped math, as createProspect.test.ts runs it.
  getPricingPreviewAction: vi.fn(async (input: {
    analysis?: unknown; quoteConfig?: unknown; quoteRates?: unknown; pricingModel: string; feeOverrides: unknown; activeTier: unknown;
  }) => {
    const { analysisFromQuoteConfig, derivePricingForRole } = await import("@/lib/pricing");
    const effective = await getEffectiveRole();
    const analysis = input.analysis ?? (input.quoteConfig ? analysisFromQuoteConfig(input.quoteConfig as never) : null);
    if (!analysis) throw new Error("A statement or a volume and ticket is needed to price a quote.");
    return derivePricingForRole(
      analysis as never, input.quoteRates as never, input.pricingModel, input.feeOverrides as never,
      effective.role, input.activeTier as never, PADDING
    );
  }),
}));
vi.mock("@/lib/actions/rateMatrix", () => ({ getRateMatrix }));
vi.mock("@/lib/marginReqsLoader", () => ({
  loadMarginReqs: vi.fn(async () => (await import("@/lib/pricing")).MARGIN_REQS),
}));
vi.mock("@/lib/staff", () => ({ getStaffRecipient: vi.fn(async (id: string) => ({ id, email: `${id}@aioapp.com`, name: id })) }));

const { createProspectAction, saveQuoteConfigurationAction } = await import("@/lib/actions/prospects");

// The policy CNP is 3.30%, so the 2.49% DEFAULT_QUOTE_RATES placeholder is
// NOT the standard card. Every rate-card cell is 2.17%.
const RATE_CARD = {
  cardPresentBps: Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 217)),
  cardNotPresentBps: 330,
  perTransactionFeeCents: 15,
};
const STANDARD: QuoteRates = {
  cardPresentRate: 0.0249, amexCardPresentRate: 0.0249,
  cardNotPresentRate: 0.033, amexCardNotPresentRate: 0.033, perTransactionFee: 0.15,
};

const p = (
  hubspotProductId: string, name: string, price: number,
  billingFrequency: CatalogProduct["billingFrequency"], productType: string,
): CatalogProduct => ({ hubspotProductId, name, price, billingFrequency, productType });
const CATALOG: CatalogProduct[] = [
  p("335283119838", "All-in-One Platform", 399, "monthly", ""),
  p("217445755632", "POS Unit", 749, "one_time", "inventory"),
  p("223511653105", "Payment Terminal - AMS1", 300, "one_time", "inventory"),
  p("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  p("260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"),
];
const PLAN_START = { "335283119838": { billingStart: { mode: "days" as const, days: 45 } } };
const BUSINESS: BusinessInfo = {
  legalName: "Torta Palace LLC", dba: "Torta Palace", bizType: "llc",
  address: "", city: "", state: "", zip: "", phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const OWNER: OwnerContact = { firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@tortapalace.com", phone: "" };

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getCompanyProfile.mockResolvedValue({ id: "c-1", name: "Torta Palace", tenantRef: null, adyenAccountHolderId: null });
  listQuotableProductsAction.mockResolvedValue({ products: CATALOG.filter(c => c.hubspotProductId === "217445755632"), all: CATALOG, error: null });
  getRateMatrix.mockResolvedValue(RATE_CARD);
  createApprovalTicket.mockResolvedValue("ticket-1");
});

describe("lastEditedAt", () => {
  it("createProspectAction stamps it", async () => {
    const before = Date.now();
    await createProspectAction({
      mode: "draft", business: BUSINESS, ownerContact: OWNER, processing: null, pricingModel: "2-tier",
      quoteType: "all_in_one", picks: [{ hubspotProductId: "217445755632", qty: 1 }], channels: [],
      adjustments: PLAN_START, quoteRates: STANDARD, standardRates: true, quoteConfig: null,
      hubspotCompanyId: "c-1", deal: { mode: "existing", dealId: "deal-1" },
    });
    const saved = saveApplication.mock.calls[0][1];
    expect(Date.parse(saved.lastEditedAt)).toBeGreaterThanOrEqual(before);
  });

  it("saveQuoteConfigurationAction stamps it, replacing the stored value", async () => {
    getApplication.mockResolvedValue({
      id: "app-1", ownerUserId: "rep-1", stage: "lead_link_sent", quoteStatus: "draft", quoteApproval: null,
      quoteAcceptedAt: null, detailsConfirmedAt: null, hubspotIds: null, quoteConfig: null, quoteRates: STANDARD,
      quoteNote: null, quoteLines: [], analysis: null, tenantLink: null, lastEditedAt: "2020-01-01T00:00:00.000Z",
      business: BUSINESS, ownerContact: OWNER, customerLinkToken: null,
    });
    const before = Date.now();
    await saveQuoteConfigurationAction({
      applicationId: "app-1", picks: [{ hubspotProductId: "217445755632", qty: 1 }], channels: [],
      adjustments: PLAN_START, quoteRates: STANDARD, pricingModel: "2-tier", quoteType: "all_in_one",
      quoteConfig: { monthlyVolume: 40000, avgTicket: 30 },
    });
    const saved = saveApplication.mock.calls[0][1];
    expect(Date.parse(saved.lastEditedAt)).toBeGreaterThanOrEqual(before);
  });
});
