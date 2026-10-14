// What the AIO tenant chain actually needs before `adapters/aioDashboard.ts`'s
// business → location → KYC-link chain can succeed.
//
// This was written for Adyen's own legal-entity chain, which EasyOB no longer
// creates (2026-09-23). The job is the same and the stakes went UP: AIO's
// `business/create` validates server-side and 400s, and a failed provisioning
// run is not a form error anyone sees — it burns one of five attempts, backs
// off exponentially (1h, 2h, 4h, 8h, 16h) and then stops forever, while the
// merchant's checklist says "We're setting up your account — no action
// needed". That is exactly what happened to `prospect_1792016501714` on
// 2026-10-14: `pocInfo.0.contactNo should not be empty`, because the owner's
// phone was blank and nothing had ever required it.
//
// Hence the rule this module now carries: **passing `validateOnboardingFields`
// IS the precondition for provisioning.** `isReadyForAioProvisioning` calls
// this same function rather than keeping its own shorter list, so the cron can
// never attempt a create the form would have refused, and the two can't drift.
// Before adding a field to AIO's payloads, add it here.
//
// Deliberately PURE and dependency-free apart from utils.ts and consent.ts
// (both also pure) so the same rules run in the browser (CustomerOnboardStep,
// for inline messages), in the Server Action (the real gate), and in the
// provisioning gate. It must never import adapters/, pricing.ts, or anything
// under lib/db — those are server-only and would be pulled into the client
// bundle.
//
// Errors are keyed by the dotted field path the onboarding form already uses
// for its prefill bookkeeping ("business.zip"), so the form can render each
// message next to the input it belongs to without a second mapping table.

import { isCustomerConsent } from "@/lib/consent";
import { isUsStateCode } from "@/lib/utils";
import type { AgreementInfo, BusinessInfo, OwnerContact } from "@/types/merchant";

export type OnboardingFieldErrors = Record<string, string>;

export type OnboardingValidationInput = {
  business?: Partial<BusinessInfo> | null;
  ownerContact?: Partial<OwnerContact> | null;
};

export type OnboardingSubmissionInput = OnboardingValidationInput & {
  agreement?: AgreementInfo | null;
};

const s = (v: string | undefined | null) => (v ?? "").trim();

// US ZIP, 5-digit or ZIP+4. Adyen validates postalCode against the country.
const ZIP = /^\d{5}(-\d{4})?$/;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A hostname with at least one dot and no stray characters. Bare domains are
// fine — adapters/adyen.ts prefixes "https://" before sending webAddress — but
// free text like "n/a" or "not applicable" is not, and it reaches Adyen as
// "https://not applicable" and 422s the business line.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function isWebsiteLike(raw: string): boolean {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return HOSTNAME.test(new URL(withScheme).hostname);
  } catch {
    return false;
  }
}

const E164 = /^\+[1-9]\d{7,14}$/;

// True only when adapters/adyen.ts's toE164Phone would turn this into a valid
// E.164 number. That helper returns anything it can't confidently map UNCHANGED
// — deliberately, since a guessed number is worse than the original — so
// free text ("555-0000", "call the office") reaches Adyen verbatim and 422s the
// store. Its mapping is mirrored here rather than imported: it lives in the
// Adyen adapter, which must not be pulled into the client bundle.
function isE164Convertible(raw: string): boolean {
  if (raw.startsWith("+")) return E164.test(raw);
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return true;
  return digits.length === 11 && digits.startsWith("1");
}

// Returns {} when everything Adyen needs is present and well-formed.
export function validateOnboardingFields(input: OnboardingValidationInput): OnboardingFieldErrors {
  const errors: OnboardingFieldErrors = {};
  const biz = input.business ?? {};
  const owner = input.ownerContact ?? {};

  // Required — organization.legalName + registeredAddress on the legal entity.
  if (!s(biz.legalName)) errors["business.legalName"] = "Enter the legal business name.";
  if (!s(biz.address)) errors["business.address"] = "Enter the street address.";
  if (!s(biz.city)) errors["business.city"] = "Enter the city.";

  const state = s(biz.state);
  if (!state) errors["business.state"] = "Enter the state.";
  else if (!isUsStateCode(state)) errors["business.state"] = "Use a US state — e.g. CA or California.";

  const zip = s(biz.zip);
  if (!zip) errors["business.zip"] = "Enter the ZIP code.";
  else if (!ZIP.test(zip)) errors["business.zip"] = "Use a 5-digit ZIP, e.g. 90210.";

  const website = s(biz.website);
  if (website && !isWebsiteLike(website)) {
    errors["business.website"] = "Use a full web address, e.g. yourrestaurant.com — or leave it blank.";
  }

  const altEmail = s(owner.altEmail);
  if (altEmail && !EMAIL.test(altEmail)) {
    errors["ownerContact.altEmail"] = "Enter a valid second email address, or leave it blank.";
  }

  return { ...errors, ...tenantFieldErrors(input) };
}

/**
 * The fields AIO's own tenant create reads, every one of them REQUIRED.
 *
 * `createAioBusiness` and `createAioLocation` between them send the business
 * name, the operating address, the business phone, and an owner/point-of-
 * contact block of name + email + phone. AIO rejects a blank in that block
 * outright, and there is no second chance worth having: the alias a retry
 * would use is globally unique and never freed.
 *
 * Three of these were previously optional-if-given or unchecked entirely, and
 * each has a specific destination:
 *   - `business.phone` → `businessInfo.contactNo` and the location's `phoneNo`
 *   - `ownerContact.firstName`/`lastName` → `ownerInfo.ownerName` and
 *     `pocInfo[0].name`, which AIO wants as one joined string — so a missing
 *     surname is a half-named owner, not a missing field AIO can report
 *   - `ownerContact.phone` → `ownerInfo.ownerContactNo` and
 *     `pocInfo[0].contactNo`. THIS is the one that failed live.
 *
 * The DBA address is still optional as a whole — blank means "same as the
 * legal address", which `locationAddress` falls back to and the legal rules
 * above already require. But a DBA STREET with no city/state/zip is no longer
 * tolerated: `locationAddress` keys on the street alone, so a half-filled DBA
 * address silently becomes a location with blank city, state and ZIP. That
 * used to be "the customer's to finish"; there is nothing downstream that
 * would make them finish it, and AIO is handed the blanks.
 */
export function tenantFieldErrors(input: OnboardingValidationInput): OnboardingFieldErrors {
  const errors: OnboardingFieldErrors = {};
  const biz = input.business ?? {};
  const owner = input.ownerContact ?? {};

  const phone = s(biz.phone);
  if (!phone) errors["business.phone"] = "Enter the business phone number.";
  else if (!isE164Convertible(phone)) {
    errors["business.phone"] = "Enter a 10-digit phone number, e.g. 555-000-0000.";
  }

  if (!s(owner.firstName)) errors["ownerContact.firstName"] = "Enter the owner's first name.";
  if (!s(owner.lastName)) errors["ownerContact.lastName"] = "Enter the owner's last name.";

  const email = s(owner.email);
  if (!email) errors["ownerContact.email"] = "Enter the owner's email address.";
  else if (!EMAIL.test(email)) errors["ownerContact.email"] = "Enter a valid email address.";

  const ownerPhone = s(owner.phone);
  if (!ownerPhone) errors["ownerContact.phone"] = "Enter the owner's phone number.";
  else if (!isE164Convertible(ownerPhone)) {
    errors["ownerContact.phone"] = "Enter a 10-digit phone number, e.g. 555-000-0000.";
  }

  // Only once a DBA street says there IS a separate operating address.
  const dbaState = s(biz.dbaState);
  const dbaZip = s(biz.dbaZip);
  if (s(biz.dbaAddress)) {
    if (!s(biz.dbaCity)) errors["business.dbaCity"] = "Enter the city for the DBA address.";
    if (!dbaState) errors["business.dbaState"] = "Enter the state for the DBA address.";
    if (!dbaZip) errors["business.dbaZip"] = "Enter the ZIP for the DBA address.";
  }
  if (dbaState && !isUsStateCode(dbaState)) errors["business.dbaState"] = "Use a US state — e.g. CA or California.";
  if (dbaZip && !ZIP.test(dbaZip)) errors["business.dbaZip"] = "Use a 5-digit ZIP, e.g. 90210.";

  return errors;
}

// Consent is a different class of requirement from the Adyen field rules above:
// Adyen never asks for it, AIO's own agreement does. It's checked here anyway
// because this module is what the Server Action runs before the handoff, and
// that is precisely where consent has to hold — the boxes were only ever
// enforced in the browser, so a bypassed client could reach Adyen's KYC pages
// having agreed to nothing.
//
// The rule itself is NOT restated: lib/consent.ts owns who may author consent
// and what counts as complete, and this only asks it. So a legacy row with no
// recorded actor fails here too, exactly as that module intends — the merchant
// is asked to tick the boxes themselves rather than being credited with an act
// of unknown origin.
export function validateOnboardingConsent(
  agreement: AgreementInfo | null | undefined
): OnboardingFieldErrors {
  if (isCustomerConsent(agreement)) return {};
  return {
    "agreement.consent":
      "Accept the terms and consent to electronic records to continue.",
  };
}

// Everything that must hold before the Adyen chain starts: the fields Adyen
// needs, plus the merchant's own consent.
export function validateOnboardingSubmission(input: OnboardingSubmissionInput): OnboardingFieldErrors {
  return { ...validateOnboardingFields(input), ...validateOnboardingConsent(input.agreement) };
}

// ── Malformed-only checking (the rep's "Review What We Know" step) ─────────
//
// The rep step needs a different split than the rules above: a MALFORMED
// value should block (it reaches the customer as fact, and 422s Adyen later),
// but a merely MISSING one should only warn (the customer fills it in
// themselves downstream). validateOnboardingFields conflates the two — every
// required check above is "if blank, required-error; else if malformed,
// malformed-error" — so the malformed branch never even runs for a blank
// field.
//
// Rather than re-implement each format rule to tell "missing" from "wrong"
// apart, stripBlanks swaps every required-but-blank field for a placeholder
// that's ALREADY valid under that same rule (a real state code, a real ZIP
// shape). The required branch stops firing because the field isn't blank
// anymore, and the format branch trivially passes because the placeholder is
// well-formed — so validateOnboardingFields(stripBlanks(input)) reports only
// fields that are non-blank but wrong. No format rule is duplicated: each
// placeholder is just a value the existing rule already accepts.
//
// legalName/address/city have no format check beyond "not blank", so any
// non-blank placeholder clears them; state/zip need one that's also
// well-formed, and the phones need one isE164Convertible accepts.
//
// This list GREW on 2026-10-14 with `tenantFieldErrors` — business phone and
// the owner's name/email/phone became required, and without a placeholder
// apiece every rep would suddenly be blocked on an owner phone number they
// often don't have yet. Keeping them here is the whole of the "gate blocks,
// rep stays lenient" decision: the rep may create a prospect with these
// blank, the merchant's own onboarding form requires them, and
// `isReadyForAioProvisioning` refuses to attempt a create until they're
// actually there. Nothing fails — it waits, where somebody can see it.
//
// Only `business.website` and `ownerContact.altEmail` are genuinely optional
// now, and both are already no-ops when blank.
const BLANK_PLACEHOLDER: Partial<Record<keyof BusinessInfo, string>> = {
  legalName: "placeholder",
  address: "placeholder",
  city: "placeholder",
  state: "CA",
  zip: "00000",
  phone: "5550000000",
};

const BLANK_OWNER_PLACEHOLDER: Partial<Record<keyof OwnerContact, string>> = {
  firstName: "placeholder",
  lastName: "placeholder",
  email: "placeholder@example.com",
  phone: "5550000000",
};

// The DBA pieces are only required once a DBA STREET is given, so they're
// placeholdered only in that case — otherwise a rep who left the whole DBA
// address blank would get three placeholders standing in for a rule that was
// never going to fire.
const BLANK_DBA_PLACEHOLDER: Partial<Record<keyof BusinessInfo, string>> = {
  dbaCity: "placeholder",
  dbaState: "CA",
  dbaZip: "00000",
};

export function stripBlanks(input: OnboardingValidationInput): OnboardingValidationInput {
  const business: Partial<BusinessInfo> = { ...(input.business ?? {}) };
  const fill = (target: Record<string, string>, defaults: Partial<Record<string, string>>) => {
    for (const [key, placeholder] of Object.entries(defaults)) {
      if (!s(target[key])) target[key] = placeholder!;
    }
  };
  fill(business as Record<string, string>, BLANK_PLACEHOLDER);
  if (s(business.dbaAddress)) fill(business as Record<string, string>, BLANK_DBA_PLACEHOLDER);

  const ownerContact: Partial<OwnerContact> = { ...(input.ownerContact ?? {}) };
  fill(ownerContact as Record<string, string>, BLANK_OWNER_PLACEHOLDER);

  return { business, ownerContact };
}
