// Start AIO provisioning the moment a merchant becomes eligible, instead of
// waiting for the next cron tick.
//
// Called from the AUTHENTICATED customer paths only (application page view,
// onboarding/details saves). Never from the public lead link: an
// unauthenticated route creating objects AIO can never delete is the trade
// provisioning.md rules out. The cron stays the backstop for a merchant who
// never comes back.
//
// Safe to call on every view: the gate is pure, and provisionAioTenant takes a
// conditional lease, so a concurrent cron run (or a second tab) gets
// `not_claimed` and does nothing.

import { after } from "next/server";
import type { MerchantApplication } from "@/types/merchant";
import { aioDashboardEnabled } from "@/lib/adapters/aioDashboard";
import { isReadyForAioProvisioning } from "@/lib/aio/provisioningGate";
import { provisionAioTenant } from "@/lib/aio/provision";

/** The canary list (`AIO_DASHBOARD_APP_ALLOWLIST`). Empty means every eligible row. */
export function aioAllowlisted(id: string): boolean {
  const allowlist = (process.env.AIO_DASHBOARD_APP_ALLOWLIST ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return allowlist.length === 0 || allowlist.includes(id);
}

export function kickAioProvisioning(app: MerchantApplication): void {
  if (!aioDashboardEnabled() || !aioAllowlisted(app.id)) return;
  if (!isReadyForAioProvisioning(app).ready) return;

  // Inside the schema warm-up there is nothing to do yet (provisionAioTenant
  // would only claim and defer), so skip the two writes. The page refreshes
  // itself while setting up, so this is hit every 20 seconds.
  const t = app.aioTenant;
  const notBefore = t?.locationNotBefore ? Date.parse(t.locationNotBefore) : 0;
  if (t?.businessId && !t.locationId && Date.now() < notBefore) return;

  // After the response, so a page view never waits on AIO's three calls.
  after(async () => {
    const outcome = await provisionAioTenant(app);
    if (outcome.status === "failed" || outcome.status === "needs_attention" || outcome.status === "blocked") {
      console.error(`[aio kick] ${app.id} ${outcome.status}`, outcome.error);
    }
  });
}
