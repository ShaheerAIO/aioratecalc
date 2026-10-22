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
const sendOneTimeInvoiceEmail = vi.fn();

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
vi.mock("@/lib/adapters/email", () => ({ sendOneTimeInvoiceEmail }));
vi.mock("@/lib/adapters/hubspot", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/adapters/hubspot")>()),
  createQuoteLineItems, deleteQuoteLineItem, createDraftInvoice, associateInvoice, openInvoice, getInvoiceSnapshot,
}));

const { buildAndSendOneTimeInvoice, issueOneTimeInvoiceSafely } = await import("@/lib/billing/oneTimeInvoice");

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
  buildAndSendOneTimeInvoice(app({ hubspotInvoice: stored, ...over }));

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const fn of [createQuoteLineItems, deleteQuoteLineItem, createDraftInvoice, associateInvoice, openInvoice, getInvoiceSnapshot, sendOneTimeInvoiceEmail]) fn.mockReset();
  stored = null;
  writes.length = 0;
  createQuoteLineItems.mockImplementation(async (lines: QuoteLine[]) => lines.map((_, i) => `li-${i + 1}`));
  createDraftInvoice.mockResolvedValue("inv-1");
  associateInvoice.mockResolvedValue(undefined);
  openInvoice.mockResolvedValue({
    invoiceId: "inv-1", status: "open", paymentStatus: "unpaid", balanceDue: 1948, invoiceLink: "https://customers.aioapp.com/inv-1",
  });
  sendOneTimeInvoiceEmail.mockResolvedValue({ sent: true, devUrl: null });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { errorSpy.mockRestore(); logSpy.mockRestore(); });

describe("buildAndSendOneTimeInvoice", () => {
  it("bills only the invoiced lines, opens the invoice and emails the billing contact", async () => {
    const result = await run();
    expect(result).toEqual({ status: "sent", invoiceId: "inv-1", invoiceLink: "https://customers.aioapp.com/inv-1" });

    // POS, install and the comped terminal — never the plan or the pre-auth,
    // which are on the quote.
    expect(createQuoteLineItems).toHaveBeenCalledWith([POS, INSTALL, COMPED]);
    expect(createDraftInvoice.mock.calls[0][0]).toMatchObject({
      hs_currency: "USD", hs_allowed_payment_methods: "ach", hs_allowed_commerce_payment_methods: "ACH",
    });
    const props = createDraftInvoice.mock.calls[0][0];
    expect(props.hs_due_date).toBe(props.hs_invoice_date);
    expect(associateInvoice).toHaveBeenCalledWith("inv-1", [
      { toObjectType: "line_items", toObjectId: "li-1", associationTypeId: 409 },
      { toObjectType: "line_items", toObjectId: "li-2", associationTypeId: 409 },
      { toObjectType: "line_items", toObjectId: "li-3", associationTypeId: 409 },
      { toObjectType: "contacts", toObjectId: "contact-7", associationTypeId: 177 },
      { toObjectType: "companies", toObjectId: "334295287484", associationTypeId: 179 },
      { toObjectType: "deals", toObjectId: "deal-99", associationTypeId: 175 },
    ]);
    // $949 + $999; the comped terminal nets to nothing.
    expect(sendOneTimeInvoiceEmail).toHaveBeenCalledWith(
      "books@tortapalace.com", "https://customers.aioapp.com/inv-1", "$1,948.00", "Torta Palace"
    );
    expect(stored).toMatchObject({ invoiceId: "inv-1", lineItemIds: ["li-1", "li-2", "li-3"], status: "open", lastSyncError: null });
    expect(stored!.openedAt).not.toBeNull();
    expect(stored!.emailedAt).not.toBeNull();
  });

  it("falls back to the owner when no billing contact was named", async () => {
    await run({ billingContact: null });
    expect(sendOneTimeInvoiceEmail.mock.calls[0][0]).toBe("ana@tortapalace.com");
  });

  it("does nothing before acceptance", async () => {
    expect(await run({ quoteAcceptedAt: null })).toEqual({ status: "skipped", reason: "not_accepted" });
    expect(writes).toHaveLength(0);
  });

  // A quote published before split billing carries its one-time lines on the
  // quote — the merchant paid them at checkout. Invoicing them would bill twice.
  it("never invoices a quote published before split billing", async () => {
    const result = await run({ hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "quote-5", contactId: "contact-7" } });
    expect(result).toEqual({ status: "skipped", reason: "not_split" });
    expect(createDraftInvoice).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("skips a quote whose one-time lines are all comped", async () => {
    const result = await run({ quoteLines: [PLATFORM, COMPED, PRE_AUTH] });
    expect(result).toEqual({ status: "skipped", reason: "nothing_to_invoice" });
    expect(createDraftInvoice).not.toHaveBeenCalled();
  });

  it("is a no-op once the invoice has been emailed", async () => {
    await run();
    sendOneTimeInvoiceEmail.mockClear();
    createDraftInvoice.mockClear();
    expect(await run()).toEqual({ status: "skipped", reason: "already_sent" });
    expect(createDraftInvoice).not.toHaveBeenCalled();
    expect(sendOneTimeInvoiceEmail).not.toHaveBeenCalled();
  });

  it("refuses before any HubSpot write when the quote's contact is missing", async () => {
    const result = await run({ hubspotIds: { ...EMPTY_HUBSPOT_IDS, quoteId: "quote-5", splitBilling: true } });
    expect(result).toMatchObject({ status: "failed", step: "preflight" });
    expect(createQuoteLineItems).not.toHaveBeenCalled();
    expect(stored!.lastSyncError).toContain("the quote's HubSpot contact");
  });

  it("resumes a failed open from the persisted ids instead of building a second invoice", async () => {
    openInvoice.mockRejectedValueOnce(new Error("HubSpot 500"));
    const first = await run();
    expect(first).toMatchObject({ status: "failed", step: "open" });
    expect(stored).toMatchObject({ invoiceId: "inv-1", openedAt: null });
    expect(stored!.lastSyncError).toContain("open failed: HubSpot 500");

    const second = await run();
    expect(second).toMatchObject({ status: "sent", invoiceId: "inv-1" });
    expect(createDraftInvoice).toHaveBeenCalledTimes(1);
    expect(createQuoteLineItems).toHaveBeenCalledTimes(1);
  });

  // The email is the last step and the only one a retry repeats once the
  // invoice is open: nothing in HubSpot is touched again.
  it("retries only the email when the send failed", async () => {
    sendOneTimeInvoiceEmail.mockResolvedValueOnce({ sent: false, devUrl: "x" });
    expect(await run()).toMatchObject({ status: "failed", step: "email" });
    expect(stored!.emailedAt).toBeNull();

    expect(await run()).toMatchObject({ status: "sent" });
    expect(openInvoice).toHaveBeenCalledTimes(1);
    expect(associateInvoice).toHaveBeenCalledTimes(1);
    expect(sendOneTimeInvoiceEmail).toHaveBeenCalledTimes(2);
  });

  it("re-reads the pay link when opening didn't return one yet", async () => {
    openInvoice.mockResolvedValueOnce({ invoiceId: "inv-1", status: "open", paymentStatus: null, balanceDue: null, invoiceLink: null });
    getInvoiceSnapshot.mockResolvedValueOnce({ invoiceId: "inv-1", status: "open", paymentStatus: null, balanceDue: null, invoiceLink: "https://customers.aioapp.com/late" });
    expect(await run()).toMatchObject({ status: "sent", invoiceLink: "https://customers.aioapp.com/late" });
  });

  it("backs off while another request holds a fresh claim", async () => {
    stored = { ...EMPTY_HUBSPOT_INVOICE, syncedAt: new Date().toISOString() };
    expect(await run()).toEqual({ status: "skipped", reason: "build_in_progress" });
    expect(createQuoteLineItems).not.toHaveBeenCalled();
  });
});

describe("issueOneTimeInvoiceSafely", () => {
  // Acceptance detection calls this; its contract is that nothing after the
  // acceptance write can throw back into it.
  it("never throws, even when the build itself does", async () => {
    createDraftInvoice.mockImplementationOnce(() => { throw new Error("boom"); });
    await expect(issueOneTimeInvoiceSafely(app())).resolves.toBeUndefined();
  });
});
