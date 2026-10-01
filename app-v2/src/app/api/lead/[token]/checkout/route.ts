import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { rowToApp } from "@/lib/storage/applicationRow";
import { hasQuoteBasis } from "@/lib/leadQuote";
import { ensureDealForPublish } from "@/lib/billing/ensureDeal";
import { buildAndPublishBillingQuote } from "@/lib/billing/publishBillingQuote";
import { EMPTY_HUBSPOT_IDS, type HubspotIds } from "@/types/merchant";

// THE MERCHANT'S OWN DOOR TO BILLING — and the one-way door with it.
//
// Public and unauthenticated by design, same token-is-the-auth model as
// ../analyze and ../accept.
//
// Until 2026-09-25 the HubSpot quote was published by the REP, from a "Send
// Quote to Customer" button, and a merchant who opened their link before that
// click saw "your quote is being finalised" and could do precisely nothing —
// on a link the same rep had already emailed them. The gate was scrapped
// (product-owner decision). The sequence is now:
//
//   receive link → see quote → continue to billing → sign + pay on HubSpot
//   → everything else unlocks
//
// and this route is the third arrow. It builds and publishes the HubSpot quote
// on demand and hands back the hosted URL to redirect to.
//
// WHAT THE MERCHANT IS TOLD FIRST. Publishing cannot be undone — no API edit
// (400 LOCKED), no delete, no void — so the page puts an explicit confirmation
// in front of this call rather than firing it on a stray click. The copy
// speaks to what the merchant actually loses, which is the chance to have the
// pricing changed, not our inability to call an endpoint.
//
// IDEMPOTENT. A second POST on a published quote returns the same link rather
// than attempting a second publish; `buildAndPublishBillingQuote` holds a
// build claim for concurrent ones, and HubSpot answers a duplicate publish 400
// LOCKED, which `publishQuote` already reports as success.
//
// NOTHING FROM canPublishBillingQuote IS EVER SHOWN HERE. Those messages are
// written for the person who can fix them — "Link the tenant company on the
// account", "grant crm.objects.owners.read to the EasyOB Billing private app"
// — and the merchant is not that person and must not read AIO's internals. So
// refusals come back as one neutral code, and the real reasons are persisted
// against the account where a rep will see them.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const lookup = await getLeadApplicationByToken(token);
    if (!lookup.ok) {
      return lookup.reason === "expired"
        ? NextResponse.json({ error: "expired" }, { status: 410 })
        : NextResponse.json({ error: "invalid" }, { status: 404 });
    }

    const app = rowToApp(lookup.row);

    // Already through the door: hand back the link we hold. Re-serving it is
    // safe — hs_quote_link is a predictable public URL, not a one-time bearer
    // artifact (see the header on /customer/applications/[id]/billing).
    if (app.hubspotIds?.publishedAt && app.hubspotIds.quoteLink) {
      return NextResponse.json({ url: app.hubspotIds.quoteLink });
    }

    if (!hasQuoteBasis(app)) {
      return NextResponse.json({ error: "no_quote" }, { status: 409 });
    }

    // A RATE-ONLY quote builds no HubSpot document at all — AIO's margin comes
    // out of Adyen settlement and the catalog's processing products are $0
    // placeholders. There is nothing to sign and nothing to pay, so those
    // merchants accept on the lead page itself, through ../accept. Refused
    // here rather than silently no-op'd, so the page can tell the two apart.
    if ((app.quoteLines?.length ?? 0) === 0) {
      return NextResponse.json({ error: "rate_only" }, { status: 409 });
    }

    // Fill in a missing deal before the preconditions ask for one — see
    // lib/billing/ensureDeal.ts. Shared with the staff escape hatch, so a
    // legacy row is recoverable from either side.
    const dealResult = await ensureDealForPublish(app, app.ownerUserId);
    if (!dealResult.ok) {
      await recordBlocked(
        app.id,
        app.hubspotIds,
        "reasons" in dealResult ? dealResult.reasons.map(r => r.message).join(" ") : dealResult.error
      );
      return NextResponse.json({ error: "not_ready" }, { status: 409 });
    }

    const outcome = await buildAndPublishBillingQuote(dealResult.app);

    switch (outcome.status) {
      case "published":
        // A published quote whose link hasn't populated yet is NOT a failure —
        // hs_quote_link lands ~3s after the publish PATCH and publishQuote
        // already waits once. Say "try again in a moment", because the retry
        // is the idempotent early return at the top of this route.
        return outcome.quoteLink
          ? NextResponse.json({ url: outcome.quoteLink })
          : NextResponse.json({ error: "link_pending" }, { status: 503 });

      case "refused":
        await recordBlocked(app.id, app.hubspotIds, outcome.reasons.map(r => r.message).join(" "));
        return NextResponse.json({ error: "not_ready" }, { status: 409 });

      case "failed":
        // Already persisted by the orchestrator, which names the step.
        return NextResponse.json({ error: "not_ready" }, { status: 502 });

      case "skipped":
        if (outcome.reason === "already_published") {
          // The row was published between the check at the top and here, or
          // its link is still null. Either way the answer is "look again".
          return NextResponse.json({ error: "link_pending" }, { status: 503 });
        }
        if (outcome.reason === "build_in_progress") {
          return NextResponse.json({ error: "link_pending" }, { status: 503 });
        }
        // nothing_to_bill is unreachable (the rate-only gate above) and
        // awaiting_tenant_link means no HubSpot company is linked yet.
        await recordBlocked(app.id, app.hubspotIds, `checkout blocked: ${outcome.reason}`);
        return NextResponse.json({ error: "not_ready" }, { status: 409 });
    }
  } catch (err) {
    console.error("lead checkout failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "not_ready" }, { status: 500 });
  }
}

/**
 * Persist why a merchant could not get to billing, so a rep sees it.
 *
 * `buildAndPublishBillingQuote` deliberately leaves REFUSALS unpersisted — an
 * account waiting on a company link is the normal state of a fresh deal, and
 * counting every one of them as a sync error would drown the admin tripwire in
 * accounts nobody is waiting on.
 *
 * A merchant standing at the door is not that. It is the one moment the wait
 * stops being normal and becomes a customer stuck on a page, so this records
 * it from HERE — at the customer-triggered entry point only — rather than by
 * loosening the orchestrator's rule for everyone.
 *
 * Best-effort: this already runs on a failed path, and a write error here must
 * not turn a 409 the page can explain into a 500 it cannot.
 */
async function recordBlocked(
  applicationId: string,
  hubspotIds: HubspotIds | null,
  detail: string
): Promise<void> {
  try {
    await db
      .update(merchantApplications)
      .set({
        hubspotIds: {
          ...(hubspotIds ?? EMPTY_HUBSPOT_IDS),
          lastSyncError: `The merchant tried to continue to billing and couldn't: ${detail}`,
          lastSyncErrorAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(merchantApplications.id, applicationId));
  } catch (err) {
    console.error("lead checkout: could not persist the blocked state", applicationId, err);
  }
}
