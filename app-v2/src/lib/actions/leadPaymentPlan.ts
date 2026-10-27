"use server";

// Saving how the merchant will pay the one-time invoice, from the PUBLIC lead
// link. See lib/paymentPlan.ts for what each choice means.
//
// The lead token is the credential, as for confirmLeadDetailsAction. The
// choice has to land BEFORE the publish at /api/lead/[token]/checkout, which
// refuses without it, so this refuses once the quote is published: the
// invoice is built from the choice and the quote cannot be amended.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { rowToApp } from "@/lib/storage/applicationRow";
import { isPaymentPlan, requiresPaymentPlan } from "@/lib/paymentPlan";

export type SavePaymentPlanResult = { ok: true } | { ok: false; formError: string };

export async function savePaymentPlanAction(token: string, plan: string): Promise<SavePaymentPlanResult> {
  const lookup = await getLeadApplicationByToken(token);
  if (!lookup.ok) {
    return {
      ok: false,
      formError: "This link is no longer valid. Ask your AIO representative for a new one.",
    };
  }
  if (!isPaymentPlan(plan)) return { ok: false, formError: "Please choose how you'd like to pay." };

  const app = rowToApp(lookup.row);
  // Nothing to pay on this quote, so nothing to choose.
  if (!requiresPaymentPlan(app)) return { ok: true };
  // Published: the invoice has been (or is being) built from the old choice.
  if (app.hubspotIds?.publishedAt) {
    return app.paymentPlan === plan
      ? { ok: true }
      : { ok: false, formError: "Your quote has already been finalised, so this can't be changed here." };
  }

  await db.update(merchantApplications)
    .set({ paymentPlan: plan, paymentPlanAt: new Date(), updatedAt: new Date() })
    .where(eq(merchantApplications.id, app.id));
  return { ok: true };
}
