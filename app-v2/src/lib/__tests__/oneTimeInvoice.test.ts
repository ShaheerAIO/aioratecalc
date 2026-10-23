import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EMPTY_HUBSPOT_IDS, EMPTY_HUBSPOT_INVOICE } from "@/types/merchant";
import type { HubspotInvoice, MerchantApplication, QuoteLine } from "@/types/merchant";

// The REAL invoice orchestrator. Only the network edges are stubbed — the
// line split, the reconciliation planner and the invoice property builder are
// the shipped ones, because what's under test is what gets persisted, in what
// order, and what a rerun does with what it finds. Same posture as
// publishBillingQuote.test.ts.

const createQuoteLineItems = vi.fn();
const deleteQuoteLineItem = vi.fn();
const createDraftInvoice = vi.fn();
const associateInvoice = vi.fn();
const openInvoice = vi.fn();
const getInvoiceSnapshot = vi.fn();

// The one column this module owns, as the DB holds it.
let stored: HubspotInvoice | null = null;
const writes: HubspotInvoice[] = [];

// `update().set().where()` is AWAITED by every persist — a thenable that
// writes when awaited. Only the claim calls `.returning()` instead, which
// models `where(isNull(hubspotInvoice))`: it writes only onto an empty column.
const db = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => [{ hubspotInvoice: stored }] }) }),
  }),
  update: () => ({
    set: (patch: { hubspotInvoice: HubspotInvoice }) => ({
      where: () => {
        const apply = () => { stored = patch.hubspotInvoice; writes.push(patch.hubspotInvoice); };
        return {
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            apply();
            return Promise.resolve(undefined).then(resolve, reject);
          },
          returning: async () => {
            if (stored !== null) return [];   // claim lost
            apply();
            return [{ hubspotInvoice: stored }];
          },
        };
      },
    }),
  }),
};

vi.mock("@/lib/db/client", () => ({ db }));
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  createQuoteLineItems, deleteQuoteLineItem, createDraftInvoice, associateInvoice, openInvoice, getInvoiceSnapshot,
}));

const { buildOneTimeInvoice, buildOneTimeInvoiceSafely } = await import("@/lib/billing/oneTimeInvoice");

const line = (over: Partial<QuoteLine>): QuoteLine => ({
  hubspotProductId: "217445755632", name: "POS Unit", qty: 1, unitPrice: 949,
  billingFrequency: "one_time", productType: "inventory", ...over,
});
const PLATFORM = line({ hubspotProductId: "335283119838", name: "All-in-One Platform", unitPrice: 399, billingFrequency: "monthly", productType: "Software" });
const PRE_AUTH = line({ hubspotProductId: "281354281678", name: "AIO Pre Auth", unitPrice: 0.5, productType: "Service" });
const POS = line({});
const INSTALL = line({ hubspotProductId: "223452690133", name: "Onsite Installation", unitPrice: 999, productType: "Service" });
const COMPED = line({ hubspotProductId: "223511653105", name: "Payment Terminal - AMS1", unitPrice: 350, discountPercent: 100, coveredByPackage: "QSR Kit" });

function app(over: Partial<MerchantApplication> = {}): MerchantApplication {
  return {
    id: "prospect-1",
    quoteAcceptedAt: "2026-10-22T00:00:00.000Z",
    hubspotDealId: "deal-99",
    tenantLink: { hubspotCompanyId: "334295287484" },
    hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "quote-5", contactId: "contact-7", publishedAt: "2026-10-21T00:00:00.000Z", splitBilling: true },
    hubspotInvoice: stored,
    quoteLines: [PLATFORM, POS, INSTALL, COMPED, PRE_AUTH],
    business: { legalName: "Torta Palace LLC", dba: "Torta Palace" },
    ownerContact: { email: "ana@tortapalace.com" },
    billingContact: { email: "books@tortapalace.com" },
    ...over,
  } as never;
}

/** One observer seeing the row as it now stands. */
const run = (over: Partial<MerchantApplication> = {}) =>
  buildOneTimeInvoice(app({ hubspotInvoice: stored, ...over }));

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const fn of [createQuoteLineItems, deleteQuoteLineItem, createDraftInvoice, associateInvoice, openInvoice, getInvoiceSnapshot]) fn.mockReset();
  stored = null;
  writes.length = 0;
  createQuoteLineItems.mockImplementation(async (lines: QuoteLine[]) => lines.map((_, i) => `li-${i + 1}`));
  createDraftInvoice.mockResolvedValue("inv-1");
  associateInvoice.mockResolvedValue(undefined);
  openInvoice.mockResolvedValue(undefined);
  getInvoiceSnapshot.mockResolvedValue({
    invoiceId: "inv-1", status: "open", paymentStatus: null, balanceDue: 1948, invoiceLink: "https://customers.aioapp.com/inv-link",
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); logSpy.mockRestore(); });

describe("buildOneTimeInvoice", () => {
  it("builds an invoice of only the invoiced lines, associates it and opens it", async () => {
    const result = await run();
    expect(result).toEqual({ status: "built", invoiceId: "inv-1" });

    // POS, install and the comped terminal — never the plan or the pre-auth,
    // which are on the quote.
    expect(createQuoteLineItems).toHaveBeenCalledWith([POS, INSTALL, COMPED]);
    // ACH only, like the quote. Created as a draft; opened as its own step.
    expect(createDraftInvoice.mock.calls[0][0]).toMatchObject({ hs_currency: "USD", hs_allowed_payment_methods: "ach" });
    expect(createDraftInvoice.mock.calls[0][0]).not.toHaveProperty("hs_invoice_status");
    expect(openInvoice).toHaveBeenCalledWith("inv-1");
    expect(associateInvoice).toHaveBeenCalledWith("inv-1", [
      { toObjectType: "line_items", toObjectId: "li-1", associationTypeId: 409 },
      { toObjectType: "line_items", toObjectId: "li-2", associationTypeId: 409 },
      { toObjectType: "line_items", toObjectId: "li-3", associationTypeId: 409 },
      { toObjectType: "contacts", toObjectId: "contact-7", associationTypeId: 177 },
      { toObjectType: "companies", toObjectId: "334295287484", associationTypeId: 179 },
      { toObjectType: "deals", toObjectId: "deal-99", associationTypeId: 175 },
    ]);
    // $949 + $999; the comped terminal nets to nothing. The link is what the
    // merchant's quote page and checklist point at.
    expect(stored).toMatchObject({
      invoiceId: "inv-1", lineItemIds: ["li-1", "li-2", "li-3"], amount: 1948, status: "open",
      invoiceLink: "https://customers.aioapp.com/inv-link", lastSyncError: null,
    });
    expect(stored!.builtAt).not.toBeNull();
    expect(stored!.openedAt).not.toBeNull();
  });

  // Built beside the quote when it is published — acceptance is not needed.
  it("builds before acceptance, but never before the quote is published", async () => {
    expect(await run({ hubspotIds: { ...EMPTY_HUBSPOT_IDS, contactId: "contact-7", splitBilling: true } }))
      .toEqual({ status: "skipped", reason: "not_published" });
    expect(writes).toHaveLength(0);
    expect(await run({ quoteAcceptedAt: null })).toEqual({ status: "built", invoiceId: "inv-1" });
  });

  // A quote published before split billing carries its one-time lines on the
  // quote — the merchant paid them at checkout. Invoicing them would bill twice.
  it("never invoices a quote published before split billing", async () => {
    const result = await run({ hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "quote-5", contactId: "contact-7", publishedAt: "2026-10-01T00:00:00.000Z" } });
    expect(result).toEqual({ status: "skipped", reason: "not_split" });
    expect(createDraftInvoice).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("skips a quote whose one-time lines are all comped", async () => {
    const result = await run({ quoteLines: [PLATFORM, COMPED, PRE_AUTH] });
    expect(result).toEqual({ status: "skipped", reason: "nothing_to_invoice" });
    expect(createDraftInvoice).not.toHaveBeenCalled();
  });

  it("is a no-op once the invoice is built and open", async () => {
    await run();
    createDraftInvoice.mockClear();
    associateInvoice.mockClear();
    openInvoice.mockClear();
    expect(await run()).toEqual({ status: "skipped", reason: "already_built" });
    expect(createDraftInvoice).not.toHaveBeenCalled();
    expect(associateInvoice).not.toHaveBeenCalled();
    expect(openInvoice).not.toHaveBeenCalled();
  });

  // Drafts built before 2026-10-23 were never opened; a rerun opens the same one.
  it("opens a draft built before invoices were opened, without building another", async () => {
    stored = {
      ...EMPTY_HUBSPOT_INVOICE, invoiceId: "inv-1", lineItemIds: ["li-1", "li-2", "li-3"], amount: 1948,
      status: "draft", builtAt: "2026-10-22T00:00:00.000Z",
    };
    expect(await run()).toEqual({ status: "built", invoiceId: "inv-1" });
    expect(createDraftInvoice).not.toHaveBeenCalled();
    expect(createQuoteLineItems).not.toHaveBeenCalled();
    expect(openInvoice).toHaveBeenCalledWith("inv-1");
    expect(stored).toMatchObject({ status: "open", invoiceLink: "https://customers.aioapp.com/inv-link" });
  });

  it("resumes a failed open without opening twice", async () => {
    getInvoiceSnapshot.mockRejectedValueOnce(new Error("HubSpot 502"));
    expect(await run()).toMatchObject({ status: "failed", step: "open" });
    expect(stored!.openedAt).not.toBeNull();
    expect(await run()).toEqual({ status: "built", invoiceId: "inv-1" });
    expect(openInvoice).toHaveBeenCalledTimes(1);
  });

  it("refuses before any HubSpot write when the quote's contact is missing", async () => {
    const result = await run({ hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "quote-5", publishedAt: "2026-10-21T00:00:00.000Z", splitBilling: true } });
    expect(result).toMatchObject({ status: "failed", step: "preflight" });
    expect(createQuoteLineItems).not.toHaveBeenCalled();
    expect(stored!.lastSyncError).toContain("the quote's HubSpot contact");
  });

  it("resumes a failed association from the persisted ids instead of building a second invoice", async () => {
    associateInvoice.mockRejectedValueOnce(new Error("HubSpot 500"));
    const first = await run();
    expect(first).toMatchObject({ status: "failed", step: "associations" });
    expect(stored).toMatchObject({ invoiceId: "inv-1", builtAt: null });
    expect(stored!.lastSyncError).toContain("associations failed: HubSpot 500");

    const second = await run();
    expect(second).toEqual({ status: "built", invoiceId: "inv-1" });
    expect(createDraftInvoice).toHaveBeenCalledTimes(1);
    expect(createQuoteLineItems).toHaveBeenCalledTimes(1);
    expect(stored!.lastSyncError).toBeNull();
  });

  it("backs off while another request holds a fresh claim", async () => {
    stored = { ...EMPTY_HUBSPOT_INVOICE, syncedAt: new Date().toISOString() };
    expect(await run()).toEqual({ status: "skipped", reason: "build_in_progress" });
    expect(createQuoteLineItems).not.toHaveBeenCalled();
  });
});

describe("buildOneTimeInvoiceSafely", () => {
  // Acceptance detection calls this; its contract is that nothing after the
  // acceptance write can throw back into it.
  it("never throws, even when the build itself does", async () => {
    createDraftInvoice.mockImplementationOnce(() => { throw new Error("boom"); });
    await expect(buildOneTimeInvoiceSafely(app())).resolves.toBeUndefined();
  });
});
