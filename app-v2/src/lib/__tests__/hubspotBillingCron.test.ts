import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HubspotIds, HubspotSubscriptionSnapshot } from "@/types/merchant";

// /api/cron/hubspot-billing-sync, exercised as a route handler. The drizzle
// client is a hand-rolled chainable stub in the leadAccept.test.ts style; the
// real `sql`/`eq`/`inArray` builders still run over the real schema columns,
// so a rename of hubspot_ids would break the build rather than pass silently.

const listQuotesModifiedSince = vi.fn();
const findSubscriptionsForQuote = vi.fn();

type Row = { id: string; hubspotIds: HubspotIds | null };

let selectRows: Row[] = [];
const updates: Array<Record<string, unknown>> = [];
let updateThrows = false;

const db = {
  select: () => ({ from: () => ({ where: async () => selectRows }) }),
  update: () => ({
    set: (patch: Record<string, unknown>) => ({
      where: async () => {
        if (updateThrows) throw new Error("db down");
        updates.push(patch);
      },
    }),
  }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/adapters/hubspot", () => ({ listQuotesModifiedSince, findSubscriptionsForQuote }));

const { GET } = await import("@/app/api/cron/hubspot-billing-sync/route");

const SECRET = "cron-secret";

const HUBSPOT_IDS: HubspotIds = {
  quoteId: "q-1",
  quoteTemplateId: "tpl-1",
  lineItemIds: ["li-1"],
  contactId: "c-1",
  quoteLink: "https://customers.aioapp.com/abcdef123",
  publishedAt: "2026-08-10T00:00:00.000Z",
  paymentStatus: "PENDING",
  paymentDate: null,
  subscriptions: null,
  subscriptionStatus: null,
  syncedAt: "2026-08-14T00:00:00.000Z",
  lastSyncError: null,
  lastSyncErrorAt: null,
};

const quote = (overrides: Partial<{ quoteId: string; status: string | null; quoteLink: string | null; paymentStatus: string | null; paymentDate: string | null }> = {}) => ({
  quoteId: "q-1",
  status: "ACCEPTED",
  quoteLink: "https://customers.aioapp.com/abcdef123",
  paymentStatus: "PENDING",
  paymentDate: null,
  ...overrides,
});

const sub = (overrides: Partial<HubspotSubscriptionSnapshot> = {}): HubspotSubscriptionSnapshot => ({
  subscriptionId: "sub-1",
  status: "active",
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

const get = (authorization: string | null = `Bearer ${SECRET}`) =>
  GET({ headers: { get: () => authorization } } as never);

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  listQuotesModifiedSince.mockReset();
  findSubscriptionsForQuote.mockReset();
  updates.length = 0;
  selectRows = [];
  updateThrows = false;
  process.env.CRON_SECRET = SECRET;
  listQuotesModifiedSince.mockResolvedValue([]);
  findSubscriptionsForQuote.mockResolvedValue([]);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  process.env.CRON_SECRET = SECRET;
});

describe("the billing cron's auth", () => {
  it("401s when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await get();
    expect(res.status).toBe(401);
    expect(listQuotesModifiedSince).not.toHaveBeenCalled();
  });

  it("401s on a wrong bearer token", async () => {
    const res = await get("Bearer nope");
    expect(res.status).toBe(401);
    expect(listQuotesModifiedSince).not.toHaveBeenCalled();
  });

  it("401s when the header is missing entirely", async () => {
    expect((await get(null)).status).toBe(401);
  });
});

describe("the billing cron's window", () => {
  it("looks back TEN days, because ACH settlement takes ~6", async () => {
    await get();
    const since = Date.parse(listQuotesModifiedSince.mock.calls[0][0]);
    const days = (Date.now() - since) / 86_400_000;
    // A 3-day window would permanently miss the PAID flip, which lands a median
    // 5.7 days after anything else touched the quote.
    expect(days).toBeGreaterThan(9.9);
    expect(days).toBeLessThan(10.1);
  });

  it("returns an empty summary without touching the DB when nothing changed", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      quotesChecked: 0, applicationsUpdated: 0, subscriptionsMatched: 0, unmatched: [], failed: [],
    });
    expect(updates).toHaveLength(0);
  });

  it("500s when the quote search itself fails", async () => {
    listQuotesModifiedSince.mockRejectedValue(new Error("HubSpot quote search failed (429)"));
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("429");
  });
});

describe("the billing cron's join back to applications", () => {
  it("updates the matched application and reports the rest as unmatched", async () => {
    listQuotesModifiedSince.mockResolvedValue([
      quote({ quoteId: "q-1", paymentStatus: "PAID", paymentDate: "2026-08-20T12:22:00Z" }),
      quote({ quoteId: "q-other" }),
    ]);
    selectRows = [{ id: "app-1", hubspotIds: HUBSPOT_IDS }];
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      quotesChecked: 2, applicationsUpdated: 1, subscriptionsMatched: 1, unmatched: ["q-other"], failed: [],
    });

    const written = updates[0].hubspotIds as HubspotIds;
    expect(written.paymentStatus).toBe("PAID");
    expect(written.paymentDate).toBe("2026-08-20T12:22:00Z");
    expect(written.subscriptionStatus).toBe("active");
    expect(written.syncedAt).not.toBe(HUBSPOT_IDS.syncedAt);
    // Ids the rep's build action owns are carried through, never rewritten.
    expect(written.quoteId).toBe("q-1");
    expect(written.lineItemIds).toEqual(["li-1"]);
    expect(written.publishedAt).toBe(HUBSPOT_IDS.publishedAt);
  });

  it("rolls the subscriptions up worst-of", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{ id: "app-1", hubspotIds: HUBSPOT_IDS }];
    findSubscriptionsForQuote.mockResolvedValue([sub(), sub({ subscriptionId: "sub-2", status: "canceled" })]);

    const res = await get();
    expect((await res.json()).subscriptionsMatched).toBe(2);
    expect((updates[0].hubspotIds as HubspotIds).subscriptionStatus).toBe("canceled");
  });

  it("never erases a stored link on an empty read", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote({ quoteLink: null, paymentStatus: "PAID" })]);
    selectRows = [{ id: "app-1", hubspotIds: HUBSPOT_IDS }];

    await get();
    expect((updates[0].hubspotIds as HubspotIds).quoteLink).toBe(HUBSPOT_IDS.quoteLink);
  });

  it("skips a row whose blob has no quoteId at all", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{ id: "app-1", hubspotIds: { ...HUBSPOT_IDS, quoteId: null } }];

    const res = await get();
    const body = await res.json();
    expect(body.applicationsUpdated).toBe(0);
    expect(body.unmatched).toEqual(["q-1"]);
    expect(findSubscriptionsForQuote).not.toHaveBeenCalled();
  });
});

describe("the billing cron writes only what changed", () => {
  it("leaves an unchanged row completely alone", async () => {
    // Same paymentStatus, same (empty) subscription list already cached.
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{
      id: "app-1",
      hubspotIds: { ...HUBSPOT_IDS, subscriptions: [], subscriptionStatus: null },
    }];

    const res = await get();
    const body = await res.json();
    expect(body.applicationsUpdated).toBe(0);
    // Not even a syncedAt bump: nothing here depends on it advancing, and a
    // nightly no-op write would churn updatedAt across the whole table.
    expect(updates).toHaveLength(0);
  });

  it("writes when the cached subscription's own fields moved", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{
      id: "app-1",
      hubspotIds: { ...HUBSPOT_IDS, subscriptions: [sub({ completedPayments: 3 })], subscriptionStatus: "active" },
    }];
    findSubscriptionsForQuote.mockResolvedValue([sub({ completedPayments: 4 })]);

    expect((await (await get()).json()).applicationsUpdated).toBe(1);
  });

  it("writes when a first look finds no subscriptions, so null becomes []", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{ id: "app-1", hubspotIds: HUBSPOT_IDS }];

    expect((await (await get()).json()).applicationsUpdated).toBe(1);
    expect((updates[0].hubspotIds as HubspotIds).subscriptions).toEqual([]);
  });
});

describe("the billing cron on a partial failure", () => {
  it("non-2xxs, names the application, and persists its error", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote({ quoteId: "q-1" }), quote({ quoteId: "q-2" })]);
    selectRows = [
      { id: "app-1", hubspotIds: HUBSPOT_IDS },
      { id: "app-2", hubspotIds: { ...HUBSPOT_IDS, quoteId: "q-2" } },
    ];
    findSubscriptionsForQuote.mockImplementation(async (quoteId: string) => {
      if (quoteId === "q-1") throw new Error("subscription batch read failed (403)");
      return [sub()];
    });

    const res = await get();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.failed).toEqual([{ applicationId: "app-1", error: "subscription batch read failed (403)" }]);
    // The healthy row still synced — one broken account doesn't stop the sweep.
    expect(body.applicationsUpdated).toBe(1);

    const errorWrite = updates.find(u => (u.hubspotIds as HubspotIds).lastSyncError !== null)!;
    expect((errorWrite.hubspotIds as HubspotIds).lastSyncError).toContain("403");
    expect((errorWrite.hubspotIds as HubspotIds).lastSyncErrorAt).toBeTruthy();
  });

  it("still reports the failure when the error write also fails", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{ id: "app-1", hubspotIds: HUBSPOT_IDS }];
    findSubscriptionsForQuote.mockRejectedValue(new Error("403"));
    updateThrows = true;

    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).failed).toHaveLength(1);
  });
});
