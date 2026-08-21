import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications, customerLoginTokens } from "@/lib/db/schema";
import { sendMagicLinkEmail } from "@/lib/adapters/email";
import { shouldAdvance } from "@/lib/adapters/adyenWebhook";
import { pushToHubSpot } from "@/lib/adapters/hubspot";
import { hasQuoteBasis } from "@/lib/leadQuote";
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

    // Acceptance is the moment the deal becomes real, so it's the moment it
    // belongs in HubSpot — the push used to happen only when the merchant later
    // submitted the onboarding form, so a merchant who accepted and then stopped
    // at the checklist left no trace in the CRM at all.
    //
    // Fire-and-log, like the pushes in lib/actions/customer.ts: the customer is
    // waiting on their login email, and a HubSpot outage must not cost them the
    // acceptance we've already recorded. pushToHubSpot PATCHes when
    // hubspotDealId is already set, so re-accepting updates rather than duplicates.
    try {
      const dealId = await pushToHubSpot(rowToApp(accepted));
      if (dealId !== accepted.hubspotDealId) {
        await db.update(merchantApplications)
          .set({ hubspotDealId: dealId, updatedAt: new Date() })
          .where(eq(merchantApplications.id, accepted.id));
      }
    } catch (err) {
      console.error("HubSpot deal sync on acceptance failed:", err instanceof Error ? err.message : err);
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
