import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { quoteSummaryFileName, quoteSummarySections, renderQuoteSummaryPdf } from "@/lib/quoteSummaryPdf";
import { attachQuoteSummaryToDeal } from "@/lib/billing/quoteSummaryAttachment";
import { NOTE_TO_DEAL_ASSOCIATION_TYPE_ID, QUOTE_SUMMARY_FOLDER } from "@/lib/adapters/hubspotFiles";
import { PAYROLL_PRODUCT_ID } from "@/lib/quoting";
import type { CustomerSafeQuote, MerchantApplication, QuoteLine } from "@/types/merchant";

const PLATFORM: QuoteLine = {
  name: "All-in-One Platform", hubspotProductId: "335283119838", qty: 1, unitPrice: 399,
  billingFrequency: "monthly", productType: "Software",
};
const KIOSK: QuoteLine = {
  name: "27in Kiosk", hubspotProductId: "kiosk-1", qty: 2, unitPrice: 1500,
  billingFrequency: "one_time", productType: "Hardware", discountAmount: 500,
};
const INSTALL: QuoteLine = {
  name: "Onsite Installation", hubspotProductId: "install-1", qty: 1, unitPrice: 750,
  billingFrequency: "one_time", productType: "Service", discountPercent: 100, coveredByPackage: "Starter Package",
};

// A customer-safe quote carries a rate basis (effective rate, projected cost,
// savings) the on-screen summary deliberately no longer shows. The PDF must not
// print it either — and nothing internal is in this shape to begin with.
const QUOTE = {
  basis: "config",
  monthlyVolume: 50000,
  averageTicket: 25,
  effectiveRate: 0.0291,
  projectedMonthlyCost: 1455,
  projectedAnnualCost: 17460,
  currentMonthlyCost: null,
  currentEffectiveRate: null,
  monthlySavings: null,
  annualSavings: null,
  savingsPct: null,
  lines: [PLATFORM, KIOSK, INSTALL],
  lineTotals: { oneTime: 2500, recurring: [{ frequency: "monthly", amount: 399 }], monthlyEquivalent: 399 },
  orderPoints: { hardware: {}, channels: ["phone_ai"], total: 3 },
  payment: { cardPresentRate: 0.0249, cardNotPresentRate: 0.0299, perTransactionFee: 0.15, monthlyVolume: 50000 },
  oneTimeInvoiced: true,
  invoice: null,
} as CustomerSafeQuote;

// Every stream in the file, decompressed where it is Flate-encoded, as one
// latin1 string. pdf-lib writes standard-font text as hex strings, so callers
// search for the hex of what they expect.
function pdfStreamsText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const raw = buf.toString("latin1");
  let out = "";
  let at = 0;
  for (;;) {
    const start = raw.indexOf("stream", at);
    if (start < 0) break;
    const dataStart = raw[start + 6] === "\r" ? start + 8 : start + 7;
    const end = raw.indexOf("endstream", dataStart);
    if (end < 0) break;
    const chunk = buf.subarray(dataStart, end);
    try { out += inflateSync(chunk).toString("latin1"); } catch { out += chunk.toString("latin1"); }
    at = end + 9;
  }
  return out;
}
const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();
const containsText = (bytes: Uint8Array, s: string) => pdfStreamsText(bytes).toUpperCase().includes(hex(s));

describe("quoteSummarySections", () => {
  const sections = quoteSummarySections(QUOTE);
  const flat = sections.flatMap(s => [s.title, ...s.rows.flatMap(r => [r.label, r.value ?? "", ...(r.notes ?? [])])]).join("\n");

  it("mirrors the on-screen grouping", () => {
    expect(sections.map(s => s.title)).toEqual([
      "Configuration", "Software", "One-time (invoiced separately)", "Payment details",
    ]);
  });

  it("carries the key lines and totals", () => {
    expect(flat).toContain("Configured for 3 licenses (Phone-AI ordering).");
    expect(flat).toContain("All-in-One Platform");
    expect(flat).toContain("$399.00/mo");
    expect(flat).toContain("Monthly total");
    expect(flat).toContain("27in Kiosk ×2");
    expect(flat).toContain("$2,500.00"); // kiosk net of the $500 cash discount
    expect(flat).toContain("$500.00 off");
    expect(flat).toContain("Included in your Starter Package:");
    expect(flat).toContain("Invoice total");
    expect(flat).toContain("2.49% + $0.15 per transaction");
    expect(flat).toContain("2.99% + $0.15 per transaction");
    expect(flat).toContain("$50,000");
  });

  it("prints no rate basis, cost or savings figure", () => {
    expect(flat).not.toContain("2.91%");
    expect(flat).not.toContain("1,455");
    expect(flat).not.toContain("17,460");
    expect(flat.toLowerCase()).not.toMatch(/margin|adyen|commission|cost/);
  });
});

describe("quoteSummarySections — the first kiosk (2026-10-29)", () => {
  it("prints the free first kiosk as 100% off, not 'Included'", () => {
    const first: QuoteLine = {
      name: "Kiosk 27\" + Payment Terminal (AMS1) and Mount", hubspotProductId: "222497165009", qty: 1, unitPrice: 999,
      billingFrequency: "one_time", productType: "inventory", discountPercent: 100, firstKiosk: true,
    };
    const flat = quoteSummarySections({ ...QUOTE, lines: [PLATFORM, first] } as CustomerSafeQuote)
      .flatMap(s => s.rows.flatMap(r => [r.label, r.value ?? "", ...(r.notes ?? [])])).join("\n");
    expect(flat).toContain("List $999.00, 100% off");
    expect(flat).not.toContain("Included");
  });
});

describe("quoteSummarySections — payroll and display names (2026-10-29)", () => {
  const PAYROLL: QuoteLine = {
    name: "AIO Payroll", hubspotProductId: PAYROLL_PRODUCT_ID, qty: 1, unitPrice: 59,
    billingFrequency: "monthly", productType: "Software",
  };
  const LICENSE: QuoteLine = {
    name: "Additional Software License", hubspotProductId: "license-1", qty: 2, unitPrice: 25,
    billingFrequency: "monthly", productType: "Software",
  };
  // Server totals cover EVERY recurring line, payroll included.
  const quote = {
    ...QUOTE,
    lines: [PLATFORM, LICENSE, PAYROLL],
    lineTotals: { oneTime: 0, recurring: [{ frequency: "monthly", amount: 508 }], monthlyEquivalent: 508 },
    orderPoints: null,
  } as CustomerSafeQuote;
  const sections = quoteSummarySections(quote);
  const section = (title: string) => sections.find(s => s.title === title)!;

  it("puts payroll in its own section with its own total, out of Software's", () => {
    expect(sections.map(s => s.title)).toEqual(["Software", "Payroll", "Payment details"]);
    const software = section("Software");
    expect(software.rows.map(r => r.label)).not.toContain("AIO Payroll");
    expect(software.rows.find(r => r.total)).toEqual({ label: "Monthly total", value: "$449.00/mo", total: true });
    const payroll = section("Payroll");
    expect(payroll.rows.map(r => r.label)).toEqual(["AIO Payroll", "Monthly total"]);
    expect(payroll.rows[1].value).toBe("$59.00/mo");
  });

  it("keeps the server's totals when there is no payroll", () => {
    const noPayroll = quoteSummarySections({ ...QUOTE, lines: [PLATFORM], orderPoints: null } as CustomerSafeQuote);
    expect(noPayroll.find(s => s.title === "Payroll")).toBeUndefined();
    expect(noPayroll.find(s => s.title === "Software")!.rows.at(-1)!.value).toBe("$399.00/mo");
  });

  it("shows an Additional Software License as an Additional License", () => {
    const labels = section("Software").rows.map(r => r.label);
    expect(labels).toContain("Additional License ×2");
    expect(labels.join("\n")).not.toContain("Software License");
  });

  it("lists both card rates at equal weight, card present first", () => {
    const rows = section("Payment details").rows;
    expect(rows.slice(0, 2).map(r => r.label)).toEqual(["Card present", "Card not present"]);
    expect(rows.some(r => r.total)).toBe(false);
  });

  it("draws the Payroll section and the renamed line into the PDF", async () => {
    const bytes = await renderQuoteSummaryPdf({ quote, businessName: "Torta Palace" });
    expect(containsText(bytes, "Payroll")).toBe(true);
    expect(containsText(bytes, "Additional License")).toBe(true);
    expect(containsText(bytes, "Additional Software License")).toBe(false);
  });
});

describe("renderQuoteSummaryPdf", () => {
  it("renders a non-empty, loadable PDF containing the summary", async () => {
    const bytes = await renderQuoteSummaryPdf({ quote: QUOTE, businessName: "Torta Palace", acceptedAt: "2026-10-29T18:00:00.000Z" });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);

    expect(containsText(bytes, "AIO Quote Summary")).toBe(true);
    expect(containsText(bytes, "Torta Palace")).toBe(true);
    expect(containsText(bytes, "Accepted October 29, 2026")).toBe(true);
    expect(containsText(bytes, "All-in-One Platform")).toBe(true);
    expect(containsText(bytes, "Invoice total")).toBe(true);
    expect(containsText(bytes, "Payment details")).toBe(true);    expect(containsText(bytes, "Not on this quote")).toBe(false);
  });

  it("survives characters the standard fonts can't encode", async () => {
    const odd = { ...QUOTE, lines: [{ ...PLATFORM, name: "Platform → 🚀 Pro" }] } as CustomerSafeQuote;
    const bytes = await renderQuoteSummaryPdf({ quote: odd, businessName: "Café ✓" });
    expect(containsText(bytes, "Platform -> Pro")).toBe(true);
    expect(containsText(bytes, "Café")).toBe(true);
  });

  it("paginates a long quote rather than drawing off the page", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ ...KIOSK, hubspotProductId: `k-${i}`, name: `Item ${i}` }));
    const bytes = await renderQuoteSummaryPdf({ quote: { ...QUOTE, lines: many } as CustomerSafeQuote, businessName: "Big" });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });
});

describe("quoteSummaryFileName", () => {
  it("is built from the business name only, sanitised and timestamped", () => {
    expect(quoteSummaryFileName("../Torta Palace/ & Co", new Date("2026-10-29T01:02:03.456Z")))
      .toBe("AIO-Quote-Summary-Torta-Palace-Co-20261029T010203Z.pdf");
    expect(quoteSummaryFileName(null)).toMatch(/^AIO-Quote-Summary-Business-/);
  });
});

describe("attachQuoteSummaryToDeal", () => {
  const fetchMock = vi.fn();
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const app = (extra: Partial<MerchantApplication> = {}) => ({
    id: "app-1",
    hubspotDealId: "deal-9",
    quoteAcceptedAt: "2026-10-29T18:00:00.000Z",
    quoteType: "marketing_only",
    quoteLines: [{ ...PLATFORM, name: "AIO Marketing Platform" }],
    quoteConfig: null,
    quoteRates: null,
    analysis: null,
    targetMargin: null,
    pricingModel: null,
    orderPoints: null,
    processing: null,
    hubspotIds: null,
    hubspotInvoice: null,
    business: { legalName: "Torta Palace LLC", dba: "Torta <Palace>" },
    ...extra,
  }) as unknown as MerchantApplication;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("HUBSPOT_PRIVATE_APP_TOKEN", "general-token");
    vi.stubEnv("HUBSPOT_BILLING_PRIVATE_APP_TOKEN", "billing-token");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
  });

  it("uploads the PDF privately, then notes it onto the deal (association 214)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "file-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "note-1" }), { status: 201 }));

    const res = await attachQuoteSummaryToDeal(app());
    expect(res).toEqual({ attached: true, fileId: "file-1", noteId: "note-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0];
    expect(uploadUrl).toBe("https://api.hubapi.com/files/v3/files");
    expect(uploadInit.headers).toEqual({ Authorization: "Bearer general-token" });
    const form = uploadInit.body as FormData;
    expect(form.get("folderPath")).toBe(QUOTE_SUMMARY_FOLDER);
    expect(JSON.parse(form.get("options") as string).access).toBe("PRIVATE");
    expect(form.get("fileName")).toMatch(/^AIO-Quote-Summary-Torta-Palace-.*\.pdf$/);
    const file = form.get("file") as Blob;
    expect(file.type).toBe("application/pdf");
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const [noteUrl, noteInit] = fetchMock.mock.calls[1];
    expect(noteUrl).toBe("https://api.hubapi.com/crm/v3/objects/notes");
    expect(noteInit.method).toBe("POST");
    expect(noteInit.headers.Authorization).toBe("Bearer billing-token");
    const body = JSON.parse(noteInit.body);
    expect(body.properties.hs_attachment_ids).toBe("file-1");
    expect(body.properties.hs_note_body).toContain("Torta &lt;Palace&gt;");
    expect(body.associations).toEqual([{
      to: { id: "deal-9" },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_DEAL_ASSOCIATION_TYPE_ID }],
    }]);
    expect(NOTE_TO_DEAL_ASSOCIATION_TYPE_ID).toBe(214);
  });

  it("swallows and logs an upload failure, and never attempts the note", async () => {
    fetchMock.mockResolvedValueOnce(new Response("missing scopes", { status: 403 }));
    await expect(attachQuoteSummaryToDeal(app())).resolves.toEqual({ attached: false, reason: "failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[quote-summary] app-1"),
      expect.stringContaining("403"),
    );
  });

  it("swallows and logs a note failure", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "file-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(attachQuoteSummaryToDeal(app())).resolves.toEqual({ attached: false, reason: "failed" });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("deal-9"), expect.stringContaining("500"));
  });

  it("swallows a thrown fetch (network down)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(attachQuoteSummaryToDeal(app())).resolves.toEqual({ attached: false, reason: "failed" });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does nothing without a deal or without a quote", async () => {
    expect(await attachQuoteSummaryToDeal(app({ hubspotDealId: null }))).toEqual({ attached: false, reason: "no_deal" });
    expect(await attachQuoteSummaryToDeal(app({ quoteLines: [] }))).toEqual({ attached: false, reason: "no_quote" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
