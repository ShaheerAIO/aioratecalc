import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { analyzeStatement } from "@/lib/claude";
import { shouldAdvance } from "@/lib/stages";
import { buildCustomerSafeQuote } from "@/lib/leadQuote";
import { isProcessingQuote, quoteTypeOf } from "@/lib/quoting";
import type { StatementAnalysis } from "@/types/merchant";

// Public, unauthenticated by design — the token itself (time-limited,
// single-purpose) is the auth. Deliberately separate from /api/analyze so
// the "customer never sees internals" guarantee is enforced in exactly one
// place: this route only ever returns a CustomerSafeQuote, never the raw
// StatementAnalysis or any cost/margin breakdown.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const { fileData, mediaType } = await req.json();
    if (!fileData || !mediaType) {
      return NextResponse.json({ error: "fileData and mediaType are required" }, { status: 400 });
    }

    const [row] = await db.select().from(merchantApplications).where(eq(merchantApplications.customerLinkToken, token)).limit(1);
    if (!row || row.customerLinkPurpose !== "lead_upload") {
      return NextResponse.json({ error: "Invalid link" }, { status: 404 });
    }
    if (row.customerLinkExpiresAt && row.customerLinkExpiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: "This link has expired" }, { status: 410 });
    }

    // A marketing-only quote has no processing behind it, so there is nothing a
    // statement could price. The lead page offers no upload on such a quote;
    // this refuses the request outright rather than burning a Claude call and
    // storing an analysis the quote would ignore.
    if (!isProcessingQuote(quoteTypeOf(row.quoteType))) {
      return NextResponse.json(
        { error: "This quote doesn't include payment processing, so there's nothing to compare a statement against." },
        { status: 409 }
      );
    }

    const quoteFrom = (analysis: StatementAnalysis | null) =>
      // Same projection the prepared-quote render on /lead/[token] uses, so the
      // customer-safe boundary is one function rather than two implementations.
      buildCustomerSafeQuote({
        quoteType: row.quoteType,
        analysis,
        quoteConfig: row.quoteConfig,
        targetMargin: row.targetMargin != null ? Number(row.targetMargin) : null,
        pricingModel: row.pricingModel,
        quoteLines: row.quoteLines,
        orderPoints: row.orderPoints,
      });

    // Once the customer has accepted, the quote's basis is frozen. The link
    // stays live for the rest of its TTL, so without this a re-opened link
    // could replace the analysis the accepted quote was priced on — and drag
    // an onboarding deal back to `analysis`. Checked before Claude is called.
    if (row.quoteAcceptedAt || !shouldAdvance(row.stage, "quote_accepted")) {
      const accepted = quoteFrom(row.analysis);
      if (!accepted) {
        return NextResponse.json({ error: "This quote has already been accepted" }, { status: 409 });
      }
      return NextResponse.json({ quote: accepted, accepted: true });
    }

    const analysis: StatementAnalysis = await analyzeStatement(fileData, mediaType);

    const quote = quoteFrom(analysis);
    if (!quote) {
      return NextResponse.json({ error: "We couldn't read a monthly volume off that statement" }, { status: 422 });
    }

    // Forward-only, same rule as the accept route and the Adyen webhook.
    await db.update(merchantApplications)
      .set({
        analysis,
        ...(shouldAdvance(row.stage, "analysis") ? { stage: "analysis" as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(merchantApplications.id, row.id));

    return NextResponse.json({ quote });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
