import { NextRequest, NextResponse } from "next/server";
import { backfillEasyobDealLinks, clearCompanyEasyobLinks } from "@/lib/adapters/hubspot";

// Phase F nightly top-up. Keeps every HubSpot Deal's `easyob_link` URL
// property in sync so the "Push to EasyOB" deep link on the Company record's
// Deals card always resolves, and empties the old company-level link it
// replaced. A sibling of /api/cron/adyen-actuals rather than a second step
// bolted onto it: the two crons have nothing in common (different vendor,
// different failure modes, different runtime needs) and running them as
// separate Vercel Functions means a HubSpot outage can't affect the Adyen
// ingest's schedule or duration budget, and vice versa — process isolation
// instead of a manual try/catch per step.
//
// The two passes here use different tokens (deals: billing app, companies:
// general app), so one failing must not stop the other.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron hubspot-links] CRON_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 401 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [deals, companies] = await Promise.all([
    run("backfillEasyobDealLinks", backfillEasyobDealLinks),
    run("clearCompanyEasyobLinks", clearCompanyEasyobLinks),
  ]);
  const failed = "error" in deals || "error" in companies;
  return NextResponse.json({ dealLinks: deals, companyLinkClears: companies }, { status: failed ? 500 : 200 });
}

async function run<T extends object>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[cron hubspot-links] ${name} failed`, error);
    return { error };
  }
}
