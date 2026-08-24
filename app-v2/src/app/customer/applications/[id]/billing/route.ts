import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { getQuoteSnapshot } from "@/lib/adapters/hubspot";
import type { HubspotIds } from "@/types/merchant";

// "Review & Pay" target — the customer's route to the HubSpot hosted checkout.
//
// ⚠️ THIS ROUTE DELIBERATELY DOES NOT MINT A FRESH LINK PER CLICK, unlike its
// two siblings (../continue for Adyen, ../payroll/continue for Check). Do not
// "fix" it to match them. hs_quote_link is not a one-time-use bearer artifact:
//
//   - it is `https://customers.aioapp.com/{hs_slug}`, and the slug exists at
//     create time, so the URL is PREDICTABLE. A one-time credential cannot be.
//   - buyer auth on it is `hs_quote_auth_method: public_access` — a public,
//     shareable URL, which is by definition re-servable, and is already how AIO
//     shares quotes today.
//   - it has no short fuse. Adyen's link is ~4 minutes and single-use, Check's
//     is 24h and single-use; re-serving either lands the merchant on an error
//     page. Verified in the live portal: a quote link kept taking payment 8 days
//     PAST its hs_expiration_date, so there is deliberately no expiry check
//     here either — expiry gates acceptance, not post-acceptance settlement.
//
// So the body is READ-OR-REFRESH, not mint. The only staleness risk is a slug
// HubSpot rotated, which the nightly /api/cron/hubspot-billing-sync re-read
// self-heals within a day, and a null link self-heals immediately below.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user || session.user.role !== "customer") {
    return NextResponse.redirect(new URL("/customer/login", req.url));
  }

  const app = await postgresStorage.getApplicationForCustomer(session.user.id, id);
  if (!app) {
    return NextResponse.redirect(new URL("/customer", req.url));
  }

  const back = (error: string) =>
    NextResponse.redirect(new URL(`/customer/applications/${id}?error=${error}`, req.url));

  const hubspotIds = app.hubspotIds;
  // publishedAt is THE one-way-door marker: null means the quote is still a
  // DRAFT. A draft's checkout link is never surfaced — the rep hasn't sent it
  // yet, and the quote is still editable from EasyOB.
  if (!hubspotIds?.quoteId || !hubspotIds.publishedAt) {
    return back("quote_not_ready");
  }

  if (hubspotIds.quoteLink) {
    return NextResponse.redirect(hubspotIds.quoteLink);
  }

  // Null link on a published quote means publish's read-after-write came back
  // empty (hs_quote_link populates ~3s after the publish PATCH lands). Re-read
  // once, on demand, rather than making the customer wait for the nightly cron.
  try {
    const snapshot = await getQuoteSnapshot(hubspotIds.quoteId);
    if (!snapshot?.quoteLink) {
      throw new Error(
        snapshot
          ? `quote ${hubspotIds.quoteId} has no hs_quote_link`
          : `quote ${hubspotIds.quoteId} not found in HubSpot`
      );
    }

    await postgresStorage.updateApplicationAsCustomer(session.user.id, id, {
      hubspotIds: {
        ...hubspotIds,
        quoteLink: snapshot.quoteLink,
        paymentStatus: snapshot.paymentStatus,
        paymentDate: snapshot.paymentDate,
        syncedAt: new Date().toISOString(),
        lastSyncError: null,
        lastSyncErrorAt: null,
      },
    });
    return NextResponse.redirect(snapshot.quoteLink);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Failed to resolve HubSpot quote link:", message);
    // The customer gets a neutral code — never a raw HubSpot error — but the
    // failure is also PERSISTED so a rep can see the account is stuck. The deal
    // sync failed silently for the whole life of that feature precisely because
    // a console.error was the only record it left.
    await persistSyncError(session.user.id, id, hubspotIds, message);
    return back("billing_link");
  }
}

// Best-effort: this runs on an already-failed path, so a write failure here
// must not turn a redirect-with-an-error-code into a 500 for the customer.
async function persistSyncError(
  userId: string,
  id: string,
  hubspotIds: HubspotIds,
  message: string
): Promise<void> {
  try {
    await postgresStorage.updateApplicationAsCustomer(userId, id, {
      hubspotIds: { ...hubspotIds, lastSyncError: message, lastSyncErrorAt: new Date().toISOString() },
    });
  } catch (err) {
    console.error("Failed to persist HubSpot sync error:", err instanceof Error ? err.message : err);
  }
}
