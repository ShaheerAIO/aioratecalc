"use server";

// DEBUG-BILLING-BYPASS — see lib/debug/billingBypass.ts.
//
// Records the acceptance a paid checkout would have, and nothing else. It does
// NOT fabricate a subscription in hubspotIds: `hasBillingCompleted` stays
// false, so AIO tenant provisioning (provisioningGate.ts) never fires for a
// skipped row — every object that API creates is irreversible, in a database
// shared with other teams. The HubSpot deal is left where it is, too.

import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { recordAcceptance } from "@/lib/billing/acceptance";
import { isBillingBypassEnabled } from "@/lib/debug/billingBypass";

export async function bypassBillingAction(applicationId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isBillingBypassEnabled()) return { ok: false, error: "Billing bypass is not enabled" };

  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");

  // Same ownership rule as sendQuoteAction: admin sees every row, rep only their own.
  const app = await postgresStorage.getApplication(
    { userId: effective.userId, role: effective.role === "admin" ? "admin" : "rep" },
    applicationId
  );
  if (!app) return { ok: false, error: "Application not found" };
  if (app.quoteAcceptedAt) return { ok: false, error: "This quote is already accepted" };
  if (!app.quoteLines?.length) {
    return { ok: false, error: "Rate-only quote — there's no billing to skip; the merchant accepts it on their link" };
  }

  console.warn(`[debug billing bypass] ${applicationId}: acceptance recorded without billing by ${effective.userId}`);
  const accepted = await recordAcceptance(app, { syncDeal: false });
  return accepted.quoteAcceptedAt ? { ok: true } : { ok: false, error: "Could not record the acceptance" };
}
