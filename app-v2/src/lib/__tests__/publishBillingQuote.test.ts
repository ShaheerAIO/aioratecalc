import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { merchantApplications, users } from "@/lib/db/schema";
import { ORDER_POINT_RULES } from "@/lib/quoting";
import { EMPTY_HUBSPOT_IDS } from "@/types/merchant";
import type { CatalogProduct, HubspotIds, QuoteLine } from "@/types/merchant";

// The REAL orchestrator, driven the way the rep's Send Quote button drives it.
// Only the network edges are stubbed — the pure HubSpot builders
// (toLineItemProperties, draftQuoteProperties, planLineItemReconciliation), the
// preconditions and the quoting derivations are all the shipped ones, because
// what's under test is exactly the wiring between them: what gets persisted, in
// what order, and what a rerun does with what it finds.
//
// It used to run through the accept route, because publishing happened inside
// the merchant's acceptance POST. That is reversed now: the rep publishes
// first, and the merchant accepts by signing and paying the published quote.
// So this calls the orchestrator directly, as sendQuoteAction does.

const syncDealFromApplication = vi.fn();
const sendMagicLinkEmail = vi.fn();
const ensureQuoteContact = vi.fn();
const createQuoteLineItems = vi.fn();
const deleteQuoteLineItem = vi.fn();
const createDraftQuote = vi.fn();
const associateQuote = vi.fn();
const associateDealToContact = vi.fn();
const publishQuote = vi.fn();
const findOwnerByEmail = vi.fn();
const listProducts = vi.fn();
const getQuoteTemplatePolicy = vi.fn();

type Row = Record<string, unknown> & { id: string; hubspotIds: HubspotIds | null };

let row: Row | null = null;
const patches: Array<Record<string, unknown>> = [];
const loginTokens: Array<Record<string, unknown>> = [];

// Same chainable drizzle stand-in as leadAccept.test.ts, plus the two things
// this file needs: a `from(table)`-aware select (the orchestrator reads the
// owning rep out of `users` for hs_sender_email) and a `returning()` that models
// `where(isNull(hubspotIds))` — the conditional claim that stops two concurrent
// acceptances building two quotes. Persist-after-every-step writes never call
// returning(), so only the claim is gated.
const db = {
  select: (_fields?: unknown) => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () =>
          table === users
            ? [{ email: "rita@aioapp.com", name: "Rita Rep" }]
            : row
              ? [row]
              : [],
      }),
    }),
  }),
  update: (_table?: unknown) => ({
    set: (patch: Record<string, unknown>) => {
      const before = row;
      patches.push(patch);
      if (row) row = { ...row, ...patch } as Row;
      return {
        where: () =>
          Object.assign(Promise.resolve(undefined), {
            returning: async () => {
              if ("hubspotIds" in patch && before?.hubspotIds != null) {
                // Claim lost — roll the optimistic write back, as the real
                // conditional UPDATE would never have applied it.
                row = before;
                patches.pop();
                return [];
              }
              return row ? [{ ...row }] : [];
            },
          }),
      };
    },
  }),
  insert: (_table?: unknown) => ({
    values: async (v: Record<string, unknown>) => { loginTokens.push(v); },
  }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/adapters/email", () => ({ sendMagicLinkEmail }));
vi.mock("@/lib/actions/quoteTemplates", () => ({ getQuoteTemplatePolicy }));
vi.mock("@/lib/actions/pricing", () => ({ getMaxDiscountPercent: vi.fn().mockResolvedValue(50) }));
// Partial mock: the pure builders stay real, only the network calls are stubbed.
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  syncDealFromApplication,
  ensureQuoteContact,
  createQuoteLineItems,
  deleteQuoteLineItem,
  createDraftQuote,
  associateQuote,
  associateDealToContact,
  publishQuote,
  findOwnerByEmail,
  listProducts,
}));

const { POST } = await import("@/app/api/lead/[token]/accept/route");
const { buildAndPublishBillingQuote } = await import("@/lib/billing/publishBillingQuote");
const { rowToApp } = await import("@/lib/storage/applicationRow");

const TOKEN = "tok-1";
const NOW = new Date("2026-08-21T19:49:38.000Z");

// The clock is pinned: the fixture row carries a fixed customerLinkExpiresAt,
// and against a real clock every case in this file silently turned into a 410
// the day that date passed. Only Date is faked — the billing build waits on a
// real setTimeout for hs_quote_link.
vi.useFakeTimers({ toFake: ["Date"], now: NOW });
const SIGNER_EMAIL = "ana@tortapalace.com";

const PLATFORM: CatalogProduct = {
  hubspotProductId: "217526517443",
  name: "AIO Platform (1 to 5 Order Points)",
  price: 99,
  billingFrequency: "weekly",
  productType: "Software",
};
const POS: CatalogProduct = {
  hubspotProductId: "217445755632",
  name: "POS Unit",
  price: 1200,
  billingFrequency: "one_time",
  productType: "inventory",
};
// Neither tablet needs review any more (both resolved to 0 points on
// 2026-09-17), so the needs-review refusal is driven by a rule registered just
// for this suite. By name only: quoting.ts indexes rules by product id at
// module load, so one added here is never found by id.
const REVIEWABLE: CatalogProduct = {
  hubspotProductId: "900000000001",
  name: "Mystery Ordering Device",
  price: 400,
  billingFrequency: "one_time",
  productType: "inventory",
};

beforeAll(() => {
  ORDER_POINT_RULES[REVIEWABLE.name] = {
    pointsPerUnit: 0,
    needsReview: "Nobody can tell from the catalog whether this takes orders.",
  };
});
afterAll(() => { delete ORDER_POINT_RULES[REVIEWABLE.name]; });

function line(p: CatalogProduct, qty = 1): QuoteLine {
  return {
    hubspotProductId: p.hubspotProductId,
    name: p.name,
    qty,
    unitPrice: p.price,
    billingFrequency: p.billingFrequency,
    productType: p.productType,
  };
}

const LINES = [line(PLATFORM), line(POS)];

function baseRow(extra: Partial<Row> = {}): Row {
  return {
    id: "prospect-1",
    ownerUserId: "rep-1",
    customerUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    stage: "quote_sent",
    hubspotDealId: "deal-99",
    // Linked: nothing is built for an account without a HubSpot company, so
    // every graph case below would otherwise short-circuit before the first
    // call. The unlinked case is asserted on its own.
    tenantLink: {
      hubspotCompanyId: "334295287484",
      companyName: "Torta Palace",
      tenantRef: null,
      adyenAccountHolderId: null,
      linkedAt: "2026-08-21T00:00:00.000Z",
      linkedByUserId: "rep-1",
    },
    adyenIds: null,
    adyenOnboardingUrl: null,
    checkIds: null,
    hubspotIds: null,
    quoteType: "full_pos",
    quoteConfig: { monthlyVolume: 40000, avgTicket: 30 },
    quoteLines: LINES,
    orderPoints: { hardware: { "POS Unit": 1 }, channels: [], total: 1 },
    quoteAcceptedAt: null,
    targetMargin: "0.019000",
    pricingModel: "2-tier",
    customerLinkToken: TOKEN,
    customerLinkPurpose: "lead_upload",
    customerLinkSentAt: NOW,
    customerLinkExpiresAt: new Date("2026-09-04T00:00:00.000Z"),
    analysis: null,
    proposal: null,
    business: { legalName: "Torta Palace LLC", dba: "Torta Palace" },
    ownerContact: { email: SIGNER_EMAIL },
    processing: null,
    agreement: null,
    ...extra,
  };
}

/** The rep hitting Send Quote — `sendQuoteAction` calls exactly this. */
const send = () => buildAndPublishBillingQuote(rowToApp(row as never));

/**
 * A second attempt on the row as it now stands — what a rep reaches by fixing
 * the blocker and sending again, and what `linkTenantCompanyAction` does once
 * the company arrives. Same call; named separately for what it means.
 */
const resume = send;

/** The last hubspotIds written, i.e. what a rep or the checklist would read. */
function storedIds(): HubspotIds | null {
  return row?.hubspotIds ?? null;
}

function billingCallCount(): number {
  return (
    ensureQuoteContact.mock.calls.length +
    createQuoteLineItems.mock.calls.length +
    createDraftQuote.mock.calls.length +
    associateQuote.mock.calls.length +
    publishQuote.mock.calls.length
  );
}

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const fn of [
    syncDealFromApplication, sendMagicLinkEmail, ensureQuoteContact, createQuoteLineItems, findOwnerByEmail,
    deleteQuoteLineItem, createDraftQuote, associateQuote, associateDealToContact,
    publishQuote, listProducts, getQuoteTemplatePolicy,
  ]) fn.mockReset();

  patches.length = 0;
  loginTokens.length = 0;
  row = baseRow();

  syncDealFromApplication.mockResolvedValue("deal-99");
  sendMagicLinkEmail.mockResolvedValue({ sent: true, devUrl: null });
  // The owning rep IS a HubSpot portal user. hs_sender_email is checked
  // against the portal before the one-way door opens — see the not-a-portal-
  // user test below for the case that check exists for.
  findOwnerByEmail.mockResolvedValue({ id: "71234567", email: "rita@aioapp.com", firstName: "Rita", lastName: "Rep" });
  listProducts.mockResolvedValue([PLATFORM, POS, REVIEWABLE]);
  getQuoteTemplatePolicy.mockResolvedValue({
    full_pos: "817263673055", food_truck: "817263673055", marketing_only: "817697352408",
  });
  ensureQuoteContact.mockResolvedValue("contact-7");
  createQuoteLineItems.mockImplementation(async (lines: QuoteLine[]) =>
    lines.map((_, i) => `li-${i + 1}`)
  );
  createDraftQuote.mockResolvedValue({ quoteId: "quote-5", slug: "abc123" });
  associateQuote.mockResolvedValue(undefined);
  associateDealToContact.mockResolvedValue(undefined);
  publishQuote.mockResolvedValue({
    quoteId: "quote-5",
    status: "APPROVAL_NOT_NEEDED",
    quoteLink: "https://customers.aioapp.com/abc123",
    paymentStatus: "PENDING",
    alreadyPublished: false,
  });

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("publishing the billing quote", () => {
  it("builds the whole graph and publishes it", async () => {
    await send();

    // The signer is ownerContact — the business contact of record, which
    // createProspectAction writes on every prospect row. There is no
    // "whoever clicked accept" fallback any more: the rep sends the quote
    // before anyone has accepted anything.
    expect(ensureQuoteContact).toHaveBeenCalledWith(
      expect.objectContaining({ email: SIGNER_EMAIL, firstName: "", lastName: "" })
    );
    expect(createQuoteLineItems).toHaveBeenCalledWith(LINES);
    expect(createDraftQuote.mock.calls[0][0]).toMatchObject({
      hs_title: "Torta Palace — AIO Platform Quote",
      hs_billing_enabled: true,
      hs_payment_enabled: true,
      hs_allowed_payment_methods: "ACH",
    });

    // 67 per line item, then deal 64, contact 69, signer 702, template 286.
    expect(associateQuote).toHaveBeenCalledWith("quote-5", [
      { toObjectType: "line_items", toObjectId: "li-1", associationTypeId: 67 },
      { toObjectType: "line_items", toObjectId: "li-2", associationTypeId: 67 },
      { toObjectType: "deals", toObjectId: "deal-99", associationTypeId: 64 },
      { toObjectType: "contacts", toObjectId: "contact-7", associationTypeId: 69 },
      { toObjectType: "contacts", toObjectId: "contact-7", associationTypeId: 702 },
      { toObjectType: "quote_template", toObjectId: "817263673055", associationTypeId: 286 },
    ]);
    // 1393 (deal ↔ primary quote) is HubSpot's to create at publish, never ours.
    const associated = associateQuote.mock.calls[0][1] as Array<{ associationTypeId: number }>;
    expect(associated.some(a => a.associationTypeId === 1393)).toBe(false);

    // hs_sender_email is the owning rep, not a shared mailbox.
    expect(publishQuote).toHaveBeenCalledWith("quote-5", {
      email: "rita@aioapp.com", firstName: "Rita", lastName: "Rep",
    });

    const ids = storedIds()!;
    expect(ids.contactId).toBe("contact-7");
    expect(ids.lineItemIds).toEqual(["li-1", "li-2"]);
    expect(ids.quoteId).toBe("quote-5");
    expect(ids.quoteTemplateId).toBe("817263673055");
    expect(ids.quoteLink).toBe("https://customers.aioapp.com/abc123");
    expect(ids.publishedAt).not.toBeNull();
    expect(ids.lastSyncError).toBeNull();
  });

  it("persists after every step that yields an id, before attempting the next", async () => {
    await send();
    // A duplicated published quote is unrecoverable, so ids never accumulate
    // in memory waiting on one final write (which is what the Adyen adapter
    // does). Each of the four id-yielding steps has its own row write.
    const idWrites = patches.filter(p => "hubspotIds" in p).map(p => p.hubspotIds as HubspotIds);
    expect(idWrites.length).toBeGreaterThanOrEqual(5); // claim + contact + lines + quote + publish
    const firstWithContact = idWrites.findIndex(i => i.contactId);
    const firstWithLines = idWrites.findIndex(i => i.lineItemIds?.length);
    const firstWithQuote = idWrites.findIndex(i => i.quoteId);
    const firstPublished = idWrites.findIndex(i => i.publishedAt);
    expect(firstWithContact).toBeLessThan(firstWithLines);
    expect(firstWithLines).toBeLessThan(firstWithQuote);
    expect(firstWithQuote).toBeLessThan(firstPublished);
  });

  it("creates nothing at all for a rate-only quote", async () => {
    // A processing deal with no products picked. HubSpot bills nothing on it —
    // the margin comes out of Adyen settlement — so this is a supported deal
    // shape, not a failure, and it must not even claim the row.
    row = baseRow({ quoteLines: [] });
    await send();
    expect(billingCallCount()).toBe(0);
    expect(patches.some(p => "hubspotIds" in p)).toBe(false);
    expect(storedIds()).toBeNull();
  });

  it("names the failed step in lastSyncError and keeps what it already built", async () => {
    createQuoteLineItems.mockRejectedValue(new Error("HubSpot line item create failed (403): missing scope"));
    await send();

    const ids = storedIds()!;
    expect(ids.contactId).toBe("contact-7");   // survived on disk
    expect(ids.lineItemIds).toBeNull();
    expect(ids.quoteId).toBeNull();
    expect(ids.publishedAt).toBeNull();
    // Not a bare "something went wrong": the step, what got built before it,
    // and HubSpot's own body.
    expect(ids.lastSyncError).toContain("line_items failed");
    expect(ids.lastSyncError).toContain("contact resolved");
    expect(ids.lastSyncError).toContain("missing scope");
    expect(ids.lastSyncErrorAt).not.toBeNull();
    expect(createDraftQuote).not.toHaveBeenCalled();
    expect(publishQuote).not.toHaveBeenCalled();
  });

  it("resumes a failed build without duplicating the contact it already made", async () => {
    createQuoteLineItems.mockRejectedValueOnce(new Error("HubSpot 500"));
    await send();
    expect(ensureQuoteContact).toHaveBeenCalledTimes(1);

    // The retry path. The row now carries a hubspotIds, so the conditional
    // claim fails and the build resumes from what's on disk rather than
    // starting a second graph.
    await resume();
    expect(ensureQuoteContact).toHaveBeenCalledTimes(1);      // reused, not re-created
    expect(createQuoteLineItems).toHaveBeenCalledTimes(2);
    expect(createDraftQuote).toHaveBeenCalledTimes(1);
    expect(publishQuote).toHaveBeenCalledTimes(1);
    expect(storedIds()!.publishedAt).not.toBeNull();
    expect(storedIds()!.lastSyncError).toBeNull();            // cleared on success
  });

  it("tops up a partial line-item create instead of duplicating the whole set", async () => {
    // Only the first of two line items landed before the failure.
    createQuoteLineItems.mockRejectedValueOnce(new Error("HubSpot 500"));
    await send();
    row = { ...row!, hubspotIds: { ...storedIds()!, lineItemIds: ["li-1"] } };

    createQuoteLineItems.mockImplementation(async (lines: QuoteLine[]) => lines.map(() => "li-2"));
    await resume();
    // Reconciliation kept li-1 and created only the missing tail — a re-create
    // of both would have double-billed a $1,200 POS unit.
    expect(createQuoteLineItems).toHaveBeenLastCalledWith([line(POS)]);
    expect(storedIds()!.lineItemIds).toEqual(["li-1", "li-2"]);
  });

  it("treats HubSpot's LOCKED (already published) as success, not failure", async () => {
    // The crash-between-publish-and-persist case: HubSpot accepted the publish
    // but the DB write never landed. Without this the application is stuck
    // forever holding a published quote it believes is a draft.
    publishQuote.mockResolvedValue({
      quoteId: "quote-5",
      status: "APPROVED",
      quoteLink: "https://customers.aioapp.com/abc123",
      paymentStatus: "PENDING",
      alreadyPublished: true,
    });
    await send();
    const ids = storedIds()!;
    expect(ids.publishedAt).not.toBeNull();
    expect(ids.quoteLink).toBe("https://customers.aioapp.com/abc123");
    expect(ids.lastSyncError).toBeNull();
  });

  it("does not publish twice when an already-published link is re-accepted", async () => {
    row = baseRow({
      hubspotIds: {
        ...EMPTY_HUBSPOT_IDS,
        quoteId: "quote-5",
        contactId: "contact-7",
        lineItemIds: ["li-1", "li-2"],
        quoteLink: "https://customers.aioapp.com/abc123",
        publishedAt: "2026-08-20T10:00:00.000Z",
        paymentStatus: "PENDING",
      },
      quoteAcceptedAt: NOW,
      stage: "quote_accepted",
    });
    await send();
    expect(billingCallCount()).toBe(0);
    expect(storedIds()!.publishedAt).toBe("2026-08-20T10:00:00.000Z");
  });

  it("stands down when another request holds the build claim", async () => {
    // A freshly claimed row: hubspotIds written, nothing built yet, no recorded
    // failure. A second concurrent acceptance must not start its own graph.
    row = baseRow({ hubspotIds: { ...EMPTY_HUBSPOT_IDS, syncedAt: new Date().toISOString() } });
    await send();
    expect(billingCallCount()).toBe(0);
  });

  it("resumes past an expired claim rather than wedging the account forever", async () => {
    // Same shape, but the claim is old — a function killed mid-build must not
    // block billing permanently.
    row = baseRow({
      hubspotIds: { ...EMPTY_HUBSPOT_IDS, syncedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    });
    await send();
    expect(publishQuote).toHaveBeenCalledTimes(1);
    expect(storedIds()!.publishedAt).not.toBeNull();
  });

  it("refuses an unreviewed order-point line and persists the reason without touching HubSpot", async () => {
    row = baseRow({ quoteLines: [line(PLATFORM), line(POS), line(REVIEWABLE)] });
    await send();
    expect(billingCallCount()).toBe(0);
    const ids = storedIds()!;
    expect(ids.quoteId).toBeNull();
    expect(ids.lastSyncError).toContain("refused before any HubSpot write");
    expect(ids.lastSyncError).toContain("Mystery Ordering Device");
  });

  it("refuses when there's no deal at all, so there is nothing to associate 64 to", async () => {
    // Under the mandatory-deal model this is only reachable on a legacy row
    // (from before deal adoption existed) — `syncDealFromApplication` has no
    // CREATE branch any more, so a null hubspotDealId is never an attempted-
    // and-failed push, it's simply nothing to sync at all.
    row = baseRow({ hubspotDealId: null });
    await send();
    expect(syncDealFromApplication).not.toHaveBeenCalled();
    expect(billingCallCount()).toBe(0);
    expect(storedIds()!.lastSyncError).toContain("refused before any HubSpot write");
    expect(storedIds()!.lastSyncError).toContain("isn't in HubSpot yet");
  });

  it("builds nothing, and records nothing, until a HubSpot company is linked", async () => {
    row = baseRow({ tenantLink: null, hubspotDealId: null });
    await send();
    expect(syncDealFromApplication).not.toHaveBeenCalled();
    expect(billingCallCount()).toBe(0);
    // Crucially NOT a persisted sync error: waiting on a rep to link the
    // company is the normal state of a fresh account, and counting it as a
    // failure would fill the admin dashboard's error tripwire with accounts
    // that are fine.
    expect(storedIds()).toBeNull();
  });

  it("refuses no_signer_email when the row carries no contact email", async () => {
    // The old accept-form fallback is gone, so this is now a hard refusal that
    // names the fix rather than mailing the mandate to whoever opened the link.
    row = baseRow({ ownerContact: null });
    const outcome = await send();
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reasons.map(r => r.code)).toContain("no_signer_email");
    expect(billingCallCount()).toBe(0);
  });

  // The go-live blocker this check closes. HubSpot silently accepted
  // `rep@aioapp.com` on the 2026-08-24 gate run, so nothing downstream would
  // ever have caught a sender that isn't a real portal user.
  it("refuses a sender who isn't a HubSpot portal user, before touching HubSpot", async () => {
    findOwnerByEmail.mockResolvedValue(null);
    const outcome = await send();
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reasons.map(r => r.code)).toContain("sender_not_hubspot_user");
    expect(billingCallCount()).toBe(0);
  });

  it("refuses rather than publishing unverified when the owner lookup fails", async () => {
    // A missing `crm.objects.owners.read` scope looks exactly like this. The
    // door is one-way, so "couldn't check" has to be as final as "wrong".
    findOwnerByEmail.mockRejectedValue(new Error("HubSpot owner lookup failed: 403 — the private app is missing a required scope"));
    const outcome = await send();
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reasons.map(r => r.code)).toContain("sender_unverified");
    expect(billingCallCount()).toBe(0);
  });

  it("builds the whole graph once the link arrives, without a second send", async () => {
    row = baseRow({ tenantLink: null, hubspotDealId: null });
    await send();
    expect(billingCallCount()).toBe(0);

    // What linkTenantCompanyAction does: stamp the link, create the held-back
    // deal, then re-enter the orchestrator on the same row.
    row = { ...row!, tenantLink: baseRow().tenantLink, hubspotDealId: "deal-99" } as never;
    const outcome = await resume();

    expect(outcome.status).toBe("published");
    expect(publishQuote).toHaveBeenCalledTimes(1);
    expect(storedIds()!.publishedAt).not.toBeNull();
  });
});
