// Phase E — the precondition set that guards the one-way door.
//
// Publishing a HubSpot quote is irreversible: a published quote cannot be
// edited (400 LOCKED), deleted (400 PUBLISHED_QUOTE_CANNOT_BE_DELETED) or
// voided through the API at all — voiding is HubSpot-UI-only. And the merchant
// authorizes an ACH mandate against it at checkout.
//
// PHASE-E-SPEC.md §6.2 put a rep confirmation modal in front of that door: a
// rendered document, plain-language irreversibility copy, and a typed-DBA gate.
// That modal is CANCELLED — the build/publish now happens server-side inside the
// customer's acceptance, with no human in the loop at all. This function is
// therefore the ONLY compensating control left, which is why it refuses on
// things a rep would otherwise have been asked to eyeball (an unreviewed tablet
// count, most of all) rather than warning and continuing.
//
// Pure: no DB, no HubSpot, no clock. Everything it needs that lives outside the
// application row — the catalog, the sender, the signer, the template — is
// resolved by the caller and passed in, so every branch is unit-testable.

import { toLineItemProperties } from "@/lib/adapters/hubspot";
import { deriveOrderPoints, quoteTotals, resolvePlatformLine, quoteTypeOf } from "@/lib/quoting";
import type { CatalogProduct, MerchantApplication, QuoteTotals } from "@/types/merchant";

/** One thing that has to be fixed, in the language of the person who has to fix it. */
export type PublishRefusal = { code: string; message: string };

export type CanPublishResult =
  | {
      ok: true;
      /** Recomputed from app.quoteLines — what will actually publish. */
      totals: QuoteTotals;
      lineCount: number;
    }
  | {
      ok: false;
      /**
       * TRUE means "this quote is already published" — a no-op, not a failure.
       * Nothing to fix, nothing to report as broken, and no second publish is
       * possible. Callers must not persist this as a sync error.
       */
      alreadyPublished: boolean;
      /** Every problem at once. A one-at-a-time list is a rep making five trips. */
      reasons: PublishRefusal[];
    };

export type CanPublishInput = {
  app: MerchantApplication;
  /** The full active catalog (including the derived platform/service products the picker hides). */
  catalog: CatalogProduct[];
  /** The owning rep's `users.email` → `hs_sender_email`. The publish PATCH 400s without it. */
  senderEmail: string | null;
  /** `ownerContact.email`, else the address the customer accepted with. Becomes the e-sign signer (702). */
  signerEmail: string | null;
  /** The HubSpot quote_template id for this quote's type (association 286). */
  templateId: string | null;
};

/**
 * Whether this application may be built into a HubSpot quote and published.
 *
 * Bias: refusing is cheap and recoverable (a rep retries from
 * `retryBillingQuoteAction` once the data is fixed); publishing the wrong
 * numbers is neither. Every check below is therefore a hard refusal, not a
 * warning.
 */
export function canPublishBillingQuote(input: CanPublishInput): CanPublishResult {
  const { app, catalog, senderEmail, signerEmail, templateId } = input;

  // 1. Already published — short-circuit before anything else. This is the
  //    one-way-door marker, and once it is set no other precondition matters:
  //    there is no re-publish, no edit and no void, so the only correct
  //    behaviour is to do nothing.
  const publishedAt = app.hubspotIds?.publishedAt;
  if (publishedAt) {
    return {
      ok: false,
      alreadyPublished: true,
      reasons: [{
        code: "already_published",
        message: `This quote was already published to HubSpot on ${publishedAt}. A published quote cannot be edited, replaced or voided from EasyOB — change it in HubSpot.`,
      }],
    };
  }

  const reasons: PublishRefusal[] = [];
  const add = (code: string, message: string) => reasons.push({ code, message });

  // 2. A deal to hang the quote off. Association 64 (quote → deal) is a hard
  //    publish requirement, so a deal push that just failed leaves nothing to
  //    attach to and there is no point starting the graph.
  if (!app.hubspotDealId) {
    add(
      "no_deal",
      "This deal isn't in HubSpot yet, so there's nothing to attach the quote to. The deal sync runs on acceptance — check the sync error on the account, fix it, and retry."
    );
  }

  // 3. Lines, and a catalog product behind every one of them. A line with no
  //    hs_product_id cannot become a line item.
  const lines = app.quoteLines ?? [];
  if (lines.length === 0) {
    // Reachable only if a caller asks about a rate-only quote directly. The
    // orchestrator treats an empty line set as "nothing to bill" and skips
    // before getting here — see publishBillingQuote.ts.
    add(
      "no_quote_lines",
      "There are no priced lines on this quote, so there is nothing for HubSpot to bill. Add the products the merchant is buying."
    );
  }
  const namelessProducts = lines.filter(l => !l.hubspotProductId.trim()).map(l => l.name || "(unnamed line)");
  if (namelessProducts.length > 0) {
    add(
      "line_missing_product_id",
      `These lines aren't linked to a HubSpot product and can't be billed: ${namelessProducts.join(", ")}. Rebuild the quote against the current catalog.`
    );
  }

  // 4. Every line's billing frequency is one AIO actually quotes
  //    (`one_time` / `weekly` / `monthly`). Checked by RUNNING the real builder
  //    and catching, rather than restating its supported list here — a second
  //    copy of that list is how the two drift apart, and this check has already
  //    survived one change to what the builder emits. Left unchecked, the throw
  //    lands MID-GRAPH, after line items and possibly a quote already exist.
  for (const line of lines) {
    try {
      toLineItemProperties(line);
    } catch (err) {
      add(
        "unsupported_billing_frequency",
        err instanceof Error ? err.message : `Line '${line.name}' has a billing frequency HubSpot quoting doesn't support.`
      );
    }
  }

  // 5. The platform tier resolved. Order points are recomputed from the lines
  //    rather than read off the stored total, so a catalog that no longer
  //    yields the tier product is caught here instead of at publish. Its own
  //    docstring says an unresolved platform line must block the save: it is
  //    the largest recurring charge on the quote, and quoting without it
  //    undercharges by hundreds a month, permanently.
  const quoteType = quoteTypeOf(app.quoteType);
  const breakdown = deriveOrderPoints(lines, app.orderPoints?.channels ?? []);
  const platform = resolvePlatformLine(quoteType, breakdown.orderPoints.total, catalog);
  if (platform.status === "unresolved") {
    add(
      "platform_tier_unresolved",
      `The "${platform.productName}" platform product isn't in the HubSpot catalog (renamed, archived, or the catalog didn't load), so this quote would carry no platform fee at all.`
    );
  }

  // 6. No unreviewed order points. REFUSED, not acknowledged: §6.1 item 9 let a
  //    rep tick these off, and under auto-publish there is no rep in the loop
  //    at acceptance time. A tablet counted on the wrong side of the 1–5 / 6+
  //    boundary is a ~$433/mo error on a document nobody can amend, so stalling
  //    billing until a human looks is strictly the better failure.
  for (const item of breakdown.needsReview) {
    add(
      "order_points_need_review",
      `${item.name} (×${item.qty}) needs a human decision before this quote can be billed: ${item.reason}`
    );
  }

  // 7. A signer. Associations 69 AND 702 are both required once
  //    hs_acceptance_method is forced to `esignature`, and 702 makes this
  //    contact the legal signer — HubSpot mails them the e-signature request.
  if (!signerEmail?.trim()) {
    add(
      "no_signer_email",
      "There's no email address to send the quote to for signature. Add the merchant's contact email to the account."
    );
  }

  // 8. A sender. hs_sender_email is a publish-time requirement; the publish
  //    PATCH 400s without it. It is the owning rep's own address, verified
  //    against 46 live paid quotes — never a shared mailbox.
  if (!senderEmail?.trim()) {
    add(
      "no_sender_email",
      "The rep who owns this deal has no email address on their EasyOB user, and HubSpot sends the quote from that address. Fix the user record."
    );
  }

  // 9. A template (association 286). A quote built without one renders as
  //    HubSpot's bare default, which is not a document AIO sends.
  if (!templateId?.trim()) {
    add(
      "no_template",
      `No HubSpot quote template is configured for a ${quoteType} quote. Set one in Admin → Quote templates.`
    );
  }

  // 10. Stage sanity. A lost deal must not bill.
  if (app.stage === "closed_lost") {
    add(
      "closed_lost",
      "This deal is marked closed lost. Reopen it before billing anything."
    );
  }

  if (reasons.length > 0) return { ok: false, alreadyPublished: false, reasons };

  // 11. What was quoted is what publishes. §6.1 item 10 had the CLIENT submit
  //     the totals it rendered so the server could refuse on a mismatch —
  //     that check is NOT APPLICABLE under auto-publish: the trigger is the
  //     customer's acceptance POST, there is no rendered rep screen and no
  //     client-submitted total to cross-check against. What replaces it is
  //     recomputing here and handing the figures back, so the caller logs the
  //     exact amounts that went onto the unamendable document.
  return { ok: true, totals: quoteTotals(lines), lineCount: lines.length };
}
