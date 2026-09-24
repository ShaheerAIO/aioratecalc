import { NextRequest, NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import {
  findSubscriptionsForQuote,
  listQuotesModifiedSince,
  type QuoteSnapshot,
} from "@/lib/adapters/hubspot";
import { applyDetectedAcceptance } from "@/lib/billing/acceptance";
import { rowToApp, type ApplicationRow as FullApplicationRow } from "@/lib/storage/applicationRow";
import { rollUpSubscriptionStatus, type HubspotIds, type HubspotSubscriptionSnapshot } from "@/types/merchant";

// Phase E nightly billing reconciliation: the backstop behind the on-view
// refresh in src/lib/actions/customer.ts. Nothing pushes to EasyOB, so a
// customer who pays and never opens their application again would otherwise
// leave the CRM snapshot stale forever.
//
// A SIBLING of /api/cron/hubspot-links, not a second step bolted onto it — the
// same process-isolation argument that route documents at its lines 5-11
// applies here: separate Vercel Functions mean one job's HubSpot failure or
// duration can't affect the other's schedule.
//
// It is ALSO the backstop that detects acceptance. Since the merchant no
// longer accepts inside EasyOB — they sign and pay on HubSpot's hosted quote —
// the subscription this job reads is the only record that it happened, for a
// merchant who has no EasyOB account yet and therefore no on-view refresh of
// their own. See lib/billing/acceptance.ts.
export const maxDuration = 300;

// The window is STATELESS — `now - LOOKBACK_DAYS`, recomputed every run, no
// cursor table (therefore no migration) and a missed night self-heals on the
// next one. Same philosophy as expectedReportFilenames() in
// src/lib/adyen/reportWindow.ts.
//
// TEN days, not the three the spec proposed. ACH settlement takes 5.6–6.0 days,
// so a quote's flip to PAID routinely lands more than 3 days after anything
// else touched the record, and a 3-day window would miss that flip PERMANENTLY
// (the cron is the only thing that would ever catch it for a customer who
// stopped visiting). The cost of the wider window is negligible: a 3-day
// hs_lastmodifieddate filter returns 17 records portal-wide today, so 10 days
// is still one or two pages of search results.
const LOOKBACK_DAYS = 10;

// The whole row, not a two-column projection: `applyDetectedAcceptance` needs
// the deal id, the stage and the contact email to record an acceptance.
type ApplicationRow = FullApplicationRow;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron hubspot-billing-sync] CRON_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 401 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let quotes: QuoteSnapshot[];
  try {
    quotes = await listQuotesModifiedSince(since);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[cron hubspot-billing-sync] listQuotesModifiedSince failed", error);
    return NextResponse.json({ error }, { status: 500 });
  }

  const byQuoteId = new Map(quotes.map(q => [q.quoteId, q]));
  const summary = {
    quotesChecked: quotes.length,
    applicationsUpdated: 0,
    accepted: 0,
    subscriptionsMatched: 0,
    unmatched: [] as string[],
    failed: [] as { applicationId: string; error: string }[],
  };
  if (byQuoteId.size === 0) return NextResponse.json(summary);

  // Join back on the quote id inside the jsonb blob. Most changed quotes in the
  // portal belong to deals EasyOB never built, so unmatched is the normal case,
  // not an error.
  const rows: ApplicationRow[] = await db
    .select()
    .from(merchantApplications)
    .where(inArray(sql`${merchantApplications.hubspotIds}->>'quoteId'`, [...byQuoteId.keys()]));

  const matchedQuoteIds = new Set<string>();

  for (const row of rows) {
    const hubspotIds = row.hubspotIds;
    const quoteId = hubspotIds?.quoteId;
    const snapshot = quoteId ? byQuoteId.get(quoteId) : undefined;
    if (!hubspotIds || !quoteId || !snapshot) continue;
    matchedQuoteIds.add(quoteId);

    try {
      const subscriptions = await findSubscriptionsForQuote(quoteId);
      summary.subscriptionsMatched += subscriptions.length;

      const next: HubspotIds = {
        ...hubspotIds,
        // A rotated or newly-populated slug self-heals here; an empty read never
        // erases a link that works.
        quoteLink: snapshot.quoteLink ?? hubspotIds.quoteLink,
        paymentStatus: snapshot.paymentStatus,
        paymentDate: snapshot.paymentDate,
        subscriptions,
        subscriptionStatus: rollUpSubscriptionStatus(subscriptions),
        lastSyncError: null,
        lastSyncErrorAt: null,
      };

      // Only write rows whose snapshot actually moved. Unlike the on-view
      // refresh — where syncedAt is a TTL that has to be bumped on every read —
      // nothing here depends on syncedAt advancing, so an unchanged row is left
      // completely alone rather than churning updatedAt across the whole table
      // every night.
      if (snapshotChanged(hubspotIds, next)) {
        await db
          .update(merchantApplications)
          .set({ hubspotIds: { ...next, syncedAt: new Date().toISOString() }, updatedAt: new Date() })
          .where(eq(merchantApplications.id, row.id));
        summary.applicationsUpdated++;
      }

      // AFTER the snapshot write, and outside the changed-check: a run that
      // finds nothing new in the snapshot can still be the first run to look at
      // a row whose acceptance was never recorded (an earlier run that crashed
      // between the two writes, or a row whose subscription was already cached
      // by the on-view refresh). Idempotent either way — see acceptance.ts.
      const before = rowToApp({ ...row, hubspotIds: next });
      const after = await applyDetectedAcceptance(before);
      if (!before.quoteAcceptedAt && after.quoteAcceptedAt) summary.accepted++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[cron hubspot-billing-sync] application ${row.id} failed`, error);
      summary.failed.push({ applicationId: row.id, error });
      // Persisted, not merely logged: a per-application failure that lives only
      // in a Vercel log is a stuck account nobody finds.
      try {
        await db
          .update(merchantApplications)
          .set({
            hubspotIds: { ...hubspotIds, lastSyncError: error, lastSyncErrorAt: new Date().toISOString() },
            updatedAt: new Date(),
          })
          .where(eq(merchantApplications.id, row.id));
      } catch (writeErr) {
        console.error(
          `[cron hubspot-billing-sync] could not persist error for ${row.id}`,
          writeErr instanceof Error ? writeErr.message : writeErr
        );
      }
    }
  }

  for (const quoteId of byQuoteId.keys()) {
    if (!matchedQuoteIds.has(quoteId)) summary.unmatched.push(quoteId);
  }

  return NextResponse.json(summary, { status: summary.failed.length > 0 ? 500 : 200 });
}

// Compares only the snapshot fields, never syncedAt (which always differs).
function snapshotChanged(current: HubspotIds, next: HubspotIds): boolean {
  return (
    current.quoteLink !== next.quoteLink ||
    current.paymentStatus !== next.paymentStatus ||
    current.paymentDate !== next.paymentDate ||
    current.subscriptionStatus !== next.subscriptionStatus ||
    current.lastSyncError !== next.lastSyncError ||
    !sameSubscriptions(current.subscriptions, next.subscriptions)
  );
}

function sameSubscriptions(
  a: HubspotSubscriptionSnapshot[] | null,
  b: HubspotSubscriptionSnapshot[] | null
): boolean {
  if (a === null || b === null) return a === b; // null → [] is a real change: we've now looked
  if (a.length !== b.length) return false;
  // Keyed by id rather than position — a batch read's ordering isn't contractual.
  const byId = new Map(a.map(s => [s.subscriptionId, s]));
  return b.every(sub => {
    const prev = byId.get(sub.subscriptionId);
    return prev !== undefined && sameSubscription(prev, sub);
  });
}

// Field-by-field, deliberately NOT a JSON.stringify comparison: `current` came
// back out of a jsonb column, and Postgres reorders jsonb keys, so two identical
// snapshots serialize to different strings and every row would look changed
// every night.
function sameSubscription(a: HubspotSubscriptionSnapshot, b: HubspotSubscriptionSnapshot): boolean {
  return (
    a.status === b.status &&
    a.paymentMethod === b.paymentMethod &&
    a.billingFrequency === b.billingFrequency &&
    a.billingStartDate === b.billingStartDate &&
    a.mrr === b.mrr &&
    a.nextPaymentDueDate === b.nextPaymentDueDate &&
    a.lastPaymentStatus === b.lastPaymentStatus &&
    a.completedPayments === b.completedPayments &&
    a.totalCollected === b.totalCollected
  );
}
