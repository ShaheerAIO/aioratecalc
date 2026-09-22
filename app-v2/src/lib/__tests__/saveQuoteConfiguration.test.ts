import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CatalogProduct, MerchantApplication, QuoteLine } from "@/types/merchant";
import { PLATFORM_TIER_PRODUCT_NAMES, picksFromQuoteLines, toQuoteLine } from "@/lib/quoting";

// saveQuoteConfigurationAction — the one write path for the quoting half of an
// application, shared by the wizard and the account-detail "Edit Quote" panel.
// Under test: (1) the acceptance guard, which must live here so both callers
// get it for free; (2) that an edit before acceptance re-derives lines against
// the live catalog rather than trusting the browser; (3) that reopening a
// saved quote (picksFromQuoteLines) and re-saving it unchanged doesn't
// duplicate the platform line or the always-included services.

const getEffectiveRole = vi.fn();
const getApplication = vi.fn();
const saveApplication = vi.fn();
const listQuotableProductsAction = vi.fn();

vi.mock("@/lib/auth/getEffectiveRole", () => ({ getEffectiveRole }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getApplication, saveApplication },
}));
vi.mock("@/lib/actions/catalog", () => ({ listQuotableProductsAction }));
vi.mock("@/lib/adapters/hubspot", () => ({
  getCompanyOwnerContact: vi.fn(),
  getCompanyProfile: vi.fn(),
}));
vi.mock("@/lib/adapters/email", () => ({ sendLeadLinkEmail: vi.fn() }));
vi.mock("@/lib/adapters/sms", () => ({ sendLeadLinkSms: vi.fn() }));
// prospects.ts now imports resolveDealForCompany for the Company & Deal
// picker — mocked so the real module (which pulls in the server-only db
// client) is never loaded here. This suite doesn't exercise deal resolution
// at all (saveQuoteConfigurationAction never calls it).
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany: vi.fn() }));
// Default 50% pillow, matching actions/pricing.ts's DEFAULT_PADDING — the
// true-floor-enforcement tests below rely on this exact ratio.
vi.mock("@/lib/actions/pricing", () => ({
  getActivePaddingPolicy: vi.fn().mockResolvedValue({
    paddingPct: 0.5, paddingMinMrrAdd: 0, paddingAdyenCostHide: true,
  }),
}));

const { saveQuoteConfigurationAction } = await import("@/lib/actions/prospects");

// Fixture catalog: one platform tier, one pickable POS unit, and the three
// always-included services — enough to exercise buildQuote's derivation.
const p = (
  hubspotProductId: string,
  name: string,
  price: number,
  billingFrequency: CatalogProduct["billingFrequency"],
  productType: string,
): CatalogProduct => ({ hubspotProductId, name, price, billingFrequency, productType });

const FULL_CATALOG: CatalogProduct[] = [
  p("217526517443", PLATFORM_TIER_PRODUCT_NAMES.small, 99, "weekly", "Software"),
  p("292286544587", PLATFORM_TIER_PRODUCT_NAMES.large, 199, "weekly", "Software"),
  p("217445755632", "POS Unit", 749, "one_time", "inventory"),
  p("281351401209", "AIO WiFi Network Package", 999, "one_time", "inventory"),
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
];
const PICKABLE = FULL_CATALOG.filter(c => c.hubspotProductId === "217445755632");

const app = (over: Partial<MerchantApplication> = {}): MerchantApplication =>
  ({
    id: "app-1",
    ownerUserId: "rep-1",
    customerUserId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    stage: "quote_sent",
    hubspotDealId: null,
    tenantLink: null,
    adyenIds: null,
    adyenOnboardingUrl: null,
    checkIds: null,
    foodbuyIds: null,
    hubspotIds: null,
    quoteType: "full_pos",
    quoteConfig: { monthlyVolume: 10000, avgTicket: 50 },
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
    targetMargin: 0.008,
    pricingModel: "2-tier",
    customerLinkToken: "tok-live",
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: "2026-08-01T00:00:00.000Z",
    customerLinkExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    analysis: null,
    proposal: null,
    business: {
      legalName: "Test Co LLC", dba: "Test Co", bizType: "llc", address: "",
      city: "", state: "", zip: "", phone: "", website: "",
      yearsInBusiness: "", annualRevenue: "",
    },
    ownerContact: {
      firstName: "Jane", lastName: "Doe", title: "Owner",
      email: "jane@testco.com", phone: "555-0101",
    },
    processing: null,
    agreement: null,
    ...over,
  }) as MerchantApplication;

beforeEach(() => {
  vi.clearAllMocks();
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getApplication.mockResolvedValue(app());
  saveApplication.mockResolvedValue(undefined);
  listQuotableProductsAction.mockResolvedValue({ products: PICKABLE, all: FULL_CATALOG, error: null });
});

describe("saveQuoteConfigurationAction — acceptance guard", () => {
  it("refuses to save once quoteAcceptedAt is set", async () => {
    getApplication.mockResolvedValue(app({ quoteAcceptedAt: "2026-09-01T00:00:00.000Z" }));

    await expect(
      saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [{ hubspotProductId: "217445755632", qty: 2 }],
        channels: [],
        targetMargin: 0.01,
        pricingModel: "2-tier",
      })
    ).rejects.toThrow(/accepted/i);

    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("allows a save right up to the moment of acceptance (quoteAcceptedAt still null)", async () => {
    getApplication.mockResolvedValue(app({ quoteAcceptedAt: null }));

    await expect(
      saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [{ hubspotProductId: "217445755632", qty: 1 }],
        channels: [],
        // Above the rep-padded floor for this volume (~0.01005) — this test is
        // about the acceptance guard, not the margin floor.
        targetMargin: 0.02,
        pricingModel: "2-tier",
      })
    ).resolves.toBeDefined();

    expect(saveApplication).toHaveBeenCalled();
  });
});

describe("saveQuoteConfigurationAction — re-derivation", () => {
  it("re-derives quoteLines server-side from the picks against the live catalog", async () => {
    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [{ hubspotProductId: "217445755632", qty: 1 }],
      channels: [],
      // Above the rep-padded floor for this volume (~0.01005) — this test is
      // about re-derivation, not the margin floor.
      targetMargin: 0.02,
      pricingModel: "2-tier",
    });

    const names = updated.quoteLines!.map(l => l.name).sort();
    expect(names).toEqual([
      "AIO Platform (1 to 5 Order Points)",
      "AIO WiFi Network Package",
      "Onsite Installation",
      "POS Unit",
      "System Onboarding and Training",
    ].sort());
    // One ordering point (one POS Unit) → the 1–5 tier, not the 6+ tier.
    expect(updated.orderPoints?.total).toBe(1);
  });

  it("reopening a saved quote and re-saving it unchanged does not duplicate the platform line or the included services", async () => {
    // Simulate a quote that was already saved once: derived lines (platform +
    // the three included services) plus one picked POS unit.
    const savedLines: QuoteLine[] = [
      toQuoteLine(FULL_CATALOG.find(c => c.name === PLATFORM_TIER_PRODUCT_NAMES.small)!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "AIO WiFi Network Package")!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "Onsite Installation")!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "System Onboarding and Training")!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "POS Unit")!, 1),
    ];
    getApplication.mockResolvedValue(app({ quoteLines: savedLines, orderPoints: { hardware: { "POS Unit": 1 }, channels: [], total: 1 } }));

    // The UI rehydrates the configurator with picksFromQuoteLines — derived
    // lines are stripped back out, leaving just what the rep actually picked.
    const rehydratedPicks = picksFromQuoteLines(savedLines);
    expect(rehydratedPicks).toEqual([{ hubspotProductId: "217445755632", qty: 1 }]);

    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: rehydratedPicks,
      channels: [],
      // Above the rep-padded floor for this volume (~0.01005) — this test is
      // about line-item deduplication, not the margin floor.
      targetMargin: 0.02,
      pricingModel: "2-tier",
    });

    const platformLines = updated.quoteLines!.filter(l => l.name === PLATFORM_TIER_PRODUCT_NAMES.small);
    const installLines = updated.quoteLines!.filter(l => l.name === "Onsite Installation");
    const wifiLines = updated.quoteLines!.filter(l => l.name === "AIO WiFi Network Package");
    const trainingLines = updated.quoteLines!.filter(l => l.name === "System Onboarding and Training");
    expect(platformLines).toHaveLength(1);
    expect(installLines).toHaveLength(1);
    expect(wifiLines).toHaveLength(1);
    expect(trainingLines).toHaveLength(1);
    expect(updated.quoteLines).toHaveLength(5);
  });
});

// saveQuoteConfigurationAction is now the single write path for quote
// configuration (wizard + the account-detail Edit Quote panel). The guard is
// enforced PER ROLE, not against one shared "true" number:
//   - admin → the true floor (getMarginFloor's minMargin) — admins already
//     see true numbers everywhere else.
//   - rep   → the PADDED floor (derivePricingForRole's pillow) — the same
//     number their own client-side check already blocks at. Enforcing the
//     true floor for reps here would make the refusal itself an oracle: a
//     rep calling this action directly could binary-search targetMargin
//     (refuse, refuse, succeed) and recover the true floor to arbitrary
//     precision, exactly what the pillow exists to prevent. The padded floor
//     is always ≥ the true floor, so this is a strictly stricter limit for
//     reps, never a looser one.
//
// Fixture volume is 10000 (app()'s default quoteConfig), which sits in
// MARGIN_REQS' first tier (maxVol 25000): true minMargin 0.0067, and — with
// the default 50% admin pillow (mocked above) — a padded floor of ~0.01005.
describe("saveQuoteConfigurationAction — true-floor enforcement", () => {
  it("refuses a target margin below AIO's true minimum floor for this volume", async () => {
    await expect(
      saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [],
        channels: [],
        targetMargin: 0.005, // below the 0.0067 true floor for this volume tier
        pricingModel: "2-tier",
      })
    ).rejects.toThrow();
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("the refusal names no floor number for a rep", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
    let message = "";
    try {
      await saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [],
        channels: [],
        targetMargin: 0.005,
        pricingModel: "2-tier",
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/minimum for this volume/i);
    // A rep who's told "the minimum is X" can binary-search the slider to
    // learn AIO's true floor — the whole thing the pillow exists to prevent.
    expect(message).not.toMatch(/[0-9]/);
  });

  it("an admin's refusal names the true floor (admins already see true numbers elsewhere)", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });
    let message = "";
    try {
      await saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [],
        channels: [],
        targetMargin: 0.005,
        pricingModel: "2-tier",
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/[0-9]/);
  });

  it("does not block a marketing_only quote, which has no processing rate to floor", async () => {
    getApplication.mockResolvedValue(app({ quoteType: "marketing_only", quoteConfig: null, analysis: null }));

    await expect(
      saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [],
        channels: [],
        targetMargin: 0, // would be below every tier's floor if this were checked
        pricingModel: "2-tier",
        quoteType: "marketing_only",
      })
    ).resolves.toBeDefined();
  });

  it("does not block when there is no volume basis at all (no analysis, no quoteConfig)", async () => {
    getApplication.mockResolvedValue(app({ quoteConfig: null, analysis: null }));

    await expect(
      saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [{ hubspotProductId: "217445755632", qty: 1 }],
        channels: [],
        targetMargin: 0.0001,
        pricingModel: "2-tier",
        quoteConfig: null,
      })
    ).resolves.toBeDefined();
  });

  // This pair is the heart of the role-scoped change: 0.008 sits between the
  // true floor (0.0067) and the padded floor (~0.01005) for this volume — a
  // margin no honest rep workflow should ever want below, since it's exactly
  // what their own UI already blocks. A rep saving it directly must now be
  // refused (closing the oracle); an admin, who is trusted with the true
  // floor, must still be able to save it.
  it("refuses a margin between the true floor and the padded floor for a REP", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });

    await expect(
      saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [],
        channels: [],
        targetMargin: 0.008,
        pricingModel: "2-tier",
      })
    ).rejects.toThrow();
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("saves a margin between the true floor and the padded floor for an ADMIN", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });

    await expect(
      saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [],
        channels: [],
        targetMargin: 0.008,
        pricingModel: "2-tier",
      })
    ).resolves.toBeDefined();
    expect(saveApplication).toHaveBeenCalled();
  });
});
