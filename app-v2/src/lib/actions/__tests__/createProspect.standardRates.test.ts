import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BusinessInfo, CatalogProduct, OwnerContact, QuoteRates } from "@/types/merchant";

// createProspectAction and "Use standard rates" (product owner, 2026-11-11:
// "this can be used for a new restaurant that doesn't have any volume yet").
// A processing quote has needed a monthly volume AND an average ticket since
// 2026-10-18; the standard card waives that — but only the exact standard
// card (2.49% + $0.15 card present, the LIVE policy CNP), only when the rep
// asked for it, and without waiving anything on a quote that HAS a volume.

const getEffectiveRole = vi.fn();
const saveApplication = vi.fn();
const getCompanyProfile = vi.fn();
const listQuotableProductsAction = vi.fn();
const getRateMatrix = vi.fn();
const createApprovalTicket = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({ postgresStorage: { saveApplication, getApplication: vi.fn() } }));
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

const { createProspectAction } = await import("@/lib/actions/prospects");

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
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  p("260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"),
  p("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
];
const PICKABLE = CATALOG.filter(c => c.hubspotProductId === "217445755632");
// The plan's own 45-day start, so the quote needs no note.
const PLAN_START = { "335283119838": { billingStart: { mode: "days" as const, days: 45 } } };

const BUSINESS: BusinessInfo = {
  legalName: "Torta Palace LLC", dba: "Torta Palace", bizType: "llc",
  address: "", city: "", state: "", zip: "", phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const OWNER: OwnerContact = { firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@tortapalace.com", phone: "" };

type Input = Parameters<typeof createProspectAction>[0];
const input = (over: Partial<Input> = {}): Input => ({
  mode: "draft",
  business: BUSINESS,
  ownerContact: OWNER,
  processing: null,
  pricingModel: "2-tier",
  quoteType: "all_in_one",
  picks: [{ hubspotProductId: "217445755632", qty: 1 }],
  channels: [],
  adjustments: PLAN_START,
  quoteRates: STANDARD,
  standardRates: true,
  quoteConfig: null,
  hubspotCompanyId: "c-1",
  deal: { mode: "existing", dealId: "deal-1" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getCompanyProfile.mockResolvedValue({ id: "c-1", name: "Torta Palace", tenantRef: null, adyenAccountHolderId: null });
  listQuotableProductsAction.mockResolvedValue({ products: PICKABLE, all: CATALOG, error: null });
  getRateMatrix.mockResolvedValue(RATE_CARD);
  createApprovalTicket.mockResolvedValue("ticket-1");
});

describe("createProspectAction — standard rates with no volume", () => {
  it("saves a processing quote on the standard card with no volume or ticket, needing no approval", async () => {
    const res = await createProspectAction(input());
    expect(res.quoteStatus).toBe("draft");
    expect(res.overrides).toEqual([]);
    expect(saveApplication).toHaveBeenCalledTimes(1);
    const saved = saveApplication.mock.calls[0][1];
    expect(saved.quoteConfig).toBeNull();
    expect(saved.quoteRates).toEqual(STANDARD);
    expect(saved.quoteLines.length).toBeGreaterThan(0);
  });

  it("still refuses without the rep asking for standard rates (the 2026-10-18 rule stands)", async () => {
    await expect(createProspectAction(input({ standardRates: false })))
      .rejects.toThrow(/monthly volume and average ticket/);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("refuses a card-present rate other than 2.49%", async () => {
    await expect(createProspectAction(input({ quoteRates: { ...STANDARD, cardPresentRate: 0.026, amexCardPresentRate: 0.026 } })))
      .rejects.toThrow(/monthly volume and average ticket/);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("refuses the 2.49% CNP placeholder: standard means the POLICY card-not-present rate", async () => {
    await expect(createProspectAction(input({
      quoteRates: { ...STANDARD, cardNotPresentRate: 0.0249, amexCardNotPresentRate: 0.0249 },
    }))).rejects.toThrow(/monthly volume and average ticket/);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("refuses a different per-transaction fee", async () => {
    await expect(createProspectAction(input({ quoteRates: { ...STANDARD, perTransactionFee: 0.1 } })))
      .rejects.toThrow(/monthly volume and average ticket/);
  });

  it("still refuses a rate-only quote: with no lines and no volume there is nothing to show the merchant", async () => {
    await expect(createProspectAction(input({ picks: [], adjustments: {} })))
      .rejects.toThrow(/nothing on it yet/);
    expect(saveApplication).not.toHaveBeenCalled();
  });
});

describe("createProspectAction — standard rates WITH a volume are judged like any rate", () => {
  // At $400k a month and a $30 ticket the 2.17% cell may move -14..+3 bps;
  // 2.49% is +32. The flag waives nothing once there is a volume to judge on.
  it("flags 2.49% against a 2.17% card as an adjustment outside the range, and holds it for approval", async () => {
    const res = await createProspectAction(input({ quoteConfig: { monthlyVolume: 400000, avgTicket: 30 } }));
    expect(res.quoteStatus).toBe("pending_approval");
    expect(res.overrides.some(o => o.kind === "cp_rate" && /adjustment \+32 bps/.test(o.message))).toBe(true);
  });
});
