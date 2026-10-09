import { NextRequest, NextResponse } from "next/server";
import { backfillEasyobDealLinks, clearCompanyEasyobLinks } from "@/lib/adapters/hubspot";
import { auditQuoteTemplatePolicy } from "@/lib/actions/quoteTemplates";

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
// The passes here use different tokens (deals: billing app, companies: general
// app), so one failing must not stop the other.
//
// The third pass audits the quote template policy. It shares nothing with the
// link backfill except a schedule and HubSpot — it is here because this is the
// nightly HubSpot errand, and a check that needs its own cron entry is a check
// that doesn't get added.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron hubspot-links] CRON_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 401 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [deals, companies, templates] = await Promise.all([
    run("backfillEasyobDealLinks", backfillEasyobDealLinks),
    run("clearCompanyEasyobLinks", clearCompanyEasyobLinks),
    run("auditQuoteTemplatePolicy", auditQuoteTemplatePolicy),
  ]);

  // A stale template is reported as a FAILED cron run, not a quiet field in a
  // 200. Nobody reads a healthy cron's body, and the whole point of the check
  // is to be seen on the night it starts being true rather than at the next
  // publish — by which time a merchant is at the door. Nothing is auto-fixed;
  // see auditQuoteTemplatePolicy.
  const staleTemplates = "stale" in templates ? templates.stale : [];
  for (const t of staleTemplates) {
    console.error(
      `[cron hubspot-links] quote template for "${t.quoteType}" is ${t.reason} in HubSpot ` +
      `(${t.name ?? "unknown"} ${t.templateId}) — publishing a ${t.quoteType} quote will be refused ` +
      `until it is re-pointed in Admin → Quote templates`
    );
  }

  const failed = "error" in deals || "error" in companies || "error" in templates || staleTemplates.length > 0;
  return NextResponse.json(
    { dealLinks: deals, companyLinkClears: companies, quoteTemplates: templates },
    { status: failed ? 500 : 200 }
  );
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
