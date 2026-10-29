// The customer's quote summary as a PDF, filed on the HubSpot deal when the
// merchant accepts (product owner, 2026-10-29: "print summary, add it to deal
// attachment"). The merchant's own printed copy comes from the browser
// (window.print on /lead/[token]/quote); this is the server-side twin, built
// from the SAME projection — `buildCustomerSafeQuote` — so it can carry
// nothing a customer could not already see: no Adyen cost, no margin, no
// floor, no commission. Those are not in a CustomerSafeQuote to begin with.
//
// pdf-lib, not headless Chromium: pure JS, no native binary, no font files to
// ship (the 14 standard PDF fonts are built in), so it runs unchanged in a
// Vercel Node function and in vitest. The cost is that this lays the summary
// out itself rather than rendering QuoteSummary.tsx's HTML — a plain
// text-and-amounts document, not a pixel copy of the page.
//
// Split in two so the content is testable without parsing a PDF:
// `quoteSummarySections` decides WHAT is on it (pure), `renderQuoteSummaryPdf`
// only draws it.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { lineDescription } from "@/lib/lineDescriptions";
import {
  CHANNEL_LABELS, CHARGEBACK_FEE, RETRIEVAL_FEE, describeBillingStart, isInvoicedLine, lineListAmount, lineNetAmount,
} from "@/lib/quoting";
import { displayName, splitRecurringLines, type RecurringTotals } from "@/lib/quoteSummarySections";
import { fmt$, fmt$0, fmtCycle, fmtFrequency, fmtPct2, monthlyEquivalent } from "@/lib/utils";
import type { CustomerSafeQuote, QuoteLine } from "@/types/merchant";

export type SummaryRow = {
  label: string;
  value?: string;
  /** Smaller grey lines under the label: description, discount, billing start. */
  notes?: string[];
  /** A total row is drawn bold, with a rule above it. */
  total?: boolean;
};

export type SummarySection = { title: string; rows: SummaryRow[] };

const lineLabel = (l: QuoteLine) => `${displayName(l)}${l.qty > 1 ? ` ×${l.qty}` : ""}`;
const isDiscounted = (l: QuoteLine) => (l.discountPercent ?? 0) > 0 || (l.discountAmount ?? 0) > 0;

// Same wording as the on-screen summary: a cash discount reads as the dollars
// agreed, 100% reads as "Included".
function discountLabel(l: QuoteLine): string {
  if (l.discountPercent === 100) return "Included";
  if ((l.discountAmount ?? 0) > 0) return `${fmt$(l.discountAmount!)} off`;
  return `${l.discountPercent}% off`;
}

function oneTimeRow(l: QuoteLine): SummaryRow {
  const notes: string[] = [];
  const desc = lineDescription(l.hubspotProductId);
  if (desc) notes.push(desc);
  if (l.coveredByPackage) {
    notes.push(`List ${fmt$(lineListAmount(l))}`);
    return { label: lineLabel(l), value: "Included", notes };
  }
  if (isDiscounted(l)) notes.push(`List ${fmt$(lineListAmount(l))}, ${discountLabel(l)}`);
  return { label: lineLabel(l), value: fmt$(lineNetAmount(l)), notes };
}

function recurringRow(l: QuoteLine): SummaryRow {
  const net = lineNetAmount(l);
  const notes: string[] = [];
  const desc = lineDescription(l.hubspotProductId);
  if (desc) notes.push(desc);
  if (l.billingStart) notes.push(describeBillingStart(l.billingStart));
  if (isDiscounted(l)) notes.push(`List ${fmt$(lineListAmount(l))}/${fmtCycle(l.billingFrequency)}, ${discountLabel(l)}`);
  if (l.billingFrequency !== "monthly") notes.push(`About ${fmt$(monthlyEquivalent(net, l.billingFrequency))}/mo`);
  return { label: lineLabel(l), value: `${fmt$(net)}/${fmtCycle(l.billingFrequency)}`, notes };
}

function monthlyTotalRow(t: RecurringTotals): SummaryRow {
  const allMonthly = t.recurring.every(r => r.frequency === "monthly");
  return { label: allMonthly ? "Monthly total" : "Monthly equivalent", value: `${fmt$(t.monthlyEquivalent)}/mo`, total: true };
}

/**
 * What the summary says, section by section. Mirrors the grouping of the
 * on-screen QuoteSummary: recurring software, payroll in its own box,
 * anything the checkout itself takes, the one-time lines (with package-covered items under their own
 * heading), then the payment rates. Totals come from the server-computed
 * `lineTotals`, so "never sum across billing frequencies" keeps one owner.
 */
export function quoteSummarySections(quote: CustomerSafeQuote): SummarySection[] {
  const sections: SummarySection[] = [];
  const invoiced = quote.oneTimeInvoiced;

  if (quote.orderPoints && quote.orderPoints.total > 0) {
    const channels = (quote.orderPoints.channels ?? [])
      .map(id => CHANNEL_LABELS[id])
      .filter((label): label is string => Boolean(label));
    const n = quote.orderPoints.total;
    sections.push({
      title: "Configuration",
      rows: [{ label: `Configured for ${n} ordering point${n === 1 ? "" : "s"}${channels.length ? ` (${channels.join(", ")})` : ""}.` }],
    });
  }

  if (quote.lines.length > 0 && quote.lineTotals) {
    const totals = quote.lineTotals;
    // Software and Payroll are separate boxes, each with its own total — the
    // same split, from the same module, as the on-screen summary.
    const { softwareLines, payrollLines, softwareTotals, payrollTotals } = splitRecurringLines(quote);
    const oneTime = quote.lines.filter(l => invoiced ? isInvoicedLine(l) : l.billingFrequency === "one_time");
    const checkout = invoiced
      ? quote.lines.filter(l => l.billingFrequency === "one_time" && !isInvoicedLine(l) && lineNetAmount(l) > 0)
      : [];

    if (softwareLines.length > 0 && softwareTotals) {
      const allMonthly = softwareTotals.recurring.every(r => r.frequency === "monthly");
      const rows = softwareLines.map(recurringRow);
      if (!allMonthly) {
        for (const r of softwareTotals.recurring) {
          rows.push({ label: `Total per ${fmtFrequency(r.frequency)}`, value: `${fmt$(r.amount)}/${fmtCycle(r.frequency)}`, total: true });
        }
      }
      rows.push(monthlyTotalRow(softwareTotals));
      sections.push({ title: "Software", rows });
    }

    if (payrollLines.length > 0) {
      sections.push({ title: "Payroll", rows: [...payrollLines.map(recurringRow), monthlyTotalRow(payrollTotals)] });
    }

    if (checkout.length > 0) {
      sections.push({ title: "Due at checkout", rows: checkout.map(oneTimeRow) });
    }

    if (oneTime.length > 0) {
      const rows = oneTime.filter(l => !l.coveredByPackage).map(oneTimeRow);
      const groups = new Map<string, QuoteLine[]>();
      for (const l of oneTime) {
        if (!l.coveredByPackage) continue;
        groups.set(l.coveredByPackage, [...(groups.get(l.coveredByPackage) ?? []), l]);
      }
      for (const [name, lines] of groups) {
        rows.push({ label: `Included in your ${name}:` });
        rows.push(...lines.map(oneTimeRow));
      }
      const invoiceTotal = oneTime.reduce((n, l) => n + lineNetAmount(l), 0);
      rows.push({
        label: invoiced ? "Invoice total" : "Total due once",
        value: fmt$(invoiced ? invoiceTotal : totals.oneTime),
        total: true,
      });
      sections.push({ title: invoiced ? "One-time (invoiced separately)" : "One-time", rows });
    }
  }

  if (quote.payment) {
    const p = quote.payment;
    const fee = `+ ${fmt$(p.perTransactionFee)} per transaction`;
    const rows: SummaryRow[] = [];
    if (p.cardPresentRate !== null) rows.push({ label: "Card present", value: `${fmtPct2(p.cardPresentRate)} ${fee}` });
    // Equal weight, card present first, no headline rate — as on screen.
    rows.push({ label: "Card not present", value: `${fmtPct2(p.cardNotPresentRate)} ${fee}` });
    if (p.monthlyVolume !== null) rows.push({ label: "Monthly card volume", value: fmt$0(p.monthlyVolume) });
    rows.push({ label: "Chargeback fee", value: `${fmt$(CHARGEBACK_FEE)} each` });
    rows.push({ label: "Retrieval fee", value: `${fmt$(RETRIEVAL_FEE)} each` });
    sections.push({ title: "Payment details", rows });
  }

  return sections;
}

export type QuoteSummaryPdfInput = {
  quote: CustomerSafeQuote;
  businessName: string | null;
  /** When the merchant accepted. Printed in the header when known. */
  acceptedAt?: string | Date | null;
};

const FOOTNOTE =
  "Software and one-time charges are listed separately because they bill on different schedules. " +
  "They aren't a single number.";

// Letter, half-inch-and-a-bit margins.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const VALUE_COL_W = 190;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.82, 0.82, 0.85);

// The standard fonts are WinAnsi-encoded and pdf-lib throws on any character
// outside it, so a product name with an arrow or an emoji would fail the whole
// document. Map the few that appear in our own copy, drop the rest.
function makeSanitizer(font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  const MAP: Record<string, string> = { "→": "->", "←": "<-", "≈": "~", " ": " ", "‑": "-" };
  return (text: string) =>
    Array.from(Array.from(text).map(ch => MAP[ch] ?? ch).join(""))
      .filter(ch => ch === " " || supported.has(ch.codePointAt(0)!))
      .join("");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !current) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function fmtDate(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" }).format(date);
}

/** Renders the summary as a PDF. Pure apart from the bytes it returns. */
export async function renderQuoteSummaryPdf(input: QuoteSummaryPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("AIO Quote Summary");
  doc.setAuthor("AIO");
  doc.setCreator("EasyOB");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = makeSanitizer(regular);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const ensure = (height: number) => {
    if (y - height < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };
  const text = (s: string, x: number, size: number, font: PDFFont, color = INK) =>
    page.drawText(s, { x, y, size, font, color });
  const rule = () =>
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.6, color: RULE });

  // Header.
  ensure(60);
  y -= 10;
  text("AIO Quote Summary", MARGIN, 10, bold, MUTED);
  y -= 24;
  for (const l of wrap(clean(input.businessName || "Your Business"), bold, 20, PAGE_W - 2 * MARGIN)) {
    ensure(24);
    text(l, MARGIN, 20, bold);
    y -= 24;
  }
  const accepted = input.acceptedAt ? fmtDate(input.acceptedAt) : "";
  if (accepted) {
    text(`Accepted ${accepted}`, MARGIN, 10, regular, MUTED);
    y -= 14;
  }
  y -= 8;

  const labelW = PAGE_W - 2 * MARGIN - VALUE_COL_W - 12;
  for (const section of quoteSummarySections(input.quote)) {
    ensure(40);
    y -= 12;
    text(clean(section.title), MARGIN, 12, bold);
    y -= 6;
    rule();
    y -= 14;

    for (const row of section.rows) {
      const font = row.total ? bold : regular;
      const labelLines = wrap(clean(row.label), font, 10, row.value ? labelW : PAGE_W - 2 * MARGIN);
      const noteLines = (row.notes ?? []).flatMap(n => wrap(clean(n), regular, 8, labelW));
      ensure(labelLines.length * 13 + noteLines.length * 10 + (row.total ? 6 : 0) + 4);
      if (row.total) {
        y += 4;
        rule();
        y -= 10;
      }
      if (row.value) {
        const value = clean(row.value);
        const w = font.widthOfTextAtSize(value, 10);
        text(value, PAGE_W - MARGIN - w, 10, font);
      }
      for (const l of labelLines) {
        text(l, MARGIN, 10, font);
        y -= 13;
      }
      for (const n of noteLines) {
        text(n, MARGIN + 8, 8, regular, MUTED);
        y -= 10;
      }
      y -= 3;
    }
  }

  if (input.quote.lines.length > 0) {
    y -= 10;
    for (const l of wrap(FOOTNOTE, regular, 8, PAGE_W - 2 * MARGIN)) {
      ensure(10);
      text(l, MARGIN, 8, regular, MUTED);
      y -= 10;
    }
  }

  return doc.save();
}

/**
 * The name the PDF is stored under in HubSpot. From the business name, never
 * anything a browser sent, plus a timestamp so two files can't collide.
 */
export function quoteSummaryFileName(businessName: string | null, now: Date = new Date()): string {
  const safe = (businessName || "Business").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "Business";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `AIO-Quote-Summary-${safe}-${stamp}.pdf`;
}
