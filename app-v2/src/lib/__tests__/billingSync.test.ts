import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CustomerApplicationPatch } from "@/lib/storage/storageInterface";
import type { HubspotIds, HubspotSubscriptionSnapshot, MerchantApplication } from "@/types/merchant";

// The two on-view refreshes and the combined action the application page calls.
// Same mock set as customerOnboardGate.test.ts — the module graph is shared.
const auth = vi.fn();
const getApplicationForCustomer = vi.fn();
const updateApplicationAsCustomer = vi.fn();
const getQuoteSnapshot = vi.fn();
const findSubscriptionsForQuote = vi.fn();
const getCheckOnboardStatus = vi.fn();

vi.mock("@/lib/auth", () => ({ auth, signIn: vi.fn() }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("@/lib/storage/postgresAdapter", () => ({
  postgresStorage: { getApplicationForCustomer, updateApplicationAsCustomer },
}));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail: vi.fn() }));
vi.mock("@/lib/adapters/check", () => ({
  checkEnvironment: vi.fn(), createCheckCompany: vi.fn(),
  createCheckOnboardLink: vi.fn(), getCheckOnboardStatus,
}));
vi.mock("@/lib/adapters/hubspot", () => ({
  pushToHubSpot: vi.fn(), getQuoteSnapshot, findSubscriptionsForQuote,
}));

const {
  getMyApplicationWithBillingSyncAction,
  getMyApplicationWithSyncAction,
} = await import("@/lib/actions/customer");

const ID = "app-1";
const CUSTOMER_SESSION = { user: { id: "cust-1", role: "customer" } };

const HUBSPOT_IDS: HubspotIds = {
  quoteId: "q-1",
  quoteTemplateId: "tpl-1",
  lineItemIds: ["li-1"],
  contactId: "c-1",
  quoteLink: "https://customers.aioapp.com/abcdef123",
  publishedAt: "2026-08-14T00:00:00.000Z",
  paymentStatus: "PENDING",
  paymentDate: null,
  subscriptions: null,
  subscriptionStatus: null,
  syncedAt: null,
  lastSyncError: null,
  lastSyncErrorAt: null,
};

const sub = (overrides: Partial<HubspotSubscriptionSnapshot> = {}): HubspotSubscriptionSnapshot => ({
  subscriptionId: "sub-1",
  status: "scheduled",
  paymentMethod: "ACH - 1117",
  billingFrequency: "weekly",
  billingStartDate: "2026-09-01",
  mrr: 429,
  nextPaymentDueDate: null,
  lastPaymentStatus: null,
  completedPayments: null,
  totalCollected: null,
  ...overrides,
});

const SNAPSHOT = {
  quoteId: "q-1", status: "ACCEPTED",
  quoteLink: "https://customers.aioapp.com/abcdef123",
  paymentStatus: "PENDING", paymentDate: null,
};

// Models the DB faithfully: updateApplicationAsCustomer SETs only the columns
// in its patch and RETURNINGs the whole row as it then stands, so a later write
// sees an earlier one's column.
let stored: MerchantApplication;
const patches: CustomerApplicationPatch[] = [];

function setStored(overrides: Partial<MerchantApplication>) {
  stored = { id: ID, hubspotIds: null, checkIds: null, ...overrides } as MerchantApplication;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const m of [auth, getApplicationForCustomer, updateApplicationAsCustomer, getQuoteSnapshot, findSubscriptionsForQuote, getCheckOnboardStatus]) {
    m.mockReset();
  }
  patches.length = 0;
  auth.mockResolvedValue(CUSTOMER_SESSION);
  getApplicationForCustomer.mockImplementation(async () => stored);
  updateApplicationAsCustomer.mockImplementation(
    async (_userId: string, _id: string, patch: CustomerApplicationPatch) => {
      patches.push(patch);
      stored = { ...stored, ...patch };
      return stored;
    }
  );
  getQuoteSnapshot.mockResolvedValue(SNAPSHOT);
  findSubscriptionsForQuote.mockResolvedValue([]);
  setStored({ hubspotIds: HUBSPOT_IDS });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

describe("the billing refresh's no-op condition", () => {
  it("does nothing when there is no HubSpot quote", async () => {
    setStored({ hubspotIds: null });
    await getMyApplicationWithBillingSyncAction(ID);
    expect(getQuoteSnapshot).not.toHaveBeenCalled();
  });

  it("does nothing while the quote is still a draft", async () => {
    setStored({ hubspotIds: { ...HUBSPOT_IDS, publishedAt: null } });
    await getMyApplicationWithBillingSyncAction(ID);
    expect(getQuoteSnapshot).not.toHaveBeenCalled();
  });

  it("refreshes a published quote with no subscription cached yet", async () => {
    await getMyApplicationWithBillingSyncAction(ID);
    expect(getQuoteSnapshot).toHaveBeenCalledWith("q-1");
    expect(findSubscriptionsForQuote).toHaveBeenCalledWith("q-1");
  });

  it("still refreshes when every cached subscription is only `scheduled`", async () => {
    // The real completion ordering: `scheduled` becomes `active` days later with
    // nothing on our side to trigger it, so it is not terminal.
    setStored({
      hubspotIds: {
        ...HUBSPOT_IDS, paymentStatus: "PAID",
        subscriptions: [sub({ status: "scheduled" })], subscriptionStatus: "scheduled",
      },
    });
    await getMyApplicationWithBillingSyncAction(ID);
    expect(getQuoteSnapshot).toHaveBeenCalled();
  });

  it("still refreshes an active subscription while the ACH batch hasn't marked the quote PAID", async () => {
    setStored({
      hubspotIds: {
        ...HUBSPOT_IDS, paymentStatus: "PENDING",
        subscriptions: [sub({ status: "active" })], subscriptionStatus: "active",
      },
    });
    await getMyApplicationWithBillingSyncAction(ID);
    expect(getQuoteSnapshot).toHaveBeenCalled();
  });

  it("stops once the quote is PAID and its subscription is active", async () => {
    setStored({
      hubspotIds: {
        ...HUBSPOT_IDS, paymentStatus: "PAID",
        subscriptions: [sub({ status: "active" })], subscriptionStatus: "active",
      },
    });
    await getMyApplicationWithBillingSyncAction(ID);
    expect(getQuoteSnapshot).not.toHaveBeenCalled();
  });
});

describe("the billing refresh's 60-second TTL", () => {
  it("skips a re-read within the TTL", async () => {
    setStored({ hubspotIds: { ...HUBSPOT_IDS, syncedAt: new Date(Date.now() - 5_000).toISOString() } });
    await getMyApplicationWithBillingSyncAction(ID);
    expect(getQuoteSnapshot).not.toHaveBeenCalled();
  });

  it("re-reads once the TTL has elapsed", async () => {
    setStored({ hubspotIds: { ...HUBSPOT_IDS, syncedAt: new Date(Date.now() - 61_000).toISOString() } });
    await getMyApplicationWithBillingSyncAction(ID);
    expect(getQuoteSnapshot).toHaveBeenCalled();
  });

  it("re-reads rather than skipping forever on an unparseable syncedAt", async () => {
    setStored({ hubspotIds: { ...HUBSPOT_IDS, syncedAt: "not a date" } });
    await getMyApplicationWithBillingSyncAction(ID);
    expect(getQuoteSnapshot).toHaveBeenCalled();
  });
});

describe("what the billing refresh writes", () => {
  it("caches the subscriptions, their roll-up, and the payment status", async () => {
    findSubscriptionsForQuote.mockResolvedValue([sub({ status: "active" }), sub({ subscriptionId: "sub-2", status: "paused" })]);
    getQuoteSnapshot.mockResolvedValue({ ...SNAPSHOT, paymentStatus: "PAID", paymentDate: "2026-08-20T12:22:00Z" });

    const app = await getMyApplicationWithBillingSyncAction(ID);
    expect(app?.hubspotIds?.subscriptions).toHaveLength(2);
    // Worst-of, so a paused sibling can't be masked by the active one.
    expect(app?.hubspotIds?.subscriptionStatus).toBe("paused");
    expect(app?.hubspotIds?.paymentStatus).toBe("PAID");
    expect(app?.hubspotIds?.paymentDate).toBe("2026-08-20T12:22:00Z");
    expect(app?.hubspotIds?.syncedAt).toBeTruthy();
  });

  it("writes even when nothing changed, because syncedAt IS the TTL", async () => {
    await getMyApplicationWithBillingSyncAction(ID);
    expect(patches).toHaveLength(1);
  });

  it("never nulls out a working link on an empty read", async () => {
    getQuoteSnapshot.mockResolvedValue({ ...SNAPSHOT, quoteLink: null });
    const app = await getMyApplicationWithBillingSyncAction(ID);
    expect(app?.hubspotIds?.quoteLink).toBe(HUBSPOT_IDS.quoteLink);
  });

  it("clears a previous failure on success", async () => {
    setStored({ hubspotIds: { ...HUBSPOT_IDS, lastSyncError: "401", lastSyncErrorAt: "2026-08-01T00:00:00.000Z" } });
    const app = await getMyApplicationWithBillingSyncAction(ID);
    expect(app?.hubspotIds?.lastSyncError).toBeNull();
    expect(app?.hubspotIds?.lastSyncErrorAt).toBeNull();
  });

  it("leaves the application intact and records the failure when HubSpot throws", async () => {
    getQuoteSnapshot.mockRejectedValue(new Error("HubSpot quote q-1 read failed (429)"));
    const app = await getMyApplicationWithBillingSyncAction(ID);
    expect(app).not.toBeNull();
    // Everything the page renders from is untouched...
    expect(app?.hubspotIds?.quoteId).toBe("q-1");
    expect(app?.hubspotIds?.quoteLink).toBe(HUBSPOT_IDS.quoteLink);
    expect(app?.hubspotIds?.publishedAt).toBe(HUBSPOT_IDS.publishedAt);
    expect(app?.hubspotIds?.subscriptions).toBeNull();
    // ...but the failure is visible rather than living only in a log line.
    expect(app?.hubspotIds?.lastSyncError).toContain("429");
    // Not a successful sync, so the TTL must not be armed by a failure.
    expect(app?.hubspotIds?.syncedAt).toBeNull();
  });

  it("returns the application even when the error write also fails", async () => {
    getQuoteSnapshot.mockRejectedValue(new Error("boom"));
    updateApplicationAsCustomer.mockRejectedValue(new Error("db down"));
    const app = await getMyApplicationWithBillingSyncAction(ID);
    expect(app?.hubspotIds?.quoteId).toBe("q-1");
  });

  it("returns null for an id that isn't the customer's", async () => {
    getApplicationForCustomer.mockResolvedValue(null);
    expect(await getMyApplicationWithSyncAction(ID)).toBeNull();
    expect(getQuoteSnapshot).not.toHaveBeenCalled();
    expect(getCheckOnboardStatus).not.toHaveBeenCalled();
  });
});

describe("the combined on-view refresh", () => {
  const CHECK_IDS = {
    companyId: "co-1", environment: "sandbox" as const, startDate: "2026-09-01",
    signer: { name: "Jane Doe", title: "Owner", email: "jane@testco.com" },
    createdAt: "2026-08-01T00:00:00.000Z", onboardStatus: "needs_attention" as const, onboardStatusAt: null,
  };

  beforeEach(() => {
    setStored({ hubspotIds: HUBSPOT_IDS, checkIds: CHECK_IDS });
    getCheckOnboardStatus.mockResolvedValue("completed");
    findSubscriptionsForQuote.mockResolvedValue([sub({ status: "active" })]);
  });

  it("loads the row ONCE and threads it through both refreshes", async () => {
    const app = await getMyApplicationWithSyncAction(ID);
    // One load: the second refresh must build its patch from the row the first
    // one returned, not from a second independent read of the same id.
    expect(getApplicationForCustomer).toHaveBeenCalledTimes(1);
    // Both writes survive on the returned row — neither clobbered the other.
    expect(app?.checkIds?.onboardStatus).toBe("completed");
    expect(app?.hubspotIds?.subscriptionStatus).toBe("active");
    expect(patches.map(p => Object.keys(p)[0])).toEqual(["checkIds", "hubspotIds"]);
  });

  it("does not clobber a field the first write's RETURNING revealed", async () => {
    // THE two-sequential-writes hazard. The billing refresh builds its patch by
    // spreading the hubspotIds it was HANDED, so it must be handed the row the
    // payroll write returned — not the row loaded before it. Here a concurrent
    // writer (the rep publishing the quote) changes hubspotIds between the load
    // and the payroll write, so the payroll write's RETURNING is the only place
    // the new value appears. A billing patch built from the stale load would
    // silently revert publishedAt to null and un-publish the quote.
    updateApplicationAsCustomer.mockImplementationOnce(
      async (_userId: string, _id: string, patch: CustomerApplicationPatch) => {
        patches.push(patch);
        stored = {
          ...stored,
          ...patch,
          hubspotIds: { ...HUBSPOT_IDS, publishedAt: "2026-08-21T00:00:00.000Z", quoteTemplateId: "tpl-2" },
        };
        return stored;
      }
    );

    const app = await getMyApplicationWithSyncAction(ID);
    expect(app?.hubspotIds?.publishedAt).toBe("2026-08-21T00:00:00.000Z");
    expect(app?.hubspotIds?.quoteTemplateId).toBe("tpl-2");
    expect(app?.hubspotIds?.subscriptionStatus).toBe("active");
    expect(app?.checkIds?.onboardStatus).toBe("completed");
  });

  it("keeps refreshing billing when Check is down", async () => {
    getCheckOnboardStatus.mockRejectedValue(new Error("Check 503"));
    const app = await getMyApplicationWithSyncAction(ID);
    expect(app?.hubspotIds?.subscriptionStatus).toBe("active");
    expect(app?.checkIds?.onboardStatus).toBe("needs_attention");
  });

  it("keeps refreshing Check when HubSpot is down", async () => {
    getQuoteSnapshot.mockRejectedValue(new Error("HubSpot 503"));
    const app = await getMyApplicationWithSyncAction(ID);
    expect(app?.checkIds?.onboardStatus).toBe("completed");
    expect(app?.hubspotIds?.subscriptions).toBeNull();
    expect(app?.hubspotIds?.lastSyncError).toContain("503");
  });

  it("survives both partners being down", async () => {
    getCheckOnboardStatus.mockRejectedValue(new Error("Check 503"));
    getQuoteSnapshot.mockRejectedValue(new Error("HubSpot 503"));
    const app = await getMyApplicationWithSyncAction(ID);
    expect(app?.id).toBe(ID);
  });
});
