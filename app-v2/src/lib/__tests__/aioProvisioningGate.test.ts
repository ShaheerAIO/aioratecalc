import { describe, it, expect } from "vitest";
import type { MerchantApplication, HubspotSubscriptionSnapshot } from "@/types/merchant";
import { isReadyForAioProvisioning, backoffMs, CLAIM_STALE_MS } from "@/lib/aio/provisioningGate";
import { hasBillingCompleted, getOnboardingModules } from "@/lib/onboardingModules";

// Provisioning creates objects that CANNOT be deleted on AIO's side, so this
// gate is the thing standing between a merchant and permanent debris with
// their name on it. Each skip reason below is a real way that could happen.

const NOW = new Date("2026-09-23T12:00:00.000Z");

function sub(extra: Partial<HubspotSubscriptionSnapshot> = {}): HubspotSubscriptionSnapshot {
  return {
    subscriptionId: "sub-1",
    status: "active",
    paymentMethod: "ACH",
    billingFrequency: "weekly",
    billingStartDate: "2026-09-25",
    mrr: 429,
    nextPaymentDueDate: null,
    lastPaymentStatus: null,
    completedPayments: 0,
    totalCollected: 0,
  } as HubspotSubscriptionSnapshot;
}

function app(extra: Partial<MerchantApplication> = {}): MerchantApplication {
  return {
    id: "prospect_1",
    stage: "quote_accepted",
    quoteAcceptedAt: "2026-09-20T00:00:00.000Z",
    quoteType: "full_pos",
    quoteLines: [{ name: "x" }],
    aioTenant: null,
    business: { dba: "Blue Plate", legalName: "Blue Plate LLC", address: "1 St", city: "SJ", state: "CA", zip: "95120", phone: "4155550142" },
    ownerContact: { firstName: "Sam", lastName: "R", title: "Owner", email: "sam@example.com", phone: "4155550143" },
    hubspotIds: { quoteId: "q1", publishedAt: "2026-09-21T00:00:00.000Z", subscriptions: [sub()], subscriptionStatus: "active" },
    ...extra,
  } as unknown as MerchantApplication;
}

describe("isReadyForAioProvisioning", () => {
  it("passes a paid, accepted, processing merchant with full details", () => {
    expect(isReadyForAioProvisioning(app(), NOW)).toEqual({ ready: true });
  });

  it("never re-provisions a row that already succeeded", () => {
    const a = app({ aioTenant: { provisionedAt: "2026-09-22T00:00:00.000Z", attempts: 1 } as never });
    expect(isReadyForAioProvisioning(a, NOW)).toEqual({ ready: false, reason: "already_provisioned" });
  });

  it("holds until the quote is accepted", () => {
    expect(isReadyForAioProvisioning(app({ quoteAcceptedAt: null }), NOW)).toEqual({
      ready: false,
      reason: "quote_not_accepted",
    });
  });

  it("holds until billing is actually paid — this is the trigger", () => {
    const unpaid = app({ hubspotIds: { quoteId: "q1", publishedAt: "x", subscriptions: [], subscriptionStatus: null } as never });
    expect(isReadyForAioProvisioning(unpaid, NOW)).toEqual({ ready: false, reason: "billing_not_paid" });
  });

  it("does not treat a canceled subscription as paid", () => {
    const canceled = app({
      hubspotIds: {
        quoteId: "q1",
        publishedAt: "x",
        subscriptions: [sub({ status: "canceled" })],
        subscriptionStatus: "canceled",
      } as never,
    });
    expect(isReadyForAioProvisioning(canceled, NOW)).toEqual({ ready: false, reason: "billing_not_paid" });
  });

  it("skips a marketing-only merchant — they pay us but sell nothing, so KYC would never complete", () => {
    expect(isReadyForAioProvisioning(app({ quoteType: "marketing_only" }), NOW)).toEqual({
      ready: false,
      reason: "no_processing_quote",
    });
  });

  it("skips a closed-lost deal", () => {
    expect(isReadyForAioProvisioning(app({ stage: "closed_lost" }), NOW)).toEqual({
      ready: false,
      reason: "closed_lost",
    });
  });

  it("refuses to create a tenant with no name — the alias would be burned on an unfixable row", () => {
    const nameless = app({ business: { dba: "", legalName: "  " } as never });
    expect(isReadyForAioProvisioning(nameless, NOW)).toEqual({
      ready: false,
      reason: "missing_business_details",
    });
  });

  it("refuses without an owner contact email", () => {
    const noEmail = app({ ownerContact: { firstName: "Sam", lastName: "R", title: "", email: "", phone: "" } as never });
    expect(isReadyForAioProvisioning(noEmail, NOW)).toEqual({
      ready: false,
      reason: "missing_business_details",
    });
  });

  it("leaves a freshly claimed row to whoever claimed it", () => {
    const claimed = app({
      aioTenant: { provisionedAt: null, attempts: 1, claimedAt: new Date(NOW.getTime() - 60_000).toISOString() } as never,
    });
    expect(isReadyForAioProvisioning(claimed, NOW)).toEqual({ ready: false, reason: "claimed" });
  });

  it("re-takes a stale claim — a dead instance must not wedge the row forever", () => {
    const stale = app({
      aioTenant: {
        provisionedAt: null,
        attempts: 1,
        claimedAt: new Date(NOW.getTime() - CLAIM_STALE_MS - 1000).toISOString(),
        lastAttemptAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString(),
      } as never,
    });
    expect(isReadyForAioProvisioning(stale, NOW)).toEqual({ ready: true });
  });

  it("backs off after a failure instead of hammering an irreversible endpoint", () => {
    const justFailed = app({
      aioTenant: {
        provisionedAt: null,
        attempts: 2,
        claimedAt: null,
        lastAttemptAt: new Date(NOW.getTime() - 60_000).toISOString(),
      } as never,
    });
    expect(isReadyForAioProvisioning(justFailed, NOW)).toEqual({ ready: false, reason: "backing_off" });
  });

  it("gives up after five attempts and leaves it for a human", () => {
    const exhausted = app({
      aioTenant: {
        provisionedAt: null,
        attempts: 5,
        claimedAt: null,
        lastAttemptAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      } as never,
    });
    expect(isReadyForAioProvisioning(exhausted, NOW)).toEqual({ ready: false, reason: "too_many_attempts" });
  });

  it("backs off exponentially, capped at a day", () => {
    expect(backoffMs(1)).toBe(60 * 60 * 1000);
    expect(backoffMs(2)).toBe(2 * 60 * 60 * 1000);
    expect(backoffMs(10)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("hasBillingCompleted agrees with the billing checklist row", () => {
  // The whole reason this predicate was extracted: if it disagreed with what
  // the customer sees, the checklist could say "Billing is set up" while
  // nothing ever provisioned, or vice versa.
  const cases: { name: string; hubspotIds: unknown }[] = [
    { name: "no quote", hubspotIds: null },
    { name: "quote but unpublished", hubspotIds: { quoteId: "q1", publishedAt: null, subscriptions: null, subscriptionStatus: null } },
    { name: "published, no subs", hubspotIds: { quoteId: "q1", publishedAt: "x", subscriptions: [], subscriptionStatus: null } },
    { name: "active", hubspotIds: { quoteId: "q1", publishedAt: "x", subscriptions: [sub()], subscriptionStatus: "active" } },
    { name: "authorized but not yet active", hubspotIds: { quoteId: "q1", publishedAt: "x", subscriptions: [sub({ status: "scheduled" })], subscriptionStatus: "scheduled" } },
    { name: "canceled", hubspotIds: { quoteId: "q1", publishedAt: "x", subscriptions: [sub({ status: "canceled" })], subscriptionStatus: "canceled" } },
    { name: "unpaid", hubspotIds: { quoteId: "q1", publishedAt: "x", subscriptions: [sub({ status: "unpaid" })], subscriptionStatus: "unpaid" } },
    { name: "past_due", hubspotIds: { quoteId: "q1", publishedAt: "x", subscriptions: [sub({ status: "past_due" })], subscriptionStatus: "past_due" } },
    { name: "paused", hubspotIds: { quoteId: "q1", publishedAt: "x", subscriptions: [sub({ status: "paused" })], subscriptionStatus: "paused" } },
    { name: "expired", hubspotIds: { quoteId: "q1", publishedAt: "x", subscriptions: [sub({ status: "expired" })], subscriptionStatus: "expired" } },
  ];

  for (const c of cases) {
    it(`${c.name}`, () => {
      const a = app({ hubspotIds: c.hubspotIds as never });
      const billing = getOnboardingModules(a).find(m => m.key === "billing");
      const moduleSaysComplete = billing?.status === "complete";
      expect(hasBillingCompleted(a.hubspotIds)).toBe(moduleSaysComplete);
    });
  }
});
