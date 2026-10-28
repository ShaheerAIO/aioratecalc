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
import {
  associateContactToCompany,
  ensureQuoteContact,
  updateCompanyConfirmedDetails,
  updateCompanyEin,
  updateContactDetails,
  type ContactDetailsPatch,
} from "@/lib/adapters/hubspot";
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
  const companyId = row.tenantLink?.hubspotCompanyId;
  if (companyId) {
    await pushConfirmationToHubSpot(row.id, companyId, {
      business,
      ownerContact: next.ownerContact as OwnerContact,
      billingContact: next.billingContact as OwnerContact | null,
      processing: next.processing as ProcessingInfo,
    });
  }

  return { ok: true };
}

/**
 * Everything the merchant confirmed OVERRULES HubSpot (product owner,
 * 2026-10-28: "everything that the customer confirms at the end of their
 * journey must overrule whats already in hubspot. All of it"):
 *  - the Company: DBA as `name`, operating address, phone, website, business
 *    type, legal name/street/city, MCC, previous processor — and the EIN in
 *    its own PATCH (see `updateCompanyEin` for why);
 *  - the owner and billing Contacts: found or created by email, their name,
 *    title and phone overwritten, and labelled on the Company. No billing
 *    contact means "same as the owner", so the owner carries both labels.
 *
 * Previously-terminated and bankruptcy are confirmed too but have no HubSpot
 * property to land in. Each write is caught on its own, so one refusal never
 * takes the others down.
 */
async function pushConfirmationToHubSpot(
  appId: string,
  companyId: string,
  confirmed: {
    business: BusinessInfo;
    ownerContact: OwnerContact;
    billingContact: OwnerContact | null;
    processing: ProcessingInfo;
  },
): Promise<void> {
  const { business, ownerContact, billingContact, processing } = confirmed;
  try {
    await updateCompanyConfirmedDetails(companyId, {
      business,
      mcc: processing?.mcc,
      previousProcessor: processing?.currentProcessor,
    });
  } catch (err) {
    console.error("lead confirm: HubSpot company detail sync failed", appId, err);
  }
  try {
    await updateCompanyEin(companyId, business.ein);
  } catch (err) {
    console.error("lead confirm: HubSpot EIN write failed", appId, err);
  }

  // Sequential, not parallel: when the billing contact IS the owner (same
  // email), two concurrent find-or-creates would race to create one person.
  const ownerIsBilling =
    !billingContact || billingContact.email.trim().toLowerCase() === ownerContact.email.trim().toLowerCase();
  await pushConfirmedContact(appId, companyId, ownerContact, ownerIsBilling ? ["owner", "billing"] : ["owner"]);
  if (!ownerIsBilling) await pushConfirmedContact(appId, companyId, billingContact, ["billing"]);
}

async function pushConfirmedContact(
  appId: string,
  companyId: string,
  contact: OwnerContact,
  roles: Array<"owner" | "billing">,
): Promise<void> {
  if (!contact.email?.trim()) return;
  try {
    const contactId = await ensureQuoteContact({
      firstName: contact.firstName ?? "",
      lastName: contact.lastName ?? "",
      email: contact.email,
      phone: contact.phone,
    });
    const patch: ContactDetailsPatch = {};
    if (contact.firstName?.trim()) patch.firstname = contact.firstName.trim();
    if (contact.lastName?.trim()) patch.lastname = contact.lastName.trim();
    if (contact.title?.trim()) patch.jobtitle = contact.title.trim();
    if (contact.phone?.trim()) patch.phone = contact.phone.trim();
    await updateContactDetails(contactId, patch);
    await associateContactToCompany(contactId, companyId, roles);
  } catch (err) {
    console.error(`lead confirm: HubSpot ${roles.join("+")} contact sync failed`, appId, err);
  }
}
