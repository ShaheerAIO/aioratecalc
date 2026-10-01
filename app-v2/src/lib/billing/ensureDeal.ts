// The deal a billing quote hangs off, created if it isn't there yet.
//
// Association 64 (quote → deal) is a hard publish requirement, so a row with
// no `hubspotDealId` can never be published — `canPublishBillingQuote` refuses
// it `no_deal` forever. Rows accepted before commit 511e019 are exactly that:
// the deal push only ran at onboarding submission back then, so a merchant who
// accepted and stopped at the checklist left no deal behind.
//
// This lived inside `sendQuoteAction` while the rep's Send Quote button was
// the only way to publish. It isn't any more — the MERCHANT opens the door now
// (`/api/lead/[token]/checkout`) — and a gap that only the rep's entry point
// closed would mean those legacy rows can never check out at all. So it is its
// own function, called by every publish entry point, rather than a second copy
// growing quietly out of step with the first.
//
// Only ever fills a MISSING id. It deliberately does not re-push an existing
// one: `syncDealFromApplication` PATCHes when `hubspotDealId` is set, and
// silently overwriting a deal a rep has since curated in the CRM is not this
// function's job.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { buildDealProperties, tenantCompanyId } from "@/lib/adapters/hubspot";
import { resolveDealForCompany } from "@/lib/hubspotDeal";
import type { PublishRefusal } from "@/lib/billing/preconditions";
import type { DealLink, MerchantApplication } from "@/types/merchant";

export type EnsureDealResult =
  /** `app` carries the deal id, whether it was already there or just created. */
  | { ok: true; app: MerchantApplication; created: boolean }
  /** Something a human can go and fix, in their own language. */
  | { ok: false; reasons: PublishRefusal[] }
  /** HubSpot said no. */
  | { ok: false; error: string };

/**
 * Make sure `app.hubspotDealId` is set, creating the deal if it is not.
 *
 * `actorUserId` records WHO caused the link on `dealLink.linkedByUserId`. A
 * customer-triggered checkout has no user of its own, so callers pass the
 * owning rep — the deal is created on their behalf, onto their company, and
 * attributing it to them is more useful than a null nobody can chase.
 */
export async function ensureDealForPublish(
  app: MerchantApplication,
  actorUserId: string
): Promise<EnsureDealResult> {
  if (app.hubspotDealId) return { ok: true, app, created: false };

  // No HubSpot Company yet → creating the deal is exactly the wrong move. A
  // deal's company association (341) is only settable at CREATE time — the v3
  // PATCH takes properties only — so a deal created now would be detached from
  // the Company record permanently. Answered as a precondition rather than an
  // error, because it names something a person can go and do.
  const companyId = tenantCompanyId(app);
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

  // Routed through `resolveDealForCompany` (`mode: "create"`) rather than
  // creating blind: under the mandatory-deal model a company that already has
  // deals almost certainly has the one the rep actually wants — the picker on
  // the account is where to adopt it — so this refuses `ambiguous` rather than
  // minting a second deal on top of one a rep is already working.
  const createdProps = buildDealProperties(app);
  const resolution = await resolveDealForCompany({
    companyId,
    choice: {
      mode: "create",
      dealName: createdProps.dealname ?? "New Deal",
      amount: createdProps.amount ? Number(createdProps.amount) : undefined,
    },
    excludeApplicationId: app.id,
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
    linkedByUserId: actorUserId,
  };
  await db
    .update(merchantApplications)
    .set({ hubspotDealId: resolution.deal.id, dealLink, updatedAt: new Date() })
    .where(eq(merchantApplications.id, app.id));

  return {
    ok: true,
    app: { ...app, hubspotDealId: resolution.deal.id, dealLink },
    created: resolution.created,
  };
}
