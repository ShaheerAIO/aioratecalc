import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications, customerLoginTokens } from "@/lib/db/schema";
import { sendMagicLinkEmail } from "@/lib/adapters/email";
import { shouldAdvance } from "@/lib/stages";
import { syncDealFromApplication } from "@/lib/adapters/hubspot";
import { hasQuoteBasis } from "@/lib/leadQuote";
import { rowToApp } from "@/lib/storage/applicationRow";

const TOKEN_TTL_MINUTES = 30;

// Public, unauthenticated by design — same token-is-the-auth model as
// /api/lead/[token]/analyze.
//
// ⚠️ RATE-ONLY QUOTES ONLY. This used to be how EVERY merchant accepted, and
// that was one acceptance too many: a merchant with products on their quote
// accepted here and then accepted AGAIN on HubSpot's hosted page, which is
// where the e-signature and the ACH mandate are actually collected. Entering
// billing details IS accepting the quote, so for those merchants acceptance is
// now DETECTED from HubSpot (lib/billing/acceptance.ts) and this route refuses
// them.
//
// A rate-only quote (empty `quoteLines` — processing margin comes out of Adyen
// settlement, and the catalog's processing products are $0 placeholders)
// creates no HubSpot quote at all. There is no document to sign, no checkout,
// and no subscription that could ever signal acceptance. So those merchants
// keep this button, and it is not redundant for them: it is their only one.
//
// Returns only { sent, devUrl } — no application data crosses back.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const { email } = await req.json();
    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }

    const [row] = await db.select().from(merchantApplications).where(eq(merchantApplications.customerLinkToken, token)).limit(1);
    if (!row || row.customerLinkPurpose !== "lead_upload") {
      return NextResponse.json({ error: "Invalid link" }, { status: 404 });
    }
    if (row.customerLinkExpiresAt && row.customerLinkExpiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: "This link has expired" }, { status: 410 });
    }
    // Nothing to accept until a quote exists on the application. The whole row
    // goes in, not a hand-picked subset: a marketing-only quote's basis is its
    // priced lines, so omitting quoteType/quoteLines here read every such quote
    // as an unrated full_pos one with no volume and refused it as "no quote yet".
    const app = rowToApp(row);
    if (!hasQuoteBasis(app)) {
      return NextResponse.json({ error: "There is no quote on this link yet" }, { status: 409 });
    }

    // The rate-only gate. A quote with billable lines is signed and paid on
    // HubSpot's hosted page; accepting it here would record an acceptance the
    // merchant never made against a mandate they never authorized.
    if ((app.quoteLines?.length ?? 0) > 0) {
      return NextResponse.json({ error: "billed_quote" }, { status: 409 });
    }

    // Acceptance is recorded once. Re-opening an accepted link to get another
    // login email keeps the original timestamp, and the stage move is
    // forward-only (same rule as the Adyen webhook) so a deal already in
    // onboarding is never dragged back to quote_accepted.
    //
    // It is also the FIRST acceptance that creates CRM state, and only it.
    // Re-opening the link and clicking "Email Me a New Link" comes back through
    // this same route (accept and resend are deliberately one call — see
    // LeadQuoteView), and that click means "I lost my login", nothing more. On
    // a row whose first deal push was skipped or failed it used to mint a
    // SECOND, unasked-for deal, leaving the row pointing away from whichever
    // one a rep had since curated. A merchant asking for a login link is not
    // a reason to touch the CRM.
    const firstAcceptance = !row.quoteAcceptedAt;

    const advance = shouldAdvance(row.stage, "quote_accepted");
    let accepted = row;
    if (advance || !row.quoteAcceptedAt) {
      const [updated] = await db.update(merchantApplications)
        .set({
          ...(advance ? { stage: "quote_accepted" as const } : {}),
          quoteAcceptedAt: row.quoteAcceptedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(merchantApplications.id, row.id))
        .returning();
      if (updated) accepted = updated;
    }

    // Acceptance is the moment the deal becomes real in HubSpot's eyes, so
    // it's the moment its stage moves there — the sync used to happen only
    // when the merchant later submitted the onboarding form, so a merchant who
    // accepted and then stopped at the checklist left no trace in the CRM.
    //
    // PATCH-only, and a no-op when there's no deal at all: under the
    // mandatory-deal model every new row is created with `hubspotDealId`
    // already set (`createProspectAction` resolves it through
    // `resolveDealForCompany` before the row ever exists), so this is only
    // ever skipped for a legacy row from before deal adoption existed.
    // Recovery for one of those is `adoptDealAction`/`linkTenantCompanyAction`,
    // never this route minting a deal on the fly.
    //
    // Fire-and-log, like the syncs in lib/actions/customer.ts: the customer is
    // waiting on their login email, and a HubSpot outage must not cost them the
    // acceptance we've already recorded.
    if (firstAcceptance && accepted.hubspotDealId) {
      try {
        await syncDealFromApplication(rowToApp(accepted));
      } catch (err) {
        console.error("HubSpot deal sync on acceptance failed:", err instanceof Error ? err.message : err);
      }
    }

    const loginToken = randomUUID();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);
    await db.insert(customerLoginTokens).values({
      email,
      token: loginToken,
      applicationId: row.id,
      expiresAt,
    });

    const base = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const result = await sendMagicLinkEmail(email, `${base}/api/customer/verify?token=${loginToken}`);

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not accept the quote";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
