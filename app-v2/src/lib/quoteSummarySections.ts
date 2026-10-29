// The bits of the customer quote summary that BOTH renderings share: the
// on-screen QuoteSummary.tsx and the PDF filed on the deal at acceptance
// (quoteSummaryPdf.ts). One copy, so the two can't drift. Pure and
// client-safe (quoting.ts and utils.ts are both client-importable).

import { PAYROLL_PRODUCT_ID, lineNetAmount } from "@/lib/quoting";
import { monthlyEquivalent } from "@/lib/utils";
import type { CustomerSafeQuote, QuoteLine } from "@/types/merchant";

// Display-only (product owner, 2026-10-29): the HubSpot product keeps its name.
export const displayName = (l: QuoteLine) => l.name.replace(/Additional Software License/g, "Additional License");

export type RecurringTotals = {
  recurring: { frequency: QuoteLine["billingFrequency"]; amount: number }[];
  monthlyEquivalent: number;
};

const sumMonthly = (ls: QuoteLine[]) => ls.reduce((n, l) => n + monthlyEquivalent(lineNetAmount(l), l.billingFrequency), 0);

function sumByFrequency(ls: QuoteLine[]): RecurringTotals["recurring"] {
  const out: RecurringTotals["recurring"] = [];
  for (const l of ls) {
    const f = out.find(r => r.frequency === l.billingFrequency);
    if (f) f.amount += lineNetAmount(l); else out.push({ frequency: l.billingFrequency, amount: lineNetAmount(l) });
  }
  return out;
}

/**
 * The recurring lines split into the Software box and the Payroll box.
 *
 * Payroll is its own box, not part of the Software subscription (product
 * owner, 2026-10-29). Identified by the shared product id, not by name. The
 * server's totals cover every recurring line: with no payroll they are used as
 * sent; otherwise each box is totalled from its own lines. `softwareTotals` is
 * null only when the quote has no `lineTotals` and no payroll.
 */
export function splitRecurringLines(quote: Pick<CustomerSafeQuote, "lines" | "lineTotals">): {
  allRecurringLines: QuoteLine[];
  softwareLines: QuoteLine[];
  payrollLines: QuoteLine[];
  softwareTotals: RecurringTotals | null;
  payrollTotals: RecurringTotals;
} {
  const allRecurringLines = quote.lines.filter(l => l.billingFrequency !== "one_time");
  const payrollLines = allRecurringLines.filter(l => l.hubspotProductId === PAYROLL_PRODUCT_ID);
  const softwareLines = allRecurringLines.filter(l => l.hubspotProductId !== PAYROLL_PRODUCT_ID);
  const softwareTotals = payrollLines.length > 0
    ? { recurring: sumByFrequency(softwareLines), monthlyEquivalent: sumMonthly(softwareLines) }
    : quote.lineTotals
      ? { recurring: quote.lineTotals.recurring, monthlyEquivalent: quote.lineTotals.monthlyEquivalent }
      : null;
  const payrollTotals = { recurring: sumByFrequency(payrollLines), monthlyEquivalent: sumMonthly(payrollLines) };
  return { allRecurringLines, softwareLines, payrollLines, softwareTotals, payrollTotals };
}
