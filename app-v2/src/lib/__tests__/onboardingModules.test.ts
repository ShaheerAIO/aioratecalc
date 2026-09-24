import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getOnboardingModules } from "@/lib/onboardingModules";
import type { HubspotIds, HubspotSubscriptionSnapshot, MerchantApplication } from "@/types/merchant";

// Minimal, fully-populated application fixture. Every module under test reads
// only the fields it needs; the rest exist so the type checks and so the
// network-free lock-in test below exercises a "real" shape, not an empty one.
const BASE_APP: MerchantApplication = {
  id: "app-1",
  ownerUserId: "rep-1",
  customerUserId: "cust-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  stage: "merchant_filling",
  hubspotDealId: "deal-1",
  dealLink: null,
  tenantLink: null,
  adyenIds: null,
  adyenOnboardingUrl: null,
  aioTenant: null,
  checkIds: null,
  foodbuyIds: null,
  hubspotIds: null,
  quoteType: "full_pos",
  quoteConfig: null,
  quoteLines: null,
  orderPoints: null,
  quoteAcceptedAt: null,
  targetMargin: null,
  pricingModel: null,
  customerLinkToken: null,
  customerLinkPurpose: null,
  customerLinkSentAt: null,
  customerLinkExpiresAt: null,
  analysis: null,
  proposal: null,
  business: {
    legalName: "Test Co LLC", dba: "Test Co", bizType: "llc", address: "1 Main St",
    city: "Testville", state: "CA", zip: "90000", phone: "555-0100", website: "",
    yearsInBusiness: "5", annualRevenue: "500000",
  },
  ownerContact: {
    firstName: "Jane", lastName: "Doe", title: "Owner", email: "jane@testco.com", phone: "555-0101",
  },
  processing: null,
  agreement: null,
};

const EMPTY_HUBSPOT_IDS: HubspotIds = {
  quoteId: null,
  quoteTemplateId: null,
  lineItemIds: null,
  contactId: null,
  quoteLink: null,
  publishedAt: null,
  paymentStatus: null,
  paymentDate: null,
  subscriptions: null,
  subscriptionStatus: null,
  syncedAt: null,
  lastSyncError: null,
  lastSyncErrorAt: null,
};

const sub = (overrides: Partial<HubspotSubscriptionSnapshot>): HubspotSubscriptionSnapshot => ({
  subscriptionId: "sub-1",
  status: "active",
  paymentMethod: "ACH - 1117",
  billingFrequency: "weekly",
  billingStartDate: null,
  mrr: 51.53,
  nextPaymentDueDate: null,
  lastPaymentStatus: null,
  completedPayments: null,
  totalCollected: null,
  ...overrides,
});

const appWith = (hubspotIds: HubspotIds | null): MerchantApplication => ({ ...BASE_APP, hubspotIds });

const billing = (app: MerchantApplication) => getOnboardingModules(app).find(m => m.key === "billing")!;

describe("billingModule — PAYMENT-TEST-PLAN.md §1.5 status matrix", () => {
  it("is not_started when hubspotIds is null", () => {
    const m = billing(appWith(null));
    expect(m.status).toBe("not_started");
    expect(m.href).toBeUndefined();
    expect(m.description).toMatch(/quote is being prepared/i);
  });

  it("is not_started when hubspotIds exists but quoteId is null", () => {
    const m = billing(appWith({ ...EMPTY_HUBSPOT_IDS, quoteId: null }));
    expect(m.status).toBe("not_started");
    expect(m.href).toBeUndefined();
    expect(m.description).toMatch(/quote is being prepared/i);
  });

  it("is not_started (same copy) when the quote is a draft — quoteId set, publishedAt null", () => {
    const m = billing(appWith({ ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: null }));
    expect(m.status).toBe("not_started");
    expect(m.href).toBeUndefined();
    // A draft quote's link must never be surfaced.
    expect(m.description).toMatch(/quote is being prepared/i);
  });

  it.each([null, "PENDING", "PROCESSING"] as const)(
    "is in_progress with a Finish Signing CTA when published, no subscriptions, paymentStatus=%s",
    (paymentStatus) => {
      const m = billing(appWith({
        ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
        paymentStatus, subscriptions: null,
      }));
      expect(m.status).toBe("in_progress");
      expect(m.href).toBe("/customer/applications/app-1/billing");
      expect(m.ctaLabel).toBe("Finish Signing");
      expect(m.description).toMatch(/finish signing your quote/i);
    }
  );

  it("is complete when a subscription has a payment method and none are active", () => {
    const m = billing(appWith({
      ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
      subscriptions: [sub({ status: "scheduled", paymentMethod: "ACH - 1117" })],
      subscriptionStatus: "scheduled",
    }));
    expect(m.status).toBe("complete");
    expect(m.href).toBeUndefined();
    expect(m.description).toMatch(/billing is set up/i);
  });

  it("includes the first charge date in the copy when billingStartDate is available", () => {
    const m = billing(appWith({
      ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
      subscriptions: [sub({ status: "scheduled", paymentMethod: "ACH - 1117", billingStartDate: "2026-10-11" })],
      subscriptionStatus: "scheduled",
    }));
    expect(m.status).toBe("complete");
    expect(m.description).toContain("2026-10-11");
  });

  it("is complete ('Billing is active.') when subscriptionStatus is active", () => {
    const m = billing(appWith({
      ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
      subscriptions: [sub({ status: "active", paymentMethod: "ACH - 1117" })],
      subscriptionStatus: "active",
    }));
    expect(m.status).toBe("complete");
    expect(m.href).toBeUndefined();
    expect(m.description).toBe("Billing is active.");
  });

  it("is complete for a one-time-charge-only quote — paymentStatus PAID, zero subscriptions", () => {
    const m = billing(appWith({
      ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
      paymentStatus: "PAID", subscriptions: null,
    }));
    expect(m.status).toBe("complete");
    expect(m.href).toBeUndefined();
  });

  it("is in_progress and logs an error on PAYMENT_NOT_ENABLED — a build defect, not a customer state", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = billing(appWith({
      ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
      paymentStatus: "PAYMENT_NOT_ENABLED", subscriptions: null,
    }));
    expect(m.status).toBe("in_progress");
    expect(m.href).toBeUndefined();
    expect(m.description).toMatch(/no action needed/i);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  // Common — 35 of 91 live subscriptions per PAYMENT-TEST-PLAN.md §1.6. These
  // must render explicitly and must never read as complete: a canceled or
  // unpaid subscription can still carry a leftover non-null paymentMethod
  // from when it was first authorized, so the "has payment method" complete
  // branch has to be checked AFTER these, not before.
  it.each(["canceled", "unpaid", "past_due", "paused", "expired"] as const)(
    "renders subscriptionStatus=%s explicitly, never as complete",
    (subscriptionStatus) => {
      const m = billing(appWith({
        ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
        subscriptions: [sub({ status: subscriptionStatus, paymentMethod: "ACH - 1117" })],
        subscriptionStatus,
      }));
      expect(m.status).not.toBe("complete");
      expect(m.status).toBe("in_progress");
      expect(m.href).toBeUndefined();
      expect(m.description.length).toBeGreaterThan(0);
    }
  );

  it("falls back to a defensive in_progress default on an unrecognised paymentStatus, never crashing", () => {
    const m = billing(appWith({
      ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
      // paymentStatus is typed as a plain string, not a literal union, so an
      // unrecognised value (e.g. a future HubSpot enum addition) isn't a type
      // error — it's exactly the runtime case this test exists to cover.
      paymentStatus: "SOMETHING_NEW", subscriptions: null,
    }));
    expect(m.status).toBe("in_progress");
    expect(m.href).toBeUndefined();
  });

  it("falls back to a defensive in_progress default on an unrecognised subscription status, never crashing", () => {
    const m = billing(appWith({
      ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
      subscriptions: [sub({ status: "some_future_status", paymentMethod: null })],
      subscriptionStatus: "some_future_status",
    }));
    expect(m.status).toBe("in_progress");
    expect(() => billing(appWith({
      ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
      subscriptions: [sub({ status: "some_future_status", paymentMethod: null })],
      subscriptionStatus: "some_future_status",
    }))).not.toThrow();
  });
});

describe("billingModule — rate-only quote (empty quoteLines) discriminator", () => {
  const findBilling = (app: MerchantApplication) => getOnboardingModules(app).find(m => m.key === "billing");

  it("keeps the not_started 'being prepared' row when quoteLines is empty but the quote isn't accepted yet — the rep just hasn't configured it", () => {
    const app: MerchantApplication = { ...BASE_APP, quoteAcceptedAt: null, quoteLines: null, hubspotIds: null };
    const m = findBilling(app);
    expect(m).toBeDefined();
    expect(m!.status).toBe("not_started");
    expect(m!.description).toMatch(/quote is being prepared/i);
  });

  it("omits the billing module entirely once the quote is accepted with no billable lines — a rate-only deal", () => {
    // Processing-rate-only quotes never get a HubSpot quote built (AIO's
    // margin there comes from Adyen settlement, not HubSpot billing), so
    // hubspotIds.quoteId stays null forever. There's nothing pending and
    // nothing ever will be, so the row must disappear rather than show a
    // permanently-stuck "being prepared" status.
    const app: MerchantApplication = {
      ...BASE_APP, quoteAcceptedAt: "2026-08-01T00:00:00.000Z", quoteLines: [], hubspotIds: null,
    };
    const modules = getOnboardingModules(app);
    expect(modules.find(m => m.key === "billing")).toBeUndefined();
    // The other modules are unaffected — this isn't a global failure, just an
    // omission of one row.
    expect(modules.map(m => m.key)).toEqual(["quote", "adyen", "payroll", "foodbuy"]);
  });

  it("also omits it when quoteLines is null (not just an empty array) on an accepted rate-only quote", () => {
    const app: MerchantApplication = {
      ...BASE_APP, quoteAcceptedAt: "2026-08-01T00:00:00.000Z", quoteLines: null, hubspotIds: null,
    };
    expect(findBilling(app)).toBeUndefined();
  });

  it("does NOT omit the module when the accepted quote has billable lines — normal not_started path applies", () => {
    const app: MerchantApplication = {
      ...BASE_APP,
      quoteAcceptedAt: "2026-08-01T00:00:00.000Z",
      quoteLines: [{ hubspotProductId: "217526517443", name: "AIO Platform (1 to 5 Order Points)", qty: 1, unitPrice: 99, billingFrequency: "weekly", productType: "Software" }],
      hubspotIds: null,
    };
    const m = findBilling(app);
    expect(m).toBeDefined();
    expect(m!.status).toBe("not_started");
  });

  it("does NOT omit the module when a HubSpot quote already exists, even with empty quoteLines — defensive, not the expected shape", () => {
    const app: MerchantApplication = {
      ...BASE_APP,
      quoteAcceptedAt: "2026-08-01T00:00:00.000Z",
      quoteLines: [],
      hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "q1" },
    };
    const m = findBilling(app);
    expect(m).toBeDefined();
  });
});

describe("getOnboardingModules — order and composition", () => {
  it("returns quote, billing, adyen, payroll, foodbuy in that order", () => {
    const keys = getOnboardingModules(BASE_APP).map(m => m.key);
    expect(keys).toEqual(["quote", "billing", "adyen", "payroll", "foodbuy"]);
  });
});

describe("getOnboardingModules is pure and network-free", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(() => {
      throw new Error("getOnboardingModules must never call fetch");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("never calls fetch, even over a fully-populated application", () => {
    const fullyPopulated: MerchantApplication = {
      ...BASE_APP,
      adyenOnboardingUrl: "https://onboarding.adyen.com/xyz",
      checkIds: {
        companyId: "check-co-1", environment: "sandbox", startDate: "2026-09-01",
        signer: { name: "Jane Doe", title: "Owner", email: "jane@testco.com" },
        createdAt: "2026-08-01T00:00:00.000Z", onboardStatus: "completed", onboardStatusAt: "2026-08-02T00:00:00.000Z",
      },
      hubspotIds: {
        ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z",
        paymentStatus: "PAID", subscriptions: [sub({ status: "active" })], subscriptionStatus: "active",
      },
    };

    const modules = getOnboardingModules(fullyPopulated);

    expect(modules).toHaveLength(5);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("adyenModule (regression net)", () => {
  const adyen = (app: MerchantApplication) => getOnboardingModules(app).find(m => m.key === "adyen")!;

  it("is complete once Adyen KYC has completed or been approved", () => {
    expect(adyen({ ...BASE_APP, stage: "adyen_kyc_complete" }).status).toBe("complete");
    expect(adyen({ ...BASE_APP, stage: "adyen_approved" }).status).toBe("complete");
  });

  it("is in_progress with a Continue Verification CTA once AIO has provisioned the tenant", () => {
    const m = adyen({
      ...BASE_APP,
      aioTenant: { provisionedAt: "2026-09-23T00:00:00.000Z", locationId: 4690 } as never,
    });
    expect(m.status).toBe("in_progress");
    // The route, never the stored URL — AIO's links are single-use.
    expect(m.href).toBe("/customer/applications/app-1/continue");
    expect(m.ctaLabel).toBe("Continue Verification");
  });

  it("says we're setting up, with no CTA, while provisioning is mid-flight", () => {
    const m = adyen({
      ...BASE_APP,
      aioTenant: { provisionedAt: null, locationId: null, attempts: 1 } as never,
    });
    expect(m.status).toBe("in_progress");
    expect(m.href).toBeUndefined();
    expect(m.description).toMatch(/setting up your account/i);
  });

  it("is OMITTED entirely for a marketing-only quote — they pay us but never need Adyen", () => {
    const modules = getOnboardingModules({ ...BASE_APP, quoteType: "marketing_only" });
    expect(modules.find(m => m.key === "adyen")).toBeUndefined();
  });

  it("still appears for a quote type that carries a processing rate", () => {
    expect(getOnboardingModules({ ...BASE_APP, quoteType: "food_truck" }).find(m => m.key === "adyen")).toBeTruthy();
    // Null means full_pos on pre-quote-type rows.
    expect(getOnboardingModules({ ...BASE_APP, quoteType: null }).find(m => m.key === "adyen")).toBeTruthy();
  });

  it("tells the customer verification waits on billing once their details are saved", () => {
    const m = adyen({
      ...BASE_APP,
      business: BASE_APP.business, ownerContact: BASE_APP.ownerContact,
      processing: {
        monthlyVolume: "10000", avgTicket: "25", cardPresentPct: "80", mcc: "5812",
        businessDescription: "Restaurant", previouslyTerminated: "no", bankruptcy: "no", currentProcessor: "Square",
      },
      agreement: { sigName: "Jane Doe", sigDate: "2026-08-01", termsAccepted: true, electronicConsentAccepted: true, actor: "customer" },
    });
    expect(m.status).toBe("in_progress");
    expect(m.ctaLabel).toBe("Review Details");
    expect(m.description).toMatch(/once your billing is set up/i);
  });

  it("is not_started with a Get Started CTA before any details are saved", () => {
    const m = adyen(BASE_APP);
    expect(m.status).toBe("not_started");
    expect(m.href).toBe("/customer/applications/app-1/edit");
    expect(m.ctaLabel).toBe("Get Started");
  });
});

describe("payrollModule (regression net)", () => {
  const payroll = (app: MerchantApplication) => getOnboardingModules(app).find(m => m.key === "payroll")!;

  it("is not_started without an href when business/ownerContact are missing", () => {
    const m = payroll({ ...BASE_APP, business: null, ownerContact: null });
    expect(m.status).toBe("not_started");
    expect(m.href).toBeUndefined();
  });

  it("is not_started with a Set Up Payroll CTA once business details exist", () => {
    const m = payroll(BASE_APP);
    expect(m.status).toBe("not_started");
    expect(m.href).toBe("/customer/applications/app-1/payroll");
    expect(m.ctaLabel).toBe("Set Up Payroll");
  });

  it("is in_progress with a Continue Payroll Setup CTA once a Check company exists", () => {
    const m = payroll({
      ...BASE_APP,
      checkIds: {
        companyId: "check-co-1", environment: "sandbox", startDate: "2026-09-01",
        signer: { name: "Jane Doe", title: "Owner", email: "jane@testco.com" },
        createdAt: "2026-08-01T00:00:00.000Z", onboardStatus: "needs_attention", onboardStatusAt: "2026-08-02T00:00:00.000Z",
      },
    });
    expect(m.status).toBe("in_progress");
    expect(m.href).toBe("/customer/applications/app-1/payroll/continue");
  });

  it("is complete once Check reports the company onboarding as completed", () => {
    const m = payroll({
      ...BASE_APP,
      checkIds: {
        companyId: "check-co-1", environment: "sandbox", startDate: "2026-09-01",
        signer: { name: "Jane Doe", title: "Owner", email: "jane@testco.com" },
        createdAt: "2026-08-01T00:00:00.000Z", onboardStatus: "completed", onboardStatusAt: "2026-08-02T00:00:00.000Z",
      },
    });
    expect(m.status).toBe("complete");
    expect(m.href).toBeUndefined();
  });
});

describe("foodbuyModule (regression net)", () => {
  const foodbuy = (app: MerchantApplication) => getOnboardingModules(app).find(m => m.key === "foodbuy")!;

  it("is not_started without an href when business/ownerContact are missing", () => {
    const m = foodbuy({ ...BASE_APP, business: null, ownerContact: null });
    expect(m.status).toBe("not_started");
    expect(m.href).toBeUndefined();
  });

  it("is not_started with a Get Started CTA once business details exist", () => {
    const m = foodbuy(BASE_APP);
    expect(m.status).toBe("not_started");
    expect(m.href).toBe("/customer/applications/app-1/foodbuy");
    expect(m.ctaLabel).toBe("Get Started");
  });

  it("is complete with a Download Again CTA once the form has been generated", () => {
    const m = foodbuy({
      ...BASE_APP,
      foodbuyIds: { generatedAt: "2026-08-02T00:00:00.000Z" },
    });
    expect(m.status).toBe("complete");
    expect(m.href).toBe("/customer/applications/app-1/foodbuy");
    expect(m.ctaLabel).toBe("Download Again");
  });
});

describe("quoteModule (regression net)", () => {
  const quote = (app: MerchantApplication, opts?: Parameters<typeof getOnboardingModules>[1]) =>
    getOnboardingModules(app, opts).find(m => m.key === "quote")!;

  it("is not_started with 'your rep is preparing your quote' and no CTA when there's no quote yet", () => {
    const m = quote(BASE_APP, { hasQuote: false });
    expect(m.status).toBe("not_started");
    expect(m.href).toBeUndefined();
    expect(m.description).toMatch(/rep is preparing your quote/i);
  });

  it("is not_started with a Review & Sign CTA once a quote exists", () => {
    const m = quote(BASE_APP, { hasQuote: true });
    expect(m.status).toBe("not_started");
    expect(m.href).toBe("/customer/applications/app-1");
    expect(m.ctaLabel).toBe("Review & Sign");
  });

  it("is complete with the href retained once the quote is accepted", () => {
    const m = quote({ ...BASE_APP, quoteAcceptedAt: "2026-08-10T00:00:00.000Z" }, { hasQuote: true });
    expect(m.status).toBe("complete");
    expect(m.href).toBe("/customer/applications/app-1");
  });
});

describe("the lock rule (post-pass)", () => {
  const keyed = (app: MerchantApplication, opts?: Parameters<typeof getOnboardingModules>[1]) => {
    const byKey: Record<string, ReturnType<typeof getOnboardingModules>[number]> = {};
    for (const m of getOnboardingModules(app, opts)) byKey[m.key] = m;
    return byKey;
  };
  it("quote is never locked — it's the first thing the customer does", () => {
    expect(keyed(BASE_APP).quote.locked).toBeUndefined();
    expect(keyed({ ...BASE_APP, quoteAcceptedAt: "2026-08-10T00:00:00.000Z" }).quote.locked).toBeUndefined();
  });

  it("everything after quote is locked (reason: quote) until the quote is accepted", () => {
    const app = { ...BASE_APP, hubspotIds: EMPTY_HUBSPOT_IDS };
    const modules = keyed(app);
    for (const key of ["billing", "adyen", "payroll", "foodbuy"]) {
      expect(modules[key].locked).toEqual({ reason: "quote", message: "Available after your quote is signed" });
    }
  });

  it("unlocks the rest once the quote is accepted", () => {
    const app = {
      ...BASE_APP, quoteAcceptedAt: "2026-08-10T00:00:00.000Z",
      hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "q1" },
    };
    const modules = keyed(app);
    for (const key of ["billing", "adyen", "payroll", "foodbuy"]) {
      expect(modules[key].locked).toBeUndefined();
    }
  });

  it("gates on quoteAcceptedAt, not on billing completion — a rate-only quote never locks Adyen out", () => {
    // billingModule returns null here (accepted, no billable lines, no HubSpot
    // quote) — see the rate-only discriminator tests above. Adyen must still
    // unlock.
    const app: MerchantApplication = {
      ...BASE_APP, quoteAcceptedAt: "2026-08-10T00:00:00.000Z", quoteLines: [], hubspotIds: null,
    };
    const modules = keyed(app);
    expect(modules.billing).toBeUndefined();
    expect(modules.adyen.locked).toBeUndefined();
  });

  it("never downgrades a complete module to locked", () => {
    // adyen is complete via stage, but the quote was never accepted — without
    // the never-downgrade rule this would otherwise be locked.
    const app: MerchantApplication = { ...BASE_APP, stage: "adyen_kyc_complete", quoteAcceptedAt: null };
    const m = keyed(app).adyen;
    expect(m.status).toBe("complete");
    expect(m.locked).toBeUndefined();
  });
});

describe("basePath interpolation", () => {
  it("uses opts.basePath instead of the default /customer/applications/:id for every module's links", () => {
    const app: MerchantApplication = {
      ...BASE_APP,
      quoteAcceptedAt: "2026-08-10T00:00:00.000Z",
      hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z" },
    };
    const modules = getOnboardingModules(app, { basePath: "/lead/tok123", hasQuote: true });
    const byKey: Record<string, string | undefined> = {};
    for (const m of modules) byKey[m.key] = m.href;

    expect(byKey.quote).toBe("/lead/tok123");
    expect(byKey.billing).toBe("/lead/tok123/billing");
    expect(byKey.adyen).toBe("/lead/tok123/edit");
    expect(byKey.payroll).toBe("/lead/tok123/payroll");
    expect(byKey.foodbuy).toBe("/lead/tok123/foodbuy");
  });

  // The bug this task exists to fix: the token host has no tabs, so the quote
  // needs its own route distinct from basePath — but every OTHER module's
  // href is `${basePath}/...`, so if quoteHref were ever folded back into
  // basePath (as it used to be, passing the quote route itself as basePath),
  // every one of those hrefs would silently nest under the quote route
  // instead — `/lead/{token}/quote/billing`, `/lead/{token}/quote/continue`,
  // none of which are real routes. This test pins basePath and quoteHref to
  // DIFFERENT paths and asserts no module's href ever resolves under
  // quoteHref except the quote module's own.
  it("keeps every non-quote module's href under basePath even when quoteHref points elsewhere", () => {
    const app: MerchantApplication = {
      ...BASE_APP,
      quoteAcceptedAt: "2026-08-10T00:00:00.000Z",
      hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "q1", publishedAt: "2026-08-01T00:00:00.000Z" },
    };
    const basePath = "/lead/tok123";
    const quoteHref = "/lead/tok123/quote";
    const modules = getOnboardingModules(app, { basePath, quoteHref, hasQuote: true });

    for (const m of modules) {
      if (!m.href) continue;
      if (m.key === "quote") {
        expect(m.href).toBe(quoteHref);
      } else {
        expect(m.href.startsWith(quoteHref)).toBe(false);
        expect(m.href === basePath || m.href.startsWith(`${basePath}/`)).toBe(true);
      }
    }
  });
});
