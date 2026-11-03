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
const setDealBillingNotes = vi.fn();
vi.mock("@/lib/adapters/hubspot", () => ({
  listCompanyContacts: vi.fn(),
  getCompanyProfile: vi.fn(),
  setDealBillingNotes,
}));
const sendQuoteApprovalRequestEmail = vi.fn();
vi.mock("@/lib/adapters/email", () => ({ sendLeadLinkEmail: vi.fn(), sendQuoteApprovalRequestEmail }));
vi.mock("@/lib/adapters/sms", () => ({ sendLeadLinkSms: vi.fn() }));
// prospects.ts now imports resolveDealForCompany for the Company & Deal
// picker — mocked so the real module (which pulls in the server-only db
// client) is never loaded here. This suite doesn't exercise deal resolution
// at all (saveQuoteConfigurationAction never calls it).
vi.mock("@/lib/hubspotDeal", () => ({ resolveDealForCompany: vi.fn() }));
// prospects.ts now also imports buildAndPublishBillingQuote (10/13, the
// publish-at-send reversal) for createProspectAction's publishAtSend —
// mocked for the same reason as the one above (it pulls in the server-only
// db client), and because saveQuoteConfigurationAction never calls it either.
// resolveSender is mocked for the same reason, and is no longer touched by
// mirrorQuoteNote at all — the quote note moved onto the deal's billing_notes
// property on 2026-10-14, so there is no note author to resolve.
const resolveSender = vi.fn();
vi.mock("@/lib/billing/publishBillingQuote", () => ({ buildAndPublishBillingQuote: vi.fn(), resolveSender }));
const PADDING = { paddingAdyenCostHide: true };
vi.mock("@/lib/actions/pricing", () => ({
  getActivePaddingPolicy: vi.fn().mockResolvedValue(PADDING),
  getMaxDiscountPercent: vi.fn().mockResolvedValue(50),
  getQuoteLimits: vi.fn().mockResolvedValue({ unitCaps: {}, maxBillingDelayDays: 90, showTablets: false }),
  // A thin re-implementation of the real getPricingPreviewAction (actions/pricing.ts),
  // not a stub that always says "fine": saveQuoteConfigurationAction now calls the
  // real one to enforce the margin floor server-side (see assertRateAboveFloor in
  // prospects.ts), and the tests below assert on that enforcement — they need the
  // REAL margin math (derivePricingForRole, unmocked in this file) against the SAME
  // padding this mock returns above, or they'd prove nothing about the guard they
  // exist to test. Can't vi.importActual the real action: it imports the Drizzle db
  // client, which has nothing to connect to in this suite.
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

// Draft quotes + admin override approval (2026-11-02): the overrides are
// judged against the live rate card and margin table, and the admins are
// emailed — all three read the db, so they are stubbed. The rate card here is
// FLAT at the fixtures' own 2.49% card-present and card-not-present, so a
// quote on the default rates carries no rate override unless a test says so.
const getRateMatrix = vi.fn();
const listActiveAdminRecipients = vi.fn();
const getStaffRecipient = vi.fn();
vi.mock("@/lib/actions/rateMatrix", () => ({ getRateMatrix }));
vi.mock("@/lib/marginReqsLoader", () => ({
  loadMarginReqs: vi.fn(async () => (await import("@/lib/pricing")).MARGIN_REQS),
}));
vi.mock("@/lib/staff", () => ({ listActiveAdminRecipients, getStaffRecipient }));
const FLAT_RATE_CARD = {
  cardPresentBps: Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => 249)),
  cardNotPresentBps: 249,
  perTransactionFeeCents: 15,
};

const { saveQuoteConfigurationAction } = await import("@/lib/actions/prospects");
const { overrideFingerprint } = await import("@/lib/quoteOverrides");

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
  p("338690209525", "AIO Wifi Network Package - Unifi", 698, "one_time", "inventory"),
  p("223452690133", "Onsite Installation", 999, "one_time", "Service"),
  p("223152695032", "System Onboarding and Training", 499, "one_time", "Service"),
  // The marketing plans and the hardware they include — enough to prove an
  // empty marketing picker still derives a real quote.
  p("332609247965", "AIO Marketing Platform", 199, "monthly", "Software"),
  p("332927902454", "AIO Marketing Platform (2-year term)", 299, "monthly", "Software"),
  p("223511653103", "Menu Board Computer", 99, "one_time", "inventory"),
  // $0 rate disclosure — on every quote AIO processes for since 2026-10-14.
  p("260559288040", "AIO Processing Two Tiered Rate", 0, "one_time", "AIO Payment Processing"),
  // One-time lines are invoiced, so a delayed plan collects $0 at checkout and
  // every such quote carries the $0.50 pre-auth.
  p("281354281678", "AIO Pre Auth", 0.5, "one_time", "Service"),
];
// The POS a rep picks on a processing quote, and the Menu Board Computer the
// marketing plans preselect three of — both are ordinary picks now. So is the
// Unifi WiFi package (2026-10-21), which a reopened quote's WiFi line becomes.
const MENU_BOARD_ID = "223511653103";
const PICKABLE = FULL_CATALOG.filter(
  c => ["217445755632", MENU_BOARD_ID, "338690209525"].includes(c.hubspotProductId)
);

// The 45-day billing start the two POS plans seed onto their recurring lines
// the moment a rep clicks the plan (planDefaultBillingStart, quoting.ts), on
// the platform line it lands on here. Every save below that isn't ABOUT
// billing starts carries it, because a quote billing anywhere other than its
// plan's default now needs a note (quoteNoteBlockers, 2026-10-15) — these
// tests are about re-derivation and the acceptance guard, not about that.
const PLAN_START = { "335283119838": { billingStart: { mode: "days" as const, days: 45 } } };

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
    // No volume basis by default — see the doc comment on "the margin floor"
    // describe block below for why: it keeps every OTHER test in this file
    // from incidentally tripping the (now-enforced) margin-floor guard.
    quoteConfig: null,
    quoteLines: null,
    orderPoints: null,
    quoteAcceptedAt: null,
    pricingModel: "2-tier",
    customerLinkToken: "tok-live",
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: "2026-08-01T00:00:00.000Z",
    customerLinkExpiresAt: new Date(Date.now() + 7 * 24 * 45 * 45 * 1000).toISOString(),
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
  getRateMatrix.mockResolvedValue(FLAT_RATE_CARD);
  sendQuoteApprovalRequestEmail.mockResolvedValue({ sent: 2, failed: 0 });
  listActiveAdminRecipients.mockResolvedValue([
    { id: "admin-1", email: "admin1@aioapp.com", name: "Ada Admin" },
    { id: "admin-2", email: "admin2@aioapp.com", name: "Abe Admin" },
  ]);
  getStaffRecipient.mockImplementation(async (id: string) => ({ id, email: `${id}@aioapp.com`, name: `Name ${id}` }));
  getEffectiveRole.mockResolvedValue({ userId: "rep-1", role: "rep" });
  getApplication.mockResolvedValue(app());
  saveApplication.mockResolvedValue(undefined);
  listQuotableProductsAction.mockResolvedValue({ products: PICKABLE, all: FULL_CATALOG, error: null });
  resolveSender.mockResolvedValue({ ok: true, ownerId: "owner-rep-1", email: "rep@aioapp.com" });
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
        adjustments: PLAN_START,
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
      adjustments: PLAN_START,
      pricingModel: "2-tier",
    });

    const names = updated.quoteLines!.map(l => l.name).sort();
    expect(names).toEqual([
      // $0, derived, and on every quote AIO processes for (2026-10-14) — it
      // is how the rates reach the document the merchant signs.
      "AIO Processing Two Tiered Rate",
      // The plan is delayed 45 days and the hardware is invoiced, so nothing
      // else is due at checkout.
      "AIO Pre Auth",
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

    // The plan line, and nothing else. The three Menu Board Computers it
    // includes are a PICK since 2026-10-09 — preselected in the configurator,
    // not derived — so a payload that genuinely carries no picks is a plan on
    // its own, and a merchant who wanted none gets none.
    expect(updated.quoteLines!.map(l => l.name)).toEqual(["AIO Marketing Platform"]);
    // Marketing quotes carry no ordering-point count.
    expect(updated.orderPoints).toBeNull();
  });

  it("holds the Menu Board Computers the plan includes at $0 when they ARE picked", async () => {
    // The configurator preselects three; this is what the server does with
    // them. Anything past the plan's three bills, as a split line.
    getApplication.mockResolvedValue(app({ quoteType: "marketing_only" }));

    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [{ hubspotProductId: MENU_BOARD_ID, qty: 3 }],
      channels: [],
      pricingModel: "2-tier",
      quoteType: "marketing_only",
    });

    const boards = updated.quoteLines!.filter(l => l.name === "Menu Board Computer");
    expect(boards.map(l => [l.qty, l.discountPercent ?? null])).toEqual([[3, 100]]);
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
        "335283119838": { billingStart: { mode: "days", days: 45 } },
      },
      pricingModel: "2-tier",
    });

    const install = updated.quoteLines!.find(l => l.name === "Onsite Installation")!;
    expect(install.discountPercent).toBe(50);
    const platform = updated.quoteLines!.find(l => l.name === "All-in-One Platform")!;
    expect(platform.billingStart).toEqual({ mode: "days", days: 45 });
  });

  // Over the cap became an admin-approvable override on 2026-11-02, so it no
  // longer refuses the SAVE (the approval gate is wired here later; publish
  // still refuses it, see billingPreconditions.test.ts). A discount that is
  // not a percentage at all is still a hard refusal at save.
  it("refuses a discount that isn't a percentage, whatever the browser believed", async () => {
    await expect(
      saveQuoteConfigurationAction({
        applicationId: "app-1",
        picks: [{ hubspotProductId: "217445755632", qty: 1 }],
        channels: [],
        adjustments: { "217445755632": { discountPercent: 140 } },
        pricingModel: "2-tier",
      })
    ).rejects.toThrow(/140%, which isn't a percentage/);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("reopening a saved quote and re-saving it unchanged does not duplicate the platform line or the included services", async () => {
    // Simulate a quote that was already saved once: derived lines (platform +
    // the two included services) plus one picked POS unit. The WiFi line is
    // the RETIRED $999 product (281351401209) — pre-2026-10-13 quotes carry
    // it, and the catalog no longer does. Since 2026-10-21 WiFi is a pick, so
    // it reopens as a pick of the current Unifi package and re-saves as that.
    const savedLines: QuoteLine[] = [
      toQuoteLine(FULL_CATALOG.find(c => c.name === "All-in-One Platform")!, 1),
      toQuoteLine(
        { hubspotProductId: "281351401209", name: "AIO WiFi Network Package", price: 999, billingFrequency: "one_time", productType: "inventory" },
        1
      ),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "Onsite Installation")!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "System Onboarding and Training")!, 1),
      toQuoteLine(FULL_CATALOG.find(c => c.name === "POS Unit")!, 1),
    ];
    getApplication.mockResolvedValue(app({ quoteLines: savedLines, orderPoints: { hardware: { "POS Unit": 1 }, channels: [], total: 1 } }));

    // The UI rehydrates the configurator with picksFromQuoteLines — derived
    // lines are stripped back out, leaving what the rep actually picked.
    const rehydratedPicks = picksFromQuoteLines(savedLines, "all_in_one");
    expect(rehydratedPicks).toHaveLength(2);
    expect(rehydratedPicks).toContainEqual({ hubspotProductId: "217445755632", qty: 1 });
    expect(rehydratedPicks).toContainEqual({ hubspotProductId: "338690209525", qty: 1 });

    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: rehydratedPicks,
      channels: [],
      adjustments: PLAN_START,
      pricingModel: "2-tier",
    });

    const platformLines = updated.quoteLines!.filter(l => l.name === "All-in-One Platform");
    const installLines = updated.quoteLines!.filter(l => l.name === "Onsite Installation");
    const wifiLines = updated.quoteLines!.filter(l => l.name === "AIO Wifi Network Package - Unifi");
    const trainingLines = updated.quoteLines!.filter(l => l.name === "System Onboarding and Training");
    expect(platformLines).toHaveLength(1);
    expect(installLines).toHaveLength(1);
    // Re-derived onto the CURRENT product, not duplicated alongside the old one.
    expect(wifiLines).toHaveLength(1);
    expect(updated.quoteLines!.filter(l => l.name === "AIO WiFi Network Package")).toHaveLength(0);
    expect(trainingLines).toHaveLength(1);
    // 6 charged lines + the $0 rate disclosure, which is derived onto every
    // quote AIO processes for (2026-10-14) and so must not duplicate either,
    // + the $0.50 pre-auth the delayed plan needs.
    expect(updated.quoteLines).toHaveLength(8);
    expect(
      updated.quoteLines!.filter(l => l.name === "AIO Processing Two Tiered Rate")
    ).toHaveLength(1);
    expect(updated.quoteLines!.filter(l => l.name === "Payment Terminal - AMS1")).toHaveLength(1);
  });
});

// saveQuoteConfigurationAction is now the single write path for quote
// configuration (wizard + the account-detail Edit Quote panel), and as of
// this change it ENFORCES the margin floor again — see assertRateAboveFloor /
// marginFloorBlockers in prospects.ts/pricing.ts and the 2026-10-09 decision
// ("card rate minimums are needed") recorded there. Reps and admins are held
// to the same tier minimum (getMarginFloor's minMargin); the rep padding on
// top of it was removed 2026-10-23.
//
// `app()`'s own default carries NO quoteConfig (see its definition above) —
// deliberately, so every OTHER describe block in this file (re-derivation,
// the delayed-billing note, the acceptance guard) has no volume basis, which
// makes assertRateAboveFloor a no-op for them — the floor is never askable
// without a volume to clear it against (see assertRateAboveFloor's own doc
// comment). That's fine for those ~14 tests; none of them is about the floor.
// If a future edit puts a quoteConfig back on the shared app() default,
// expect a wave of unrelated failures in THIS file, not a sign anything here
// is broken — give those tests their own basis instead of reverting this.
//
// These tests supply their own basis via WITH_BASIS(): volume 10000, which
// sits in MARGIN_REQS' first tier (maxVol 25000, minMargin 0.0085).
describe("saveQuoteConfigurationAction — the margin floor", () => {
  const WITH_BASIS = () => app({ quoteConfig: { monthlyVolume: 10000, avgTicket: 50 } });

  // Under the floor is an admin-approvable override since 2026-11-02, not a
  // refusal: a rep's edit is held for approval, never thrown back.
  it("holds a rep's below-cost rate for approval, and never names the floor it failed", async () => {
    getApplication.mockResolvedValue(WITH_BASIS());
    const updated = await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [],
      channels: [],
      // 0.5% nets a NEGATIVE margin at this volume — below every tier's floor.
      quoteRates: { cardPresentRate: 0.005, cardNotPresentRate: 0.005, amexCardPresentRate: 0.005, amexCardNotPresentRate: 0.005, perTransactionFee: 0 },
      pricingModel: "2-tier",
    });

    expect(updated.quoteStatus).toBe("pending_approval");
    expect(saveApplication).toHaveBeenCalledTimes(1);
    const messages = updated.quoteApproval!.overrides.map(o => o.message);
    expect(messages).toContain("Card-present rate 0.50% is below the minimum margin");
    for (const m of messages) expect(m).not.toMatch(/0\.0085|0\.85\s*%/);
  });

  it("holds a rep and an admin to the same floor — there is no rep padding", async () => {
    // 2.90% nets ~0.78% here (under the first tier's 0.85% minimum) and 3.00%
    // ~0.88% (over it), so both roles must give the same answer at each.
    const at = (rate: number) => ({
      applicationId: "app-1",
      picks: [],
      channels: [],
      quoteRates: { cardPresentRate: rate, cardNotPresentRate: 0.0249, amexCardPresentRate: rate, amexCardNotPresentRate: 0.0249, perTransactionFee: 0 },
      pricingModel: "2-tier" as const,
    });
    const belowMargin = (a: MerchantApplication) =>
      (a.quoteApproval?.overrides ?? []).some(o => /below the minimum margin/.test(o.message));

    for (const role of ["rep", "admin"] as const) {
      getEffectiveRole.mockResolvedValue({ userId: `${role}-1`, role });
      getApplication.mockResolvedValue(WITH_BASIS());
      expect(belowMargin(await saveQuoteConfigurationAction(at(0.029)))).toBe(true);
      getApplication.mockResolvedValue(WITH_BASIS());
      expect(belowMargin(await saveQuoteConfigurationAction(at(0.03)))).toBe(false);
    }
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

// ── The note a long billing delay has to carry ──────────────────────────────
// Elizabeth Phillips, 2026-10-12: a rep who holds a first charge past the
// plan's own 45 days writes down why, and it lands on the HubSpot deal.
describe("saveQuoteConfigurationAction — the delayed-billing note", () => {
  const PLATFORM = "335283119838";
  const save = (quoteNote: string | undefined, days: number) =>
    saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [{ hubspotProductId: "217445755632", qty: 1 }],
      channels: [],
      adjustments: { [PLATFORM]: { billingStart: { mode: "days", days } } },
      quoteNote,
      pricingModel: "2-tier",
    });

  it("refuses a 90-day delay with nothing written down", async () => {
    await expect(save(undefined, 90)).rejects.toThrow(/write a note saying why/i);
    expect(saveApplication).not.toHaveBeenCalled();
  });

  it("refuses a note too short to be an explanation", async () => {
    await expect(save("ok", 90)).rejects.toThrow(/write a note saying why/i);
  });

  it("takes the 45 days the plan itself seeds without asking for anything", async () => {
    await expect(save(undefined, 45)).resolves.toBeTruthy();
    expect(setDealBillingNotes).not.toHaveBeenCalled();
  });

  it("writes the reason onto the deal's Billing Notes property", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-9" }));
    const updated = await save("Equipment lands in November, agreed with the owner.", 90);

    expect(updated.quoteNote).toBe("Equipment lands in November, agreed with the owner.");
    expect(setDealBillingNotes).toHaveBeenCalledTimes(1);
    const [dealId, text] = setDealBillingNotes.mock.calls[0];
    expect(dealId).toBe("deal-9");
    expect(text).toContain("90 days");
    expect(text).toContain("Equipment lands in November");
  });

  // The old note engagement needed a preamble because a note body carries no
  // label; the property's card is already called "Billing Notes", so below the
  // threshold the rep's sentence stands on its own.
  it("writes a sub-threshold note verbatim, with no preamble", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-9" }));
    await save("Just a note, no delay involved.", 45);
    expect(setDealBillingNotes).toHaveBeenCalledTimes(1);
    const [, text] = setDealBillingNotes.mock.calls[0];
    expect(text).toBe("Just a note, no delay involved.");
  });

  it("keeps the quote when the note can't reach HubSpot", async () => {
    // A note is a record of a decision, never a precondition for one — a
    // missing scope must not stop a rep quoting.
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-9" }));
    setDealBillingNotes.mockRejectedValueOnce(new Error("403 missing scope"));
    await expect(save("Equipment lands in November.", 90)).resolves.toBeTruthy();
    expect(saveApplication).toHaveBeenCalled();
  });

  it("writes nothing when the deal id is missing", async () => {
    getApplication.mockResolvedValue(app({ hubspotDealId: null }));
    await save("A note with nowhere to go.", 90);
    expect(setDealBillingNotes).not.toHaveBeenCalled();
  });

  it("does not rewrite a note the deal already carries", async () => {
    const note = "Equipment lands in November, agreed with the owner.";
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-9", quoteNote: note }));
    await save(note, 90);
    expect(setDealBillingNotes).not.toHaveBeenCalled();
  });

  it("leaves an existing note alone when the caller doesn't offer the box", async () => {
    const note = "Equipment lands in November, agreed with the owner.";
    getApplication.mockResolvedValue(app({ hubspotDealId: "deal-9", quoteNote: note }));
    const updated = await save(undefined, 90);
    expect(updated.quoteNote).toBe(note);
  });
});

// ── Draft quotes + admin override approval (2026-11-02) ─────────────────────
// Every save recomputes the overrides off what it is about to persist.
describe("saveQuoteConfigurationAction — override approval", () => {
  // A 2-unit POS quote with a unit cap of 1 — an override, not a blocker.
  const save = () => saveQuoteConfigurationAction({
    applicationId: "app-1",
    picks: [{ hubspotProductId: "217445755632", qty: 2 }],
    channels: [],
    adjustments: PLAN_START,
    pricingModel: "2-tier",
  });
  const saved = () => saveApplication.mock.calls[0][1] as MerchantApplication;
  const capped = async () => {
    const { getQuoteLimits } = await import("@/lib/actions/pricing");
    // Twice: once to derive the lines, once to judge the saved ones.
    const limits = { unitCaps: { "217445755632": 1 }, discountCaps: {}, maxBillingDelayDays: 90, showTablets: false };
    vi.mocked(getQuoteLimits).mockResolvedValueOnce(limits).mockResolvedValueOnce(limits);
  };

  it("puts a rep's edit to a LIVE quote into pending_approval and emails the admins", async () => {
    await capped();
    const updated = await save();
    expect(updated.quoteStatus).toBe("pending_approval");
    expect(updated.quoteApproval).toMatchObject({
      requestedByUserId: "rep-1",
      overrides: [expect.objectContaining({ kind: "unit_cap", value: 2, limit: 1 })],
    });
    expect(updated.quoteApproval!.fingerprint).toBe(
      overrideFingerprint(saved().quoteLines ?? [], saved().quoteRates ?? null, saved().quoteApproval!.overrides)
    );
    expect(sendQuoteApprovalRequestEmail).toHaveBeenCalledTimes(1);
    expect(sendQuoteApprovalRequestEmail.mock.calls[0][0].url)
      .toBe("http://localhost:3000/admin?view=accounts&account=app-1");
  });

  it("keeps an approval given for exactly this quote — no new request, no email", async () => {
    await capped();
    const first = await save();
    const approved = { ...first, quoteStatus: null, quoteApproval: { ...first.quoteApproval!, approvedAt: "2026-11-01T00:00:00.000Z", approvedByUserId: "admin-1" } };
    vi.clearAllMocks();
    getRateMatrix.mockResolvedValue(FLAT_RATE_CARD);
    getApplication.mockResolvedValue(approved);
    await capped();
    const again = await save();
    expect(again.quoteStatus).toBeNull();
    expect(again.quoteApproval).toEqual(approved.quoteApproval);
    expect(sendQuoteApprovalRequestEmail).not.toHaveBeenCalled();
  });

  it("does not re-email for a quote already waiting on the same approval", async () => {
    await capped();
    const first = await save();
    vi.clearAllMocks();
    getRateMatrix.mockResolvedValue(FLAT_RATE_CARD);
    getApplication.mockResolvedValue(first);
    await capped();
    expect((await save()).quoteStatus).toBe("pending_approval");
    expect(sendQuoteApprovalRequestEmail).not.toHaveBeenCalled();
  });

  it("self-approves an admin's overrides: live with a sent link", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });
    await capped();
    const updated = await save();
    expect(updated.quoteStatus).toBeNull();
    expect(updated.quoteApproval).toMatchObject({ requestedByUserId: "admin-1", approvedByUserId: "admin-1" });
    expect(sendQuoteApprovalRequestEmail).not.toHaveBeenCalled();
  });

  it("self-approves an admin's overrides on a draft as approved", async () => {
    getEffectiveRole.mockResolvedValue({ userId: "admin-1", role: "admin" });
    getApplication.mockResolvedValue(app({ quoteStatus: "draft", customerLinkToken: null }));
    await capped();
    expect((await save()).quoteStatus).toBe("approved");
  });

  it("with no overrides, clears the approval: pending goes live with a link, back to draft without", async () => {
    const pending = { quoteStatus: "pending_approval" as const, quoteApproval: { overrides: [], fingerprint: "x", requestedAt: "t", requestedByUserId: "rep-1" } };
    getApplication.mockResolvedValue(app(pending));
    expect(await save()).toMatchObject({ quoteStatus: null, quoteApproval: null });
    getApplication.mockResolvedValue(app({ ...pending, customerLinkToken: null }));
    expect(await save()).toMatchObject({ quoteStatus: "draft", quoteApproval: null });
    getApplication.mockResolvedValue(app({ quoteStatus: "draft", customerLinkToken: null }));
    expect((await save()).quoteStatus).toBe("draft");
    expect(sendQuoteApprovalRequestEmail).not.toHaveBeenCalled();
  });

  it("writes no billing note to HubSpot for a quote that has never gone out", async () => {
    getApplication.mockResolvedValue(app({ quoteStatus: "draft", customerLinkToken: null, hubspotDealId: "deal-9" }));
    await saveQuoteConfigurationAction({
      applicationId: "app-1",
      picks: [{ hubspotProductId: "217445755632", qty: 1 }],
      channels: [],
      adjustments: PLAN_START,
      quoteNote: "A note waiting for the send.",
      pricingModel: "2-tier",
    });
    expect(setDealBillingNotes).not.toHaveBeenCalled();
  });

  it("keeps its existing refusals", async () => {
    getApplication.mockResolvedValue(app({ detailsConfirmedAt: "2026-09-01T00:00:00.000Z" }));
    await expect(save()).rejects.toThrow(/confirmed their details/);
    expect(saveApplication).not.toHaveBeenCalled();
  });
});
