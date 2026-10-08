import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { CatalogProduct, MerchantApplication, QuoteLine } from "@/types/merchant";
import { picksFromQuoteLines, toQuoteLine } from "@/lib/quoting";
import { PACKAGES } from "@/lib/quotePackages";

// The free hardware kit is switched off for this file: these tests are about
// re-derivation and the discount cap, and left on the kit would cover the very
// hardware lines they discount. It has its own file (quotePackages.test.ts).
beforeAll(() => { for (const pkg of PACKAGES) pkg.active = false; });
import { DEFAULT_QUOTE_RATES } from "@/types/merchant";

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
  listCompanyContacts: vi.fn(),
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
  getMaxDiscountPercent: vi.fn().mockResolvedValue(50),
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
  p("335283119838", "All-in-One Platform", 399, "monthly", ""),
  p("335279520445", "All-in-One (Order & Pay only)", 299, "monthly", ""),
  p("217445755632", "POS Unit", 749, "one_time", "inventory"),
  p("223511653105", "Payment Terminal - AMS1", 300, "one_time", "inventory"),
  p("281351401209", "AIO WiFi Network Package", 999, "one_time", "inventory"),
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  // The marketing plans and the hardware they include — enough to prove an
  // empty marketing picker still derives a real quote.
  p("332609247965", "AIO Marketing Platform", 199, "monthly", "Software"),
  p("332927902454", "AIO Marketing Platform (2-year term)", 299, "monthly", "Software"),
  p("223511653103", "Menu Board Computer", 99, "one_time", "inventory"),
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
    quoteType: "all_in_one",
    quoteConfig: { monthlyVolume: 10000, avgTicket: 50 },
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
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
      pricingModel: "2-tier",
    });

    const names = updated.quoteLines!.map(l => l.name).sort();
    expect(names).toEqual([
      "AIO WiFi Network Package",
      "All-in-One Platform",
      "Onsite Installation",
      "POS Unit",
      "Payment Terminal - AMS1",
      "System Onboarding and Training",
    ].sort());
    // One ordering point (one POS Unit). Reported, not priced on.
    expect(updated.orderPoints?.total).toBe(1);
  });

  it("still derives a marketing quote when the rep picked nothing at all", async () => {
    // The most natural shape of the $199 plan: marketing, no hardware. It used
    // to short-cut the derivation and save `quoteLines: null`, so the rep
    // approved the quote the configurator had priced in front of them and the
    // merchant's link then showed no quote at all. There is no rate behind a
    // marketing plan, so an empty picker is not a rate-only quote.
    getApplication.mockResolvedValue(app({ quoteType: "marketing_only" }));

    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [],
      channels: [],
      pricingModel: "2-tier",
      quoteType: "marketing_only",
    });

    expect(updated.quoteLines!.map(l => l.name)).toEqual([
      "AIO Marketing Platform",
      "Menu Board Computer",
    ]);
    // Included, so the merchant pays the subscription and nothing else.
    expect(updated.quoteLines!.find(l => l.name === "Menu Board Computer")!.discountPercent).toBe(100);
    // Marketing quotes carry no ordering-point count.
    expect(updated.orderPoints).toBeNull();
  });

  it("still saves a rate-only processing quote as no lines, without reading the catalog", async () => {
    // The other half of the same condition, and the reason it can't simply be
    // deleted: a rate-only quote derives to nothing either way, so skipping
    // the catalog read keeps prospect creation working through a HubSpot
    // outage.
    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [],
      channels: [],
      pricingModel: "2-tier",
    });

    expect(updated.quoteLines).toBeNull();
    expect(listQuotableProductsAction).not.toHaveBeenCalled();
  });

  it("applies a rep's discount to a DERIVED line the picks never carry", async () => {
    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [{ hubspotProductId: "217445755632", qty: 1 }],
      channels: [],
      adjustments: {
        // Onsite Installation — derived, hidden from the picker, and the line
        // AIO comps more than any other.
        "223452690133": { discountPercent: 50 },
        "335283119838": { billingStart: { mode: "days", days: 60 } },
      },
      pricingModel: "2-tier",
    });

    const install = updated.quoteLines!.find(l => l.name === "Onsite Installation")!;
    expect(install.discountPercent).toBe(50);
    const platform = updated.quoteLines!.find(l => l.name === "All-in-One Platform")!;
    expect(platform.billingStart).toEqual({ mode: "days", days: 60 });
  });

  it("refuses a discount over the SERVER's cap, whatever the browser believed", async () => {
    await expect(
      saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [{ hubspotProductId: "217445755632", qty: 1 }],
        channels: [],
        // The mocked getMaxDiscountPercent above says 50. A client that shipped
        // a 100% comp anyway gets refused here, not quietly saved.
        adjustments: { "217445755632": { discountPercent: 100 } },
        pricingModel: "2-tier",
      })
    ).rejects.toThrow(/100%.*50% limit/);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("reopening a saved quote and re-saving it unchanged does not duplicate the platform line or the included services", async () => {
    // Simulate a quote that was already saved once: derived lines (platform +
    // the three included services) plus one picked POS unit.
    const savedLines: QuoteLine[] = [
      toQuoteLine(FULL_CATALOG.find(c => c.name === "All-in-One Platform")!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "AIO WiFi Network Package")!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "Onsite Installation")!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "System Onboarding and Training")!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "POS Unit")!, 1),
    ];
    getApplication.mockResolvedValue(app({ quoteLines: savedLines, orderPoints: { hardware: { "POS Unit": 1 }, channels: [], total: 1 } }));

    // The UI rehydrates the configurator with picksFromQuoteLines — derived
    // lines are stripped back out, leaving just what the rep actually picked.
    const rehydratedPicks = picksFromQuoteLines(savedLines, "all_in_one");
    expect(rehydratedPicks).toEqual([{ hubspotProductId: "217445755632", qty: 1 }]);

    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: rehydratedPicks,
      channels: [],
      // Above the rep-padded floor for this volume (~0.01005) — this test is
      // about line-item deduplication, not the margin floor.
      pricingModel: "2-tier",
    });

    const platformLines = updated.quoteLines!.filter(l => l.name === "All-in-One Platform");
    const installLines = updated.quoteLines!.filter(l => l.name === "Onsite Installation");
    const wifiLines = updated.quoteLines!.filter(l => l.name === "AIO WiFi Network Package");
    const trainingLines = updated.quoteLines!.filter(l => l.name === "System Onboarding and Training");
    expect(platformLines).toHaveLength(1);
    expect(installLines).toHaveLength(1);
    expect(wifiLines).toHaveLength(1);
    expect(trainingLines).toHaveLength(1);
    expect(updated.quoteLines).toHaveLength(6);
    expect(updated.quoteLines!.filter(l => l.name === "Payment Terminal - AMS1")).toHaveLength(1);
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
describe("saveQuoteConfigurationAction — rates, and the floor that no longer blocks", () => {
  it("saves a rate far below AIO's cost without complaint", async () => {
    // Floor enforcement was removed on 2026-10-06 with the margin input it
    // checked (product-owner decision). 0.5% is below the true floor for every
    // volume tier AND below AIO's processing cost; it saves anyway. The rep is
    // still WARNED — derivePricingForRole computes belowCostFloor and both rep
    // surfaces render it — but nothing refuses.
    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [],
      channels: [],
      quoteRates: { cardPresentRate: 0.005, cardNotPresentRate: 0.005, amexCardPresentRate: 0.005, amexCardNotPresentRate: 0.005, perTransactionFee: 0 },
      pricingModel: "2-tier",
    });

    expect(updated.quoteRates).toEqual({
      cardPresentRate: 0.005, cardNotPresentRate: 0.005,
      amexCardPresentRate: 0.005, amexCardNotPresentRate: 0.005, perTransactionFee: 0,
    });
    expect(saveApplication).toHaveBeenCalled();
  });

  it("refuses nothing for a rep that it would allow an admin", async () => {
    // The old guard was scoped per role — admins held to the true floor, reps
    // to the padded one — specifically because a refusal is an oracle a rep
    // could binary-search. With no refusal there is no oracle, and the two
    // roles save identically. Worth re-reading the note in prospects.ts before
    // enforcement comes back against a typed rate.
    const low = {
      applicationId: "app-1",
      picks: [],
      channels: [],
      quoteRates: { cardPresentRate: 0.008, cardNotPresentRate: 0.008, amexCardPresentRate: 0.008, amexCardNotPresentRate: 0.008, perTransactionFee: 0 },
      pricingModel: "2-tier" as const,
    };

    getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
    const asRep = await saveQuoteConfigurationAction(low);
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });
    const asAdmin = await saveQuoteConfigurationAction(low);

    expect(asRep.quoteRates).toEqual(asAdmin.quoteRates);
  });

  it("keeps the row's existing rates when the caller sends none", async () => {
    const existing = { cardPresentRate: 0.0275, cardNotPresentRate: 0.03, amexCardPresentRate: 0.0275, amexCardNotPresentRate: 0.03, perTransactionFee: 0.2 };
    getApplication.mockResolvedValue(app({ quoteRates: existing }));

    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [],
      channels: [],
      pricingModel: "2-tier",
    });

    expect(updated.quoteRates).toEqual(existing);
  });

  it("falls back to the standard rates on a row that has none", async () => {
    // Every row written before 2026-10-06. It must come out of a save with a
    // real rate on it rather than null, so what the merchant is quoted is
    // recorded rather than inferred later.
    getApplication.mockResolvedValue(app({ quoteRates: null }));

    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [],
      channels: [],
      pricingModel: "2-tier",
    });

    expect(updated.quoteRates).toEqual(DEFAULT_QUOTE_RATES);
  });
});
