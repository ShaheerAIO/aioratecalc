import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { rowToApp } from "@/lib/storage/applicationRow";
import { aioDashboardEnabled } from "@/lib/adapters/aioDashboard";
import { isReadyForAioProvisioning } from "@/lib/aio/provisioningGate";
import { provisionAioTenant } from "@/lib/aio/provision";

// Creates the merchant's AIO platform tenant once their billing has actually
// been paid, and mints the Adyen KYC link from AIO's own API. EasyOB no longer
// creates Adyen objects itself — that produced accounts misnamed and unlinked
// from the AIO tenant graph.
//
// A SIBLING of the other crons, not a step bolted onto hubspot-billing-sync.
// Two reasons: the process-isolation argument /api/cron/hubspot-links documents
// at its lines 5-11, and more concretely that job's query is scoped to quotes
// modified in the last 10 days, whereas provisioning has to reconsider every
// eligible row — including ones that became eligible while the flag was off,
// and ones that failed last night and are now out of backoff.
//
// The on-view billing refresh (refreshHubspotBilling) still does its job: it
// DISCOVERS the subscription within minutes of checkout. This cron ACTS on it.
// That split is what keeps "provisioning never depends on a customer opening a
// page" true while still reacting quickly.
export const maxDuration = 300;

// Runs every 15 minutes (vercel.json). The subscription lands 1-9 minutes
// after checkout and the merchant is usually still sitting on the page, so a
// nightly cadence would leave them staring at "we're setting up your account"
// overnight.

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron aio-provisioning] CRON_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 401 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // An unconfigured optional integration is not an incident — 200, not 500.
  // Contrast the missing CRON_SECRET above, which is a misconfiguration.
  if (!aioDashboardEnabled()) {
    return NextResponse.json({ skipped: "disabled" });
  }

  // Canary list. Every create burns a globally-unique alias that is never
  // freed, in a database shared with other AIO teams, so the first real runs
  // are pinned to named applications rather than "everything eligible".
  const allowlist = (process.env.AIO_DASHBOARD_APP_ALLOWLIST ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const summary = {
    considered: 0,
    provisioned: 0,
    skipped: {} as Record<string, number>,
    needsAttention: [] as { applicationId: string; error: string }[],
    failed: [] as { applicationId: string; error: string }[],
  };

  let rows;
  try {
    rows = await db.select().from(merchantApplications);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[cron aio-provisioning] could not load applications", error);
    return NextResponse.json({ error }, { status: 500 });
  }

  for (const row of rows) {
    if (allowlist.length > 0 && !allowlist.includes(row.id)) continue;

    const app = rowToApp(row);
    const gate = isReadyForAioProvisioning(app);
    if (!gate.ready) {
      summary.skipped[gate.reason] = (summary.skipped[gate.reason] ?? 0) + 1;
      continue;
    }

    summary.considered++;
    const outcome = await provisionAioTenant(app);

    if (outcome.status === "provisioned") {
      summary.provisioned++;
    } else if (outcome.status === "needs_attention") {
      // Not counted as a failure: it's a stuck row a human must unpick, and
      // failing the whole run for it would mask genuine outages.
      summary.needsAttention.push({ applicationId: row.id, error: outcome.error });
      console.error(`[cron aio-provisioning] ${row.id} needs attention`, outcome.error);
    } else if (outcome.status === "failed") {
      summary.failed.push({ applicationId: row.id, error: outcome.error });
      console.error(`[cron aio-provisioning] ${row.id} failed`, outcome.error);
    }
    // "not_claimed" means another run has it — silent, not an error.
  }

  return NextResponse.json(summary, { status: summary.failed.length > 0 ? 500 : 200 });
}
