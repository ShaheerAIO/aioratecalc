// What Adyen actually needs before the legal-entity → onboarding-link chain in
// adapters/adyen.ts can succeed. Adyen 422s on a missing or malformed
// registered address, and that rejection used to be invisible: the customer
// saw a success screen with no link to click.
//
// Deliberately PURE and dependency-free apart from utils.ts and consent.ts
// (both also pure) so the same rules run in the browser (CustomerOnboardStep,
// for inline messages) and in the Server Action (the real gate). It must never
// import adapters/adyen.ts, pricing.ts, or anything under lib/db — those are
// server-only and would be pulled into the client bundle.
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

  // Optional, but must be usable if given.
  const phone = s(biz.phone);
  if (phone && !isE164Convertible(phone)) {
    errors["business.phone"] = "Enter a 10-digit phone number, e.g. 555-000-0000.";
  }

  const website = s(biz.website);
  if (website && !isWebsiteLike(website)) {
    errors["business.website"] = "Use a full web address, e.g. yourrestaurant.com — or leave it blank.";
  }

  const email = s(owner.email);
  if (email && !EMAIL.test(email)) {
    errors["ownerContact.email"] = "Enter a valid email address.";
  }

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
// well-formed. Optional fields (phone, website, ownerContact.email) are left
// alone — they already produce no error when blank.
const BLANK_PLACEHOLDER: Partial<Record<keyof BusinessInfo, string>> = {
  legalName: "placeholder",
  address: "placeholder",
  city: "placeholder",
  state: "CA",
  zip: "00000",
};

export function stripBlanks(input: OnboardingValidationInput): OnboardingValidationInput {
  const business: Partial<BusinessInfo> = { ...(input.business ?? {}) };
  for (const key of Object.keys(BLANK_PLACEHOLDER) as Array<keyof BusinessInfo>) {
    if (!s(business[key] as string | undefined)) {
      (business as Record<string, string>)[key] = BLANK_PLACEHOLDER[key]!;
    }
  }
  return { business, ownerContact: input.ownerContact };
}
