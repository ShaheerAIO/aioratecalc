import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_QUOTE_RATES, type HubspotIds, type HubspotSubscriptionSnapshot } from "@/types/merchant";

// /api/cron/hubspot-billing-sync, exercised as a route handler. The drizzle
// client is a hand-rolled chainable stub in the leadAccept.test.ts style; the
// real `sql`/`eq`/`inArray` builders still run over the real schema columns,
// so a rename of hubspot_ids would break the build rather than pass silently.

const listQuotesModifiedSince = vi.fn();
const findSubscriptionsForQuote = vi.fn();
const syncDealFromApplication = vi.fn();
const getDealProcessingArr = vi.fn();
const patchDealProcessingArr = vi.fn();
const sendMagicLinkEmail = vi.fn();

type Row = { id: string; hubspotIds: HubspotIds | null } & Record<string, unknown>;

// The cron now also DETECTS ACCEPTANCE (lib/billing/acceptance.ts), which
// fires on any matched row that has a paying subscription and no
// quoteAcceptedAt. Every pre-existing case here is about the snapshot sync, so
// rows default to already-accepted and stay out of that path; the acceptance
// cases below opt in explicitly with `quoteAcceptedAt: null`.
const ACCEPTED_AT = new Date("2026-08-11T00:00:00.000Z");
const rowDefaults = {
  // rowToApp calls .toISOString() on both of these unconditionally.
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-10T00:00:00.000Z"),
  quoteAcceptedAt: ACCEPTED_AT,
  stage: "quote_accepted",
  hubspotDealId: null,
  ownerContact: null,
  quoteLines: null,
};

let selectRows: Row[] = [];
const updates: Array<Record<string, unknown>> = [];
let updateThrows = false;

const db = {
  select: () => ({ from: () => ({ where: async () => selectRows.map(r => ({ ...rowDefaults, ...r })) }) }),
  update: () => ({
    // `where` has to be BOTH awaitable and chainable: the snapshot writes do
    // `await …set().where()`, while the acceptance write does
    // `…set().where().returning()`. So it returns a promise with `returning`
    // hung off it, and both paths resolve the same single execution.
    set: (patch: Record<string, unknown>) => ({
      where: () => {
        const ran = Promise.resolve().then(() => {
          if (updateThrows) throw new Error("db down");
          updates.push(patch);
        });
        return Object.assign(ran, {
          returning: async () => {
            await ran;
            return [{ ...rowDefaults, ...(selectRows[0] ?? {}), ...patch }];
          },
        });
      },
    }),
  }),
  insert: () => ({ values: async () => undefined }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/adapters/hubspot", () => ({
  listQuotesModifiedSince, findSubscriptionsForQuote, syncDealFromApplication,
  getDealProcessingArr, patchDealProcessingArr,
}));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail }));

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
  esignStatus: null,
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
  esignStatus: null,
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
  syncDealFromApplication.mockReset();
  sendMagicLinkEmail.mockReset();
  syncDealFromApplication.mockResolvedValue("deal-1");
  sendMagicLinkEmail.mockResolvedValue({ sent: true });
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
      quotesChecked: 0, applicationsUpdated: 0, accepted: 0, subscriptionsMatched: 0, unmatched: [], failed: [],
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

describe("the billing cron detects acceptance", () => {
  // The merchant signs and pays on HubSpot's hosted quote and is never sent
  // back to EasyOB. Before they have an account there is no on-view refresh of
  // their own, so this sweep is the thing that notices — and the thing that
  // emails them the link that creates the account.
  const unaccepted = (hubspotIds: HubspotIds = HUBSPOT_IDS) => [{
    id: "app-1",
    hubspotIds,
    quoteAcceptedAt: null,
    stage: "quote_sent",
    hubspotDealId: "deal-9",
    ownerContact: { email: "ana@tortapalace.com" },
    quoteLines: [{ name: "POS Unit", hubspotProductId: "p1", qty: 1, unitPrice: 1200, billingFrequency: "one_time", productType: "inventory" }],
  }];

  it("records the acceptance and emails the account link once a subscription is paying", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = unaccepted();
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    const body = await (await get()).json();
    expect(body.accepted).toBe(1);

    const acceptWrite = updates.find(u => "quoteAcceptedAt" in u)!;
    expect(acceptWrite.quoteAcceptedAt).toBeTruthy();
    expect(acceptWrite.stage).toBe("quote_accepted");
    expect(sendMagicLinkEmail).toHaveBeenCalledWith("ana@tortapalace.com", expect.stringContaining("/api/customer/verify?token="));
    expect(syncDealFromApplication).toHaveBeenCalledTimes(1);
  });

  it("does NOT accept a published quote nobody has paid yet", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = unaccepted();
    findSubscriptionsForQuote.mockResolvedValue([]);

    const body = await (await get()).json();
    expect(body.accepted).toBe(0);
    expect(updates.some(u => "quoteAcceptedAt" in u)).toBe(false);
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  // A canceled subscription can still carry the paymentMethod it was
  // authorized with, so "has a payment method" alone must never read as paid.
  it("does NOT accept on a canceled subscription", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = unaccepted();
    findSubscriptionsForQuote.mockResolvedValue([sub({ status: "canceled" })]);

    expect((await (await get()).json()).accepted).toBe(0);
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it("is a no-op on a row that was already accepted — the email never goes twice", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{ id: "app-1", hubspotIds: HUBSPOT_IDS }]; // defaults to accepted
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    expect((await (await get()).json()).accepted).toBe(0);
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it("records the acceptance even when the snapshot itself didn't move", async () => {
    // An earlier run wrote the subscription but died before recording the
    // acceptance. Nothing in the snapshot changes on this pass, so the write
    // is skipped — the acceptance must still be picked up.
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = unaccepted({ ...HUBSPOT_IDS, subscriptions: [sub()], subscriptionStatus: "active" });
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    const body = await (await get()).json();
    expect(body.applicationsUpdated).toBe(0);
    expect(body.accepted).toBe(1);
  });

  it("still records the acceptance when the deal sync fails, and now PERSISTS that failure", async () => {
    // Before this fix, lib/billing/acceptance.ts's deal-sync catch was a bare
    // console.error — the ONLY chance `payment_processing_arr` ever gets for
    // a row's first acceptance, failing invisibly. recordAcceptance is
    // mocked as a real module here (only hubspot/email/db are mocked), so
    // this exercises the actual fixed catch block, not a stand-in for it.
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = unaccepted();
    findSubscriptionsForQuote.mockResolvedValue([sub()]);
    syncDealFromApplication.mockRejectedValue(new Error("HubSpot 500"));

    expect((await (await get()).json()).accepted).toBe(1);
    expect(sendMagicLinkEmail).toHaveBeenCalledTimes(1);
    const errorWrite = updates.find(u => (u.hubspotIds as HubspotIds | undefined)?.lastSyncError);
    expect(errorWrite).toBeTruthy();
    expect((errorWrite!.hubspotIds as HubspotIds).lastSyncError).toContain("HubSpot 500");
  });
});

describe("the billing cron resyncs an already-accepted deal's ARR", () => {
  // payment_processing_arr (lib/billing/processingArr.ts) is only ever
  // written as part of a deal PATCH, and `recordAcceptance` only ever makes
  // that write ONCE — at the instant quoteAcceptedAt is first set. This is
  // the one place in the codebase a row that was ALREADY accepted coming
  // into a run gets a later chance at it.
  //
  // It MUST use the narrow getDealProcessingArr/patchDealProcessingArr pair,
  // never syncDealFromApplication: that also sends dealname/amount for a row
  // EasyOB created, and turning those into a NIGHTLY write would fight
  // HubSpot's own deal-renaming automation and re-assert a wrong `amount`
  // (12× gross card volume, not revenue) over any correction made during the
  // day. See the comment on this block in the route itself.
  //
  // Rows here all default to accepted (rowDefaults.quoteAcceptedAt) and
  // carry both a deal id and enough of a quote (quoteConfig) for
  // paymentProcessingArr to compute a real number — rowDefaults otherwise
  // leaves hubspotDealId null and has no quote basis at all, so
  // paymentProcessingArr would return null and this whole block a no-op.
  const QUOTE_BASIS = {
    quoteType: "all_in_one",
    pricingModel: "2-tier",
    quoteRates: DEFAULT_QUOTE_RATES,
    quoteConfig: { monthlyVolume: 100000, avgTicket: 30 },
    analysis: null,
  };
  const acceptedRow = (overrides: Record<string, unknown> = {}) => [{
    id: "app-1", hubspotIds: HUBSPOT_IDS, hubspotDealId: "deal-9", ...QUOTE_BASIS, ...overrides,
  }];

  beforeEach(() => {
    getDealProcessingArr.mockReset();
    patchDealProcessingArr.mockReset();
    // The live placeholder every un-backfilled deal carries — always differs
    // from a real computed ARR, so the default is "there's a write to do".
    getDealProcessingArr.mockResolvedValue("2500");
    patchDealProcessingArr.mockResolvedValue(undefined);
  });

  it("writes payment_processing_arr — and only that — for a row that was already accepted", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = acceptedRow();
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    await get();
    expect(getDealProcessingArr).toHaveBeenCalledWith("deal-9");
    expect(patchDealProcessingArr).toHaveBeenCalledTimes(1);
    const [dealId, arr] = patchDealProcessingArr.mock.calls[0];
    expect(dealId).toBe("deal-9");
    expect(typeof arr).toBe("number");
    expect(arr).toBeGreaterThan(0);
  });

  it("never calls syncDealFromApplication for this resync — dealname/amount must not be re-pushed nightly", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = acceptedRow();
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    await get();
    expect(syncDealFromApplication).not.toHaveBeenCalled();
  });

  it("skips the write entirely once HubSpot already carries the computed value", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = acceptedRow();
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    await get(); // first pass: "2500" (the default stub) differs, so it writes once
    const computed = patchDealProcessingArr.mock.calls[0][1];
    patchDealProcessingArr.mockClear();
    getDealProcessingArr.mockResolvedValue(String(computed));

    await get(); // second pass: HubSpot now already matches
    expect(patchDealProcessingArr).not.toHaveBeenCalled();
  });

  it("does not resync a row with no deal id at all", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{ id: "app-1", hubspotIds: HUBSPOT_IDS }]; // hubspotDealId: null (rowDefaults)
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    await get();
    expect(getDealProcessingArr).not.toHaveBeenCalled();
    expect(patchDealProcessingArr).not.toHaveBeenCalled();
  });

  it("does not resync a row with no ARR to state (no quote basis)", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{ id: "app-1", hubspotIds: HUBSPOT_IDS, hubspotDealId: "deal-9" }]; // no QUOTE_BASIS
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    await get();
    expect(getDealProcessingArr).not.toHaveBeenCalled();
    expect(patchDealProcessingArr).not.toHaveBeenCalled();
  });

  it("does not double-sync a row that was accepted for the first time THIS run", async () => {
    // applyDetectedAcceptance's own recordAcceptance already made the one
    // full-property-bag attempt (via syncDealFromApplication) for a
    // freshly-accepted row; this block must not ALSO fire its narrow resync
    // for the same row in the same pass.
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = [{
      id: "app-1",
      hubspotIds: HUBSPOT_IDS,
      quoteAcceptedAt: null,
      stage: "quote_sent",
      hubspotDealId: "deal-9",
      ownerContact: { email: "ana@tortapalace.com" },
      quoteLines: [],
      ...QUOTE_BASIS,
    }];
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    await get();
    expect(syncDealFromApplication).toHaveBeenCalledTimes(1);
    expect(getDealProcessingArr).not.toHaveBeenCalled();
    expect(patchDealProcessingArr).not.toHaveBeenCalled();
  });

  it("persists a failed resync as lastSyncError, and does not fail the whole cron run over it", async () => {
    listQuotesModifiedSince.mockResolvedValue([quote()]);
    selectRows = acceptedRow();
    findSubscriptionsForQuote.mockResolvedValue([sub()]);
    patchDealProcessingArr.mockRejectedValue(new Error("payment_processing_arr write failed (403)"));

    const res = await get();
    expect(res.status).toBe(200);
    const errorWrite = updates.find(u => (u.hubspotIds as HubspotIds | undefined)?.lastSyncError);
    expect(errorWrite).toBeTruthy();
    expect((errorWrite!.hubspotIds as HubspotIds).lastSyncError).toContain("403");
    expect((errorWrite!.hubspotIds as HubspotIds).lastSyncErrorAt).toBeTruthy();
  });

  it("clears a stale lastSyncError once the resync succeeds, even when nothing else in the snapshot moved", async () => {
    // Deliberately NO QUOTE_BASIS: this is testing the OUTER snapshot-write's
    // clearing behaviour, which runs regardless of whether the ARR block
    // even has anything to do, so it's kept orthogonal to that logic.
    listQuotesModifiedSince.mockResolvedValue([quote()]); // same paymentStatus/esign/etc as HUBSPOT_IDS
    selectRows = [{
      id: "app-1",
      hubspotIds: {
        ...HUBSPOT_IDS,
        subscriptions: [sub()], subscriptionStatus: "active", // already cached, matching this run's read
        lastSyncError: "HubSpot 500", lastSyncErrorAt: "2026-10-12T00:00:00.000Z",
      },
      hubspotDealId: "deal-9",
    }];
    findSubscriptionsForQuote.mockResolvedValue([sub()]);

    await get();
    // The stale error differing from `next`'s unconditional null IS a
    // snapshotChanged "moved" row on its own, so the ordinary snapshot write
    // is what clears it here — not a second, separate write.
    const write = updates[0].hubspotIds as HubspotIds;
    expect(write.lastSyncError).toBeNull();
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
