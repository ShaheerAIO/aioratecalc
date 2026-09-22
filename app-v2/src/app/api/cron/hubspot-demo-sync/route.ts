import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { getDealById, listMeetingsForDeal, listDemoMeetingsForCompany } from "@/lib/adapters/hubspot";
import { deriveDemoState } from "@/lib/demo";
import type { DemoState } from "@/types/merchant";

// Nightly backstop behind the on-view refresh in src/lib/actions/customer.ts
// (refreshDemoStatus): a merchant who never revisits their application page,
// or a rep who never opens the account, would otherwise leave a held demo
// undetected forever — and the demo gate decides whether billing is even
// shown, so a stuck demo silently stalls billing behind it too.
//
// A SIBLING of /api/cron/hubspot-billing-sync and /api/cron/hubspot-links, not
// a step folded into either — same process-isolation argument both of those
// routes already make (see hubspot-links/route.ts:5-11): a HubSpot outage or
// slow run in one job must not affect another job's schedule or duration.
export const maxDuration = 300;

// Hard cap on how many accounts one nightly run touches. See the report this
// action was asked to produce for the observed candidate count.
const ROW_CAP = 200;

// Paces requests so a run of up to ROW_CAP rows (each up to 3 HubSpot reads —
// the deal, its meetings, and, only when the deal carries none, the company's)
// doesn't trip a rate limit. Mirrors REQUEST_SPACING_MS in adapters/hubspot.ts;
// redefined here since that one isn't exported.
const REQUEST_SPACING_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const EMPTY_DEMO_STATE: DemoState = {
  bookedAt: null, heldAt: null, source: null,
  meetingId: null, meetingTitle: null, outcome: null,
  markedByUserId: null, checkedAt: null,
  lastSyncError: null, lastSyncErrorAt: null,
};

// Compares only the fields a rep/merchant would notice — never `checkedAt`,
// which legitimately differs on every run whether or not anything else moved.
// Same reasoning as hubspot-billing-sync/route.ts's snapshotChanged: only
// write rows that actually moved, so a nightly sweep doesn't churn updatedAt
// across every candidate whether or not anything changed.
function demoChanged(prev: DemoState, next: DemoState): boolean {
  return (
    prev.bookedAt !== next.bookedAt ||
    prev.heldAt !== next.heldAt ||
    prev.source !== next.source ||
    prev.meetingId !== next.meetingId ||
    prev.meetingTitle !== next.meetingTitle ||
    prev.outcome !== next.outcome ||
    prev.lastSyncError !== next.lastSyncError
  );
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron hubspot-demo-sync] CRON_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 401 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Candidates: has a deal to check against, isn't already terminal (a held
  // demo never needs re-reading — deriveDemoState's rule 1), and sits in a
  // stage where a demo is still meaningful. closed_lost can't unblock
  // anything further; adyen_approved has already cleared onboarding, well
  // past the point the demo gate matters.
  const candidates = await db
    .select({
      id: merchantApplications.id,
      hubspotDealId: merchantApplications.hubspotDealId,
      tenantLink: merchantApplications.tenantLink,
      demo: merchantApplications.demo,
    })
    .from(merchantApplications)
    .where(and(
      isNotNull(merchantApplications.hubspotDealId),
      sql`(${merchantApplications.demo} IS NULL OR ${merchantApplications.demo}->>'heldAt' IS NULL)`,
      notInArray(merchantApplications.stage, ["closed_lost", "adyen_approved"]),
    ))
    .limit(ROW_CAP);

  const summary = {
    candidates: candidates.length,
    updated: 0,
    failed: [] as { applicationId: string; error: string }[],
  };

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    const dealId = row.hubspotDealId;
    if (!dealId) continue; // can't actually happen — narrows the isNotNull filter above for TS

    const prev = row.demo ?? EMPTY_DEMO_STATE;
    try {
      const [deal, dealMeetings] = await Promise.all([
        getDealById(dealId),
        listMeetingsForDeal(dealId),
      ]);
      const companyId = row.tenantLink?.hubspotCompanyId ?? null;
      const companyMeetings = companyId ? await listDemoMeetingsForCompany(companyId) : [];

      const next = deriveDemoState({
        dealMeetings,
        companyMeetings,
        dealCreatedAt: deal?.createdAt ?? null,
        previous: row.demo,
        nowMs: Date.now(),
      });

      if (demoChanged(prev, next)) {
        await db.update(merchantApplications)
          .set({ demo: next, updatedAt: new Date() })
          .where(eq(merchantApplications.id, row.id));
        summary.updated++;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[cron hubspot-demo-sync] application ${row.id} failed`, error);
      summary.failed.push({ applicationId: row.id, error });
      // Persisted, not merely logged: a per-application failure that lives only
      // in a Vercel log is a stuck account nobody finds.
      try {
        await db.update(merchantApplications)
          .set({
            demo: { ...prev, lastSyncError: error, lastSyncErrorAt: new Date().toISOString() },
            updatedAt: new Date(),
          })
          .where(eq(merchantApplications.id, row.id));
      } catch (writeErr) {
        console.error(
          `[cron hubspot-demo-sync] could not persist error for ${row.id}`,
          writeErr instanceof Error ? writeErr.message : writeErr
        );
      }
    }

    if (i + 1 < candidates.length) await sleep(REQUEST_SPACING_MS);
  }

  return NextResponse.json(summary, { status: summary.failed.length > 0 ? 500 : 200 });
}
