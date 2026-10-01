"use server";

// Publishing a billing quote from the STAFF side.
//
// ⚠️ This is no longer how a quote reaches a merchant. It used to be: the rep
// clicked "Send Quote to Customer", that published the HubSpot quote, and only
// then did the merchant's own link show them anything they could sign. Which
// meant a merchant could open the link they had just been emailed, read their
// quote, and have no way to accept it — waiting on a click from a rep who had
// already sent them the link. Product-owner decision, 2026-09-25: scrap the
// gate. The MERCHANT opens the one-way door now, from their own quote page
// (`/api/lead/[token]/checkout`), the moment they choose to go to billing.
//
// What survives here is the staff ESCAPE HATCH for the case the merchant's own
// click can't cover: a rep sitting with a merchant, or one finishing a deal
// over the phone. Same preconditions, same irreversibility, same single
// publish — it is simply no longer on the critical path, and nothing waits on
// it.
//
// Still NO re-publish and no "unsend". A published HubSpot quote cannot be
// edited (400 LOCKED), deleted (PUBLISHED_QUOTE_CANNOT_BE_DELETED) or voided
// through the API, and the merchant authorizes an ACH mandate against it. This
// refuses outright once `publishedAt` is set.
//
// Publishing also makes HubSpot email the signer the e-signature request
// itself (association 702).

import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { ensureDealForPublish } from "@/lib/billing/ensureDeal";
import { buildAndPublishBillingQuote } from "@/lib/billing/publishBillingQuote";
import type { PublishRefusal } from "@/lib/billing/preconditions";

export type SendQuoteResult = {
  ok: boolean;
  /** Preconditions that still fail. Rendered as a checklist — every problem at once. */
  reasons?: PublishRefusal[];
  /** A HubSpot/network failure, with the step that failed already named in the message. */
  error?: string;
  /** Set when the retry succeeded, so the caller can link straight to the checkout. */
  quoteLink?: string | null;
};

export async function sendQuoteAction(applicationId: string): Promise<SendQuoteResult> {
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

  // Fill in a missing deal first — see lib/billing/ensureDeal.ts for why some
  // rows have none and why `canPublishBillingQuote` would otherwise refuse
  // them `no_deal` forever. Shared with the merchant's own checkout route, so
  // the two entry points cannot drift. Unlike the fire-and-log push in
  // lib/billing/acceptance.ts, a failure here is returned as a hard error: the
  // rep clicked this to get a quote out, and without a deal the publish below
  // would only refuse anyway.
  const dealResult = await ensureDealForPublish(app, effective.userId);
  if (!dealResult.ok) {
    return "reasons" in dealResult ? { ok: false, reasons: dealResult.reasons } : { ok: false, error: dealResult.error };
  }
  const target = dealResult.app;

  const outcome = await buildAndPublishBillingQuote(target);
  switch (outcome.status) {
    case "published":
      return { ok: true, quoteLink: outcome.quoteLink };
    case "refused":
      return { ok: false, reasons: outcome.reasons };
    case "failed":
      return { ok: false, error: `${outcome.step}: ${outcome.error}` };
    case "skipped":
      // Nothing was created and nothing is wrong — but say which one it was,
      // because "nothing to bill" and "someone else is mid-build" call for
      // very different reactions from the rep.
      return outcome.reason === "nothing_to_bill"
        // Rate-only: there is no HubSpot document to send, so the merchant
        // accepts on the lead page itself — the one place that button survives.
        ? { ok: true, error: "This is a rate-only quote — there are no products for HubSpot to bill, so there's nothing to send. The merchant accepts it on their own link." }
        : outcome.reason === "already_published"
          ? { ok: false, error: "This quote is already published in HubSpot." }
          : outcome.reason === "awaiting_tenant_link"
            // Reachable only for a row that already carries a deal (created
            // before this gate existed) but still no company link.
            ? { ok: false, error: "This account isn't linked to a HubSpot company yet. Link the tenant company and billing builds itself." }
            : { ok: false, error: "A billing quote is already being built for this account. Try again in a minute." };
  }
}
