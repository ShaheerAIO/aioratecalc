"use server";

// Saving the merchant's confirmation of their own details, from the PUBLIC
// lead link — and, with it, opening the door to the HubSpot publish.
//
// See lib/leadConfirm.ts for why this step exists and what it may write.
//
// The lead token is the credential, the same one that already lets its holder
// read the quote and (immediately after this) publish it irreversibly. The
// write is fenced by the allow-list in `applyLeadConfirmation`, and this
// action re-validates the merged result with the STRICT validator before it
// saves anything — the same function `isReadyForAioProvisioning` runs, so a
// confirmed row is a provisionable row.
//
// WHAT THIS DOES NOT DO: it does not publish. It stamps `detailsConfirmedAt`
// and returns, and the page then POSTs /api/lead/[token]/checkout, which is
// the single build-and-publish door every other entry point already shares.
// Keeping the two apart means the irreversible half keeps its own idempotency,
// its build claim, its neutral error vocabulary and its `recordBlocked` —
// none of which would survive being reimplemented here.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { applyLeadConfirmation, confirmationErrors } from "@/lib/leadConfirm";
import { updateCompanyMerchantDetails, updateCompanyEin } from "@/lib/adapters/hubspot";
import { withStateCode } from "@/lib/utils";
import type { OnboardingFieldErrors } from "@/lib/onboardingValidation";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";

export type ConfirmLeadDetailsResult =
  | { ok: true }
  | { ok: false; formError: string }
  | { ok: false; errors: OnboardingFieldErrors };

export async function confirmLeadDetailsAction(
  token: string,
  values: Record<string, string>,
): Promise<ConfirmLeadDetailsResult> {
  const lookup = await getLeadApplicationByToken(token);
  if (!lookup.ok) {
    return {
      ok: false,
      formError: "This link is no longer valid. Ask your AIO representative for a new one.",
    };
  }
  const row = lookup.row;

  // Already confirmed: say so rather than re-stamping. The merchant is on a
  // stale tab or came back through their own history, and moving the
  // confirmation time would misreport when the quote was locked — which is
  // precisely what the rep's own panel reads.
  if (row.detailsConfirmedAt) return { ok: true };

  const next = applyLeadConfirmation(
    {
      business: row.business,
      ownerContact: row.ownerContact,
      billingContact: row.billingContact,
      processing: row.processing,
    },
    values,
  );

  const errors = confirmationErrors(next);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // `withStateCode` normalises "California" to "CA" exactly as the customer's
  // authenticated onboarding form does — the validator accepts either, AIO and
  // Adyen want the code.
  const business = withStateCode(next.business as BusinessInfo);

  await db.update(merchantApplications)
    .set({
      business: business as typeof row.business,
      ownerContact: next.ownerContact as OwnerContact,
      billingContact: next.billingContact as OwnerContact | null,
      processing: next.processing as ProcessingInfo,
      detailsConfirmedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(merchantApplications.id, row.id));

  // Best-effort, and AFTER the save: the row is what the publish reads, and a
  // HubSpot hiccup must not cost the merchant a confirmation they just made.
  // Two separate calls on purpose — see `updateCompanyEin`'s own comment on
  // why the EIN does not travel with the other four properties.
  const companyId = row.tenantLink?.hubspotCompanyId;
  if (companyId) {
    try {
      await updateCompanyMerchantDetails(companyId, {
        legalName: business.legalName,
        legalStreet: business.address,
        legalCity: business.city,
        previousProcessor: next.processing?.currentProcessor,
        mcc: next.processing?.mcc,
      });
    } catch (err) {
      console.error("lead confirm: HubSpot company detail sync failed", row.id, err);
    }
    try {
      await updateCompanyEin(companyId, business.ein);
    } catch (err) {
      console.error("lead confirm: HubSpot EIN write failed", row.id, err);
    }
  }

  return { ok: true };
}
