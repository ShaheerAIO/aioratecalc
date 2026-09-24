"use server";

// Phase E — sending the quote. THE one-way door, and the rep's hand is on it.
//
// This used to be `retryBillingQuoteAction`, a recovery affordance behind an
// auto-publish that fired inside the merchant's own acceptance POST. That
// auto-publish is gone: acceptance is no longer something the merchant asserts
// in EasyOB, it is something HubSpot reports once they sign and pay the hosted
// quote (see lib/billing/acceptance.ts). Which means the quote has to be
// PUBLISHED BEFORE the merchant ever opens their link, and something has to
// decide when — so the rep does, with this.
//
// Putting a human back on the irreversible act also restores the compensating
// control `canPublishBillingQuote`'s header describes as lost. A published
// HubSpot quote cannot be edited, deleted or voided through the API, and the
// merchant authorizes an ACH mandate against it. Hence, still, NO re-publish
// and no "unsend": this refuses outright once `publishedAt` is set.
//
// Publishing also makes HubSpot email the signer the e-signature request
// itself (association 702), so this single click is what actually puts the
// quote in front of the merchant.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { postgresStorage } from "@/lib/storage/postgresAdapter";
import { buildDealProperties, tenantCompanyId } from "@/lib/adapters/hubspot";
import { resolveDealForCompany } from "@/lib/hubspotDeal";
import { buildAndPublishBillingQuote } from "@/lib/billing/publishBillingQuote";
import type { PublishRefusal } from "@/lib/billing/preconditions";
import type { DealLink } from "@/types/merchant";

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

  // A row accepted before commit 511e019 has no HubSpot deal at all: the deal
  // push only ever ran at onboarding submission back then, so a merchant who
  // accepted and stopped at the checklist left no deal behind. Association 64
  // (quote → deal) is a hard publish requirement, so `canPublishBillingQuote`
  // refuses those rows with `no_deal` forever and there is no other affordance
  // that would ever create it — this has to close that gap itself or the
  // account is unrecoverable from the UI.
  //
  // Only ever fills a MISSING id. It deliberately does not re-push an existing
  // one: `syncDealFromApplication` PATCHes when hubspotDealId is set, and
  // silently overwriting a deal a rep has since curated in the CRM is not this
  // button's job. Unlike the fire-and-log push in lib/billing/acceptance.ts, a
  // failure here is returned as a hard error — the rep clicked this to get a
  // quote out, and without a deal the publish below would only refuse anyway.
  //
  // Routed through `resolveDealForCompany` (`mode: "create"`) rather than
  // creating blind: under the mandatory-deal model a company that already has
  // deals almost certainly has the one the rep actually wants — the picker on
  // the account is where to adopt it — so this refuses `ambiguous` rather than
  // minting a second deal on top of one a rep is already working.
  let target = app;
  if (!target.hubspotDealId) {
    // …unless the account has no HubSpot Company yet, in which case creating
    // the deal is exactly the wrong move: the company association is only
    // settable at create time, so it would produce a deal permanently detached
    // from the Company record. Answered as a precondition rather than an
    // error, because it names something the rep can go and do.
    const companyId = tenantCompanyId(target);
    if (!companyId) {
      return {
        ok: false,
        reasons: [{
          code: "no_tenant_company",
          message:
            "This account isn't linked to a HubSpot company yet, so there's nothing to create the deal under. " +
            "Link the tenant company on the account — the deal and quote build themselves as soon as you do.",
        }],
      };
    }

    const createdProps = buildDealProperties(target);
    const resolution = await resolveDealForCompany({
      companyId,
      choice: {
        mode: "create",
        dealName: createdProps.dealname ?? "New Deal",
        amount: createdProps.amount ? Number(createdProps.amount) : undefined,
      },
      excludeApplicationId: target.id,
    });

    if (!resolution.ok) {
      if (resolution.code === "ambiguous") {
        return {
          ok: false,
          reasons: [{
            code: "deal_ambiguous",
            message:
              `This company already has ${resolution.candidates?.length ?? "multiple"} deal(s) in HubSpot. ` +
              "Open the deal picker on the account and adopt the right one instead of creating a new one.",
          }],
        };
      }
      return {
        ok: false,
        error: `This deal isn't in HubSpot yet and creating it just failed, so there's nothing to attach a quote to: ${resolution.message}`,
      };
    }

    const dealLink: DealLink = {
      origin: resolution.created ? "created" : "adopted",
      dealName: resolution.deal.name,
      pipelineStageAtLink: resolution.deal.stageId,
      linkedAt: new Date().toISOString(),
      linkedByUserId: effective.userId,
    };
    await db
      .update(merchantApplications)
      .set({ hubspotDealId: resolution.deal.id, dealLink, updatedAt: new Date() })
      .where(eq(merchantApplications.id, target.id));
    target = { ...target, hubspotDealId: resolution.deal.id, dealLink };
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
