"use server";

// Phase E — the rep's only billing affordance.
//
// The billing quote is built and published automatically when the merchant
// accepts (see src/app/api/lead/[token]/accept/route.ts). There is no rep
// "Publish" button and no confirmation modal: the door is opened server-side.
// What a rep DOES need is a way to un-stick an account whose auto-publish was
// refused (a tablet needing review, a missing platform product, no deal in the
// CRM) or failed (HubSpot 403/500), once the underlying problem is fixed.
//
// This is that, and nothing more. In particular it is NOT a re-publish: a
// published HubSpot quote cannot be edited, deleted or voided through the API
// at all, so offering one would be a lie about what the button does.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { pushToHubSpot } from "@/lib/adapters/hubspot";
import { buildAndPublishBillingQuote } from "@/lib/billing/publishBillingQuote";
import type { PublishRefusal } from "@/lib/billing/preconditions";

export type RetryBillingQuoteResult = {
  ok: boolean;
  /** Preconditions that still fail. Rendered as a checklist — every problem at once. */
  reasons?: PublishRefusal[];
  /** A HubSpot/network failure, with the step that failed already named in the message. */
  error?: string;
  /** Set when the retry succeeded, so the caller can link straight to the checkout. */
  quoteLink?: string | null;
};

export async function retryBillingQuoteAction(applicationId: string): Promise<RetryBillingQuoteResult> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");

  // getApplication already enforces the ownership rule this action needs — an
  // admin sees every row, a rep only their own — so the check isn't restated
  // here in a second, drifting form.
  const app = await postgresStorage.getApplication(
    { userId: effective.userId, role: effective.role === "admin" ? "admin" : "rep" },
    applicationId
  );
  if (!app) return { ok: false, error: "Application not found" };

  if (app.hubspotIds?.publishedAt) {
    return {
      ok: false,
      error:
        `This quote was already published to HubSpot on ${app.hubspotIds.publishedAt}. ` +
        `A published quote can't be edited, replaced or voided from EasyOB — voiding is only possible by hand in HubSpot.`,
    };
  }

  // A row accepted before commit 511e019 has no HubSpot deal at all: the deal
  // push only ever ran at onboarding submission back then, so a merchant who
  // accepted and stopped at the checklist left no deal behind. Association 64
  // (quote → deal) is a hard publish requirement, so `canPublishBillingQuote`
  // refuses those rows with `no_deal` forever and there is no other affordance
  // that would ever create it — the retry has to close that gap itself or the
  // account is unrecoverable from the UI.
  //
  // Only ever fills a MISSING id. It deliberately does not re-push an existing
  // one: pushToHubSpot PATCHes when hubspotDealId is set, and silently
  // overwriting a deal a rep has since curated in the CRM is not this button's
  // job. Unlike the fire-and-log push in the acceptance route, a failure here
  // is returned as a hard error — the rep clicked this to get a quote out, and
  // without a deal the publish below would only refuse anyway.
  let target = app;
  if (!target.hubspotDealId) {
    try {
      const dealId = await pushToHubSpot(target);
      await db
        .update(merchantApplications)
        .set({ hubspotDealId: dealId, updatedAt: new Date() })
        .where(eq(merchantApplications.id, target.id));
      target = { ...target, hubspotDealId: dealId };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `This deal isn't in HubSpot yet and creating it just failed, so there's nothing to attach a quote to: ${detail}`,
      };
    }
  }

  const outcome = await buildAndPublishBillingQuote(target);
  switch (outcome.status) {
    case "published":
      return { ok: true, quoteLink: outcome.quoteLink };
    case "refused":
      return { ok: false, reasons: outcome.reasons };
    case "failed":
      return { ok: false, error: `${outcome.step}: ${outcome.error}` };
    case "skipped":
      // Nothing was created and nothing is wrong — but say which of the three
      // it was, because "nothing to bill" and "someone else is mid-build" call
      // for very different reactions from the rep.
      return outcome.reason === "nothing_to_bill"
        ? { ok: true, error: "This is a rate-only quote — there are no products for HubSpot to bill." }
        : outcome.reason === "already_published"
          ? { ok: false, error: "This quote is already published in HubSpot." }
          : { ok: false, error: "A billing quote is already being built for this account. Try again in a minute." };
  }
}
