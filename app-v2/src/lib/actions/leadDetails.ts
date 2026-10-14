"use server";

// Saving the merchant's repair of their own missing tenant details, from the
// PUBLIC lead link. See lib/leadDetails.ts for what this is for and why it has
// to be reachable without an account.
//
// The lead token is the credential, the same one that already lets its holder
// read the quote and publish it irreversibly. Writing a phone number is
// strictly less powerful than that — but it is still an unauthenticated write,
// so it is fenced twice over: `applyLeadDetails` applies only paths that are
// both on the allow-list AND currently in error, and this action re-validates
// the merged result before it saves anything.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { applyLeadDetails, remainingErrors } from "@/lib/leadDetails";
import type { OnboardingFieldErrors } from "@/lib/onboardingValidation";

export type SaveLeadDetailsResult =
  | { ok: true }
  | { ok: false; formError: string }
  | { ok: false; errors: OnboardingFieldErrors };

export async function saveLeadDetailsAction(
  token: string,
  values: Record<string, string>,
): Promise<SaveLeadDetailsResult> {
  const lookup = await getLeadApplicationByToken(token);
  if (!lookup.ok) {
    return {
      ok: false,
      formError: "This link is no longer valid. Ask your AIO representative for a new one.",
    };
  }
  const row = lookup.row;

  const current = { business: row.business, ownerContact: row.ownerContact };
  const next = applyLeadDetails(current, values);

  const errors = remainingErrors(next);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // Nothing was in error, so nothing was applied — the merchant got here from
  // a stale tab, or someone else fixed it first. Succeeding is the honest
  // answer: what they wanted is already true.
  await db.update(merchantApplications)
    .set({
      business: next.business as typeof row.business,
      ownerContact: next.ownerContact as typeof row.ownerContact,
      updatedAt: new Date(),
    })
    .where(eq(merchantApplications.id, row.id));

  // Deliberately no HubSpot push and no provisioning kick. The 15-minute
  // provisioning cron re-reads this row and `isReadyForAioProvisioning` will
  // now pass it — doing it here would mean an unauthenticated route triggering
  // the creation of objects AIO can never delete, to save at most 15 minutes.
  return { ok: true };
}
