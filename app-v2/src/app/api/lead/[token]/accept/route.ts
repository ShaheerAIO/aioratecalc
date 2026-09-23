import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications, customerLoginTokens } from "@/lib/db/schema";
import { sendMagicLinkEmail } from "@/lib/adapters/email";
import { shouldAdvance } from "@/lib/stages";
import { syncDealFromApplication } from "@/lib/adapters/hubspot";
import { buildAndPublishBillingQuote } from "@/lib/billing/publishBillingQuote";
import { hasQuoteBasis } from "@/lib/leadQuote";
import { isDemoHeld } from "@/lib/demo";
import { rowToApp } from "@/lib/storage/applicationRow";

const TOKEN_TTL_MINUTES = 30;

// Public, unauthenticated by design — same token-is-the-auth model as
// /api/lead/[token]/analyze. The customer's explicit acceptance of the quote:
// records it on the application, advances the deal stage, and issues the
// short-lived magic-link login token that carries them into the existing
// account-creation flow (verify → set-password → checklist).
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
    // The quote is withheld until the demo is held — same rule as the
    // checklist page and /lead/[token]/quote, and enforced here too because
    // acceptance is itself a disclosure: accepting freezes (and later
    // publishes) a quote the customer isn't supposed to have seen yet. A
    // customer who never got past the checklist gate has no legitimate way to
    // reach this route pre-demo, so this is a backstop, not the primary gate.
    if (!isDemoHeld(row.demo)) {
      return NextResponse.json({ error: "demo_not_held" }, { status: 409 });
    }
    // Nothing to accept until a quote exists on the application. The whole row
    // goes in, not a hand-picked subset: a marketing-only quote's basis is its
    // priced lines, so omitting quoteType/quoteLines here read every such quote
    // as an unrated full_pos one with no volume and refused it as "no quote yet".
    const app = rowToApp(row);
    if (!hasQuoteBasis(app)) {
      return NextResponse.json({ error: "There is no quote on this link yet" }, { status: 409 });
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
    // one a rep had since curated. Recovery from a failed first push is
    // `retryBillingQuoteAction`, which says what it does; a merchant asking for
    // a login link is not it.
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

    // Phase E — build AND publish the HubSpot billing quote, so the checkout
    // link is waiting on the merchant's checklist by the time they log in.
    //
    // AFTER the magic-link send, deliberately: the customer is sitting on a
    // spinner waiting for that email, and this is ~8-12 HubSpot calls plus a
    // ~3s read-after-write for hs_quote_link. Nothing here may delay it.
    //
    // In its own try/catch, equally deliberately: a billing failure must never
    // fail the acceptance. The acceptance is already recorded and the email
    // already sent, the customer sees "check your inbox" either way, and the
    // rep picks the stuck account up from hubspotIds.lastSyncError — which the
    // orchestrator persists rather than only logging.
    //
    // First acceptance only, like the deal push above: a re-opened link is a
    // login-link resend, and the build is idempotent but not free (it claims a
    // build lease and can leave a spurious refusal on the row).
    if (firstAcceptance) {
      try {
        const outcome = await buildAndPublishBillingQuote(rowToApp(accepted), { acceptedByEmail: email });
        if (outcome.status === "published") {
          console.log(`[billing] ${accepted.id}: quote ${outcome.quoteId} published${outcome.alreadyPublished ? " (was already published)" : ""}`);
        } else if (outcome.status === "refused") {
          console.warn(`[billing] ${accepted.id}: refused — ${outcome.reasons.map(r => r.code).join(", ")}`);
        } else if (outcome.status === "failed") {
          console.error(`[billing] ${accepted.id}: ${outcome.step} failed — ${outcome.error}`);
        } else {
          console.log(`[billing] ${accepted.id}: skipped (${outcome.reason})`);
        }
      } catch (err) {
        console.error("HubSpot billing quote on acceptance failed:", err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not accept the quote";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
