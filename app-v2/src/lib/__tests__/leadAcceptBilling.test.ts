import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { merchantApplications, users } from "@/lib/db/schema";
import { EMPTY_HUBSPOT_IDS } from "@/types/merchant";
import type { CatalogProduct, HubspotIds, QuoteLine } from "@/types/merchant";

// The REAL orchestrator, driven through the real accept route. Only the network
// edges are stubbed — the pure HubSpot builders (toLineItemProperties,
// draftQuoteProperties, planLineItemReconciliation), the preconditions and the
// quoting derivations are all the shipped ones, because what's under test is
// exactly the wiring between them: what gets persisted, in what order, and what
// a rerun does with what it finds.
//
// leadAccept.test.ts stubs this whole module out and covers the acceptance
// wiring instead. The two files are deliberately separate.

const pushToHubSpot = vi.fn();
const sendMagicLinkEmail = vi.fn();
const ensureQuoteContact = vi.fn();
const createQuoteLineItems = vi.fn();
const deleteQuoteLineItem = vi.fn();
const createDraftQuote = vi.fn();
const associateQuote = vi.fn();
const associateDealToContact = vi.fn();
const publishQuote = vi.fn();
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
// Partial mock: the pure builders stay real, only the network calls are stubbed.
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  pushToHubSpot,
  ensureQuoteContact,
  createQuoteLineItems,
  deleteQuoteLineItem,
  createDraftQuote,
  associateQuote,
  associateDealToContact,
  publishQuote,
  listProducts,
}));

const { POST } = await import("@/app/api/lead/[token]/accept/route");

const TOKEN = "tok-1";
const NOW = new Date("2026-08-21T19:49:38.000Z");
const ACCEPT_EMAIL = "ana@tortapalace.com";

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
const TABLET: CatalogProduct = {
  hubspotProductId: "276751313619",
  name: "Orders Hub Tablet",
  price: 400,
  billingFrequency: "one_time",
  productType: "inventory",
};

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
    tenantLink: null,
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
    ownerContact: null,
    processing: null,
    agreement: null,
    ...extra,
  };
}

const post = () =>
  POST(
    { json: async () => ({ email: ACCEPT_EMAIL }) } as never,
    { params: Promise.resolve({ token: TOKEN }) }
  );

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
    pushToHubSpot, sendMagicLinkEmail, ensureQuoteContact, createQuoteLineItems,
    deleteQuoteLineItem, createDraftQuote, associateQuote, associateDealToContact,
    publishQuote, listProducts, getQuoteTemplatePolicy,
  ]) fn.mockReset();

  patches.length = 0;
  loginTokens.length = 0;
  row = baseRow();

  pushToHubSpot.mockResolvedValue("deal-99");
  sendMagicLinkEmail.mockResolvedValue({ sent: true, devUrl: null });
  listProducts.mockResolvedValue([PLATFORM, POS, TABLET]);
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

describe("auto-publishing the billing quote on acceptance", () => {
  it("builds the whole graph and publishes it", async () => {
    const res = await post();
    expect(res.status).toBe(200);

    // The signer is the person who actually clicked accept — ownerContact is
    // null here, which is the normal state of a prospect-created row.
    expect(ensureQuoteContact).toHaveBeenCalledWith(
      expect.objectContaining({ email: ACCEPT_EMAIL, firstName: "", lastName: "" })
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
    await post();
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
    const res = await post();
    expect(res.status).toBe(200);
    expect(billingCallCount()).toBe(0);
    expect(patches.some(p => "hubspotIds" in p)).toBe(false);
    expect(storedIds()).toBeNull();
  });

  it("names the failed step in lastSyncError and keeps what it already built", async () => {
    createQuoteLineItems.mockRejectedValue(new Error("HubSpot line item create failed (403): missing scope"));
    const res = await post();
    // The acceptance still succeeds — it is already recorded and the login
    // email already sent.
    expect(res.status).toBe(200);
    expect(loginTokens).toHaveLength(1);

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
    await post();
    expect(ensureQuoteContact).toHaveBeenCalledTimes(1);

    // Second acceptance of the same link — the retry path. The row now carries
    // a hubspotIds, so the conditional claim fails and the build resumes from
    // what's on disk rather than starting a second graph.
    await post();
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
    await post();
    row = { ...row!, hubspotIds: { ...storedIds()!, lineItemIds: ["li-1"] } };

    createQuoteLineItems.mockImplementation(async (lines: QuoteLine[]) => lines.map(() => "li-2"));
    await post();
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
    const res = await post();
    expect(res.status).toBe(200);
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
    const res = await post();
    expect(res.status).toBe(200);
    expect(billingCallCount()).toBe(0);
    expect(storedIds()!.publishedAt).toBe("2026-08-20T10:00:00.000Z");
  });

  it("stands down when another request holds the build claim", async () => {
    // A freshly claimed row: hubspotIds written, nothing built yet, no recorded
    // failure. A second concurrent acceptance must not start its own graph.
    row = baseRow({ hubspotIds: { ...EMPTY_HUBSPOT_IDS, syncedAt: new Date().toISOString() } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(billingCallCount()).toBe(0);
  });

  it("resumes past an expired claim rather than wedging the account forever", async () => {
    // Same shape, but the claim is old — a function killed mid-build must not
    // block billing permanently.
    row = baseRow({
      hubspotIds: { ...EMPTY_HUBSPOT_IDS, syncedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    });
    await post();
    expect(publishQuote).toHaveBeenCalledTimes(1);
    expect(storedIds()!.publishedAt).not.toBeNull();
  });

  it("refuses an unreviewed tablet and persists the reason without touching HubSpot", async () => {
    row = baseRow({ quoteLines: [line(PLATFORM), line(POS), line(TABLET)] });
    const res = await post();
    expect(res.status).toBe(200);
    expect(billingCallCount()).toBe(0);
    const ids = storedIds()!;
    expect(ids.quoteId).toBeNull();
    expect(ids.lastSyncError).toContain("refused before any HubSpot write");
    expect(ids.lastSyncError).toContain("Orders Hub Tablet");
  });

  it("refuses when the deal push failed, so there is nothing to associate 64 to", async () => {
    row = baseRow({ hubspotDealId: null });
    pushToHubSpot.mockRejectedValue(new Error("HUBSPOT_BILLING_PRIVATE_APP_TOKEN is not set"));
    const res = await post();
    expect(res.status).toBe(200);
    expect(billingCallCount()).toBe(0);
    expect(storedIds()!.lastSyncError).toContain("refused before any HubSpot write");
    expect(storedIds()!.lastSyncError).toContain("isn't in HubSpot yet");
  });
});
