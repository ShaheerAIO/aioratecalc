"use server";

// Publishing a billing quote from the STAFF side.
//
// ⚠️ UPDATED 2026-10-13 (product-owner decision), REVERSING the posture this
// file had held since 2026-09-25 and described below. The PRIMARY trigger for
// a publish is now `publishAtSend` (`lib/actions/prospects.ts`), called from
// `createProspectAction` the instant a rep creates a prospect and its lead
// link goes out — before the merchant has seen anything, let alone accepted
// it. "Make quote publish as soon as link is sent," not whenever the merchant
// happens to click through on their own.
//
// History, for why the OLD posture existed and why none of its reasoning is
// actually undone: before 2026-09-25, the rep clicked "Send Quote to Customer"
// — this very action — and only THEN did the merchant's own link show them
// anything they could sign. A merchant could open the link they'd just been
// emailed and have no way to accept it, waiting on a separate click from the
// same rep who'd already sent them the link. That problem doesn't reappear
// here: the rep's link-send now usually clears the publish itself (most of
// `canPublishBillingQuote`'s preconditions are already met by the time a
// prospect is created — company and deal are resolved first), so the merchant
// typically arrives at an already-published quote. For the prospects that
// AREN'T publishable yet at send time (rate-only, no products picked), the
// MERCHANT's own door — `/api/lead/[token]/checkout` — is UNCHANGED and
// remains the fallback; this file did not take anything back from it.
//
// What this action is NOW: the staff ESCAPE HATCH, same as before — a rep
// sitting with a merchant, or finishing a deal over the phone, where neither
// send-time nor the merchant's own click has cleared the gate yet (a tenant
// company just got linked, a quote just got its first line). It is the
// THIRD possible path to the same publish, not the first or only one —
// harmless, because the one-way door and `publishQuote`'s `400 LOCKED`-means-
// already-published rule make a repeat attempt on an already-published quote
// a no-op rather than a risk.
//
// Still NO re-publish and no "unsend", from any of the three entry points. A
// published HubSpot quote cannot be edited (400 LOCKED), deleted
// (PUBLISHED_QUOTE_CANNOT_BE_DELETED) or voided through the API, and the
// merchant authorizes an ACH mandate against it. This refuses outright once
// `publishedAt` is set.
//
// Publishing also makes HubSpot email the signer the e-signature request
// itself (association 702) — the only thing that currently delivers the
// quote link to the merchant at all; see the comment in
// publishBillingQuote.ts on why that is now logged rather than merely
// assumed, and adapters/email.ts for the one path EasyOB itself controls.

import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { ensureDealForPublish } from "@/lib/billing/ensureDeal";
import { buildAndPublishBillingQuote } from "@/lib/billing/publishBillingQuote";
import { buildAndSendOneTimeInvoice } from "@/lib/billing/oneTimeInvoice";
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

export type RetryInvoiceResult = { ok: boolean; error?: string };

/**
 * Staff retry for the one-time invoice (2026-10-22). The invoice normally goes
 * out by itself the moment acceptance is detected, and the nightly cron
 * retries whatever that left unfinished — this is for a rep who has just fixed
 * the cause (a missing billing email, say) and doesn't want to wait for the
 * night. Same idempotent build, so pressing it twice cannot bill twice.
 */
export async function retryOneTimeInvoiceAction(applicationId: string): Promise<RetryInvoiceResult> {
  const effective = await getEffectiveRole();
  if (!effective) throw new Error("Not authenticated");

  const app = await postgresStorage.getApplication(
    { userId: effective.userId, role: effective.role === "admin" ? "admin" : "rep" },
    applicationId
  );
  if (!app) return { ok: false, error: "Application not found" };

  const outcome = await buildAndSendOneTimeInvoice(app);
  switch (outcome.status) {
    case "sent":
      return { ok: true };
    case "failed":
      return { ok: false, error: `${outcome.step}: ${outcome.error}` };
    case "skipped":
      return outcome.reason === "already_sent"
        ? { ok: true }
        : {
            ok: false,
            error: {
              not_accepted: "The merchant hasn't accepted the quote yet — the invoice goes out after they do.",
              not_split: "This quote was published before one-time invoices existed; its one-time charges were collected at checkout.",
              nothing_to_invoice: "There's nothing to invoice — every one-time line on this quote is included.",
              build_in_progress: "The invoice is being built right now. Try again in a minute.",
            }[outcome.reason],
          };
  }
}
