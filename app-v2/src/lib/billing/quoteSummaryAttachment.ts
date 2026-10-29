// At acceptance, file the merchant's quote summary as a PDF on the HubSpot
// deal (product owner, 2026-10-29). BEST-EFFORT and NEVER THROWS: the
// acceptance is already committed when this runs, and a missing attachment
// must never un-accept a merchant or hold up their account email. Every
// failure is logged and nothing else.
//
// Not persisted, and not deduplicated here: both callers only reach it ONCE
// per application — `recordAcceptance` after winning its conditional
// `quoteAcceptedAt` write (a losing observer returns before this), and the
// rate-only accept route on `firstAcceptance` only. A retried acceptance
// therefore never files a second copy, and a failed one is not retried.

import { fileDealPdf } from "@/lib/adapters/hubspotFiles";
import { buildCustomerSafeQuote } from "@/lib/leadQuote";
import { quoteSummaryFileName, renderQuoteSummaryPdf } from "@/lib/quoteSummaryPdf";
import type { MerchantApplication } from "@/types/merchant";

export type QuoteSummaryAttachResult =
  | { attached: true; fileId: string; noteId: string }
  | { attached: false; reason: "no_deal" | "no_quote" | "failed" };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function attachQuoteSummaryToDeal(app: MerchantApplication): Promise<QuoteSummaryAttachResult> {
  const dealId = app.hubspotDealId;
  if (!dealId) return { attached: false, reason: "no_deal" };

  try {
    // The same projection the merchant's quote page renders — customer-safe
    // by construction, so nothing internal can reach the PDF.
    const quote = buildCustomerSafeQuote(app);
    if (!quote) return { attached: false, reason: "no_quote" };

    const businessName = app.business?.dba || app.business?.legalName || null;
    const bytes = await renderQuoteSummaryPdf({ quote, businessName, acceptedAt: app.quoteAcceptedAt });
    const { fileId, noteId } = await fileDealPdf({
      dealId,
      fileName: quoteSummaryFileName(businessName),
      bytes,
      noteBody: `Quote summary as accepted by ${escapeHtml(businessName || "the customer")}. Attached as a PDF.`,
    });
    return { attached: true, fileId, noteId };
  } catch (err) {
    console.error(
      `[quote-summary] ${app.id}: could not attach the quote summary to deal ${dealId}`,
      err instanceof Error ? err.message : err,
    );
    return { attached: false, reason: "failed" };
  }
}
