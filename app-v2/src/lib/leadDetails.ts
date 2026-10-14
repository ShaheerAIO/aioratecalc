// The merchant's last-resort repair of whatever is missing before AIO can
// create their tenant.
//
// This should never fire. `validateOnboardingFields` is enforced on the
// onboarding form, so a merchant who filled that in is already complete, and
// `isReadyForAioProvisioning` refuses to attempt a create without it. What it
// exists for is the gap between those two: provisioning triggers on PAYMENT
// and the form is filled AFTER payment, so a merchant can be sitting at a
// permanently-held checklist having never opened it — and the row that
// prompted this (prospect_1792016501714, 2026-10-14) has no customer account
// at all, so the authenticated form at /customer/applications/[id]/edit is
// unreachable for them. The public lead token is the only way in.
//
// Pure — the DB work lives in lib/actions/leadDetails.ts. Same split as
// leadAccount.ts, for the same reason: these rules decide what a PUBLIC token
// may rewrite, and that deserves to be tested without a database.

import { validateOnboardingFields, type OnboardingFieldErrors } from "@/lib/onboardingValidation";
import type { BusinessInfo, OwnerContact } from "@/types/merchant";

export type LeadDetailsInput = {
  business?: Partial<BusinessInfo> | null;
  ownerContact?: Partial<OwnerContact> | null;
};

export type MissingField = {
  /** The dotted path validateOnboardingFields keys its errors by. */
  path: string;
  label: string;
  placeholder?: string;
  /** The validator's own message — the dialog never writes its own copy. */
  message: string;
};

/**
 * Every field this dialog is allowed to show, in the order it shows them, with
 * the label the merchant reads.
 *
 * An allow-LIST rather than a derivation, because this is the one surface where
 * an unauthenticated token writes to the application. A path that isn't here
 * cannot be repaired this way even if the validator starts reporting it — the
 * merchant is sent to the full form instead, which is the safer failure.
 *
 * Deliberately EXCLUDES the legal name and the legal address. They're required
 * too, but they are what AIO's records say this business IS, and a blank one is
 * a rep-side data problem rather than something the merchant should be invited
 * to type into a modal with no review. In practice they are never blank here:
 * a rep cannot create a prospect without a legal name, and the HubSpot company
 * supplies the address.
 */
const REPAIRABLE: Array<Omit<MissingField, "message">> = [
  { path: "business.phone", label: "Business phone", placeholder: "555-000-0000" },
  { path: "ownerContact.firstName", label: "Owner first name" },
  { path: "ownerContact.lastName", label: "Owner last name" },
  { path: "ownerContact.email", label: "Owner email", placeholder: "owner@business.com" },
  { path: "ownerContact.phone", label: "Owner phone", placeholder: "555-000-0000" },
  { path: "business.dbaCity", label: "City (operating address)" },
  { path: "business.dbaState", label: "State (operating address)", placeholder: "CA" },
  { path: "business.dbaZip", label: "ZIP (operating address)", placeholder: "90210" },
];

export const REPAIRABLE_PATHS: readonly string[] = REPAIRABLE.map(f => f.path);

/** What this merchant is actually being asked for, right now. Empty = nothing to fix. */
export function missingTenantFields(input: LeadDetailsInput): MissingField[] {
  const errors = validateOnboardingFields(input);
  return REPAIRABLE.filter(f => errors[f.path]).map(f => ({ ...f, message: errors[f.path] }));
}

/**
 * True when something is missing AND this dialog can fix all of it.
 *
 * The distinction matters: a row missing only its legal address is missing
 * something no amount of clicking here will resolve, so offering the dialog
 * would be a dead end. The caller sends those to the full form.
 */
export function canRepairFromLead(input: LeadDetailsInput): boolean {
  const errors = validateOnboardingFields(input);
  const paths = Object.keys(errors);
  return paths.length > 0 && paths.every(p => REPAIRABLE_PATHS.includes(p));
}

/**
 * Merge the merchant's answers into the application's own sections.
 *
 * Only paths that are BOTH repairable and currently in error are applied —
 * so a public token can never overwrite a value that is already good, whatever
 * the form posts. Everything else in `current` is returned untouched.
 */
export function applyLeadDetails(
  current: LeadDetailsInput,
  values: Record<string, string>,
): { business: Partial<BusinessInfo>; ownerContact: Partial<OwnerContact> } {
  const allowed = new Set(missingTenantFields(current).map(f => f.path));
  const business: Record<string, unknown> = { ...(current.business ?? {}) };
  const ownerContact: Record<string, unknown> = { ...(current.ownerContact ?? {}) };

  for (const [path, raw] of Object.entries(values)) {
    if (!allowed.has(path)) continue;
    const [section, key] = path.split(".");
    const value = (raw ?? "").trim();
    if (section === "business") business[key] = value;
    else if (section === "ownerContact") ownerContact[key] = value;
  }

  return {
    business: business as Partial<BusinessInfo>,
    ownerContact: ownerContact as Partial<OwnerContact>,
  };
}

/**
 * What's still wrong after the merge, keyed the same way — so the dialog can
 * put each message under its own box.
 *
 * Reports ONLY repairable paths: an unrepairable one left over is not something
 * the merchant can act on in this dialog, and surfacing it under no input box
 * would be a message with nowhere to go. `canRepairFromLead` is what keeps the
 * dialog off those rows in the first place.
 */
export function remainingErrors(next: LeadDetailsInput): OnboardingFieldErrors {
  const errors = validateOnboardingFields(next);
  return Object.fromEntries(
    Object.entries(errors).filter(([path]) => REPAIRABLE_PATHS.includes(path))
  );
}
