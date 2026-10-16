// The merchant's confirmation of their own details — the step that now stands
// between a rep sending a lead link and a HubSpot quote existing at all.
//
// WHY THIS EXISTS. Publishing a HubSpot quote is a one-way door: no API edit
// (400 LOCKED), no delete, no void. Until 2026-10-15 the rep's link-send
// published it immediately (`publishAtSend`), which meant the merchant's
// billing contact and addresses were frozen onto an unamendable document
// exactly as the rep had typed them — and a rep who spotted their own typo
// afterwards had no way back. The product owner's fix reverses the trigger:
// the link-send builds nothing, the merchant reviews and corrects what we
// hold, and CONFIRMING is what builds and publishes. Everything the rep can
// still change, they can change right up until this moment.
//
// Pure — the DB work lives in lib/actions/leadConfirm.ts. Same split as
// leadDetails.ts and leadAccount.ts, for the same reason: these rules decide
// what a PUBLIC, unauthenticated token may rewrite, and that deserves to be
// tested without a database.
//
// HOW THIS DIFFERS FROM leadDetails.ts, which it sits beside rather than
// replaces. That module is a last-resort REPAIR of fields that are missing,
// and it deliberately writes only paths that are currently IN ERROR, so a
// public token can never overwrite a value that is already good. This module
// is a CONFIRMATION, and correcting a value that looks perfectly valid but is
// simply wrong — the billing email, the street — is the entire point of it.
// So the fence here is the allow-list alone, and the allow-list is doing more
// work as a result. Both modules survive: leadDetails.ts still covers rows
// that paid under the old rule and are holding on a blank, which can no longer
// happen to a new row because confirmation requires the full validator to pass.

import { validateOnboardingFields, type OnboardingFieldErrors } from "@/lib/onboardingValidation";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";

export type LeadConfirmInput = {
  business?: Partial<BusinessInfo> | null;
  ownerContact?: Partial<OwnerContact> | null;
  billingContact?: Partial<OwnerContact> | null;
  processing?: Partial<ProcessingInfo> | null;
};

export type LeadConfirmSections = {
  business: Partial<BusinessInfo>;
  ownerContact: Partial<OwnerContact>;
  billingContact: Partial<OwnerContact> | null;
  processing: Partial<ProcessingInfo>;
};

/**
 * Every path this form may write, and nothing else.
 *
 * An allow-LIST rather than a derivation, for the same reason leadDetails.ts
 * keeps one: this is a surface where an unauthenticated token writes to the
 * application, and a path that isn't named here cannot be written through it
 * however the form posts.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each one:
 *
 *   - `processing.monthlyVolume` / `processing.avgTicket`. These ARE the
 *     pricing basis — /rep/prospects/new builds `quoteConfig` straight out of
 *     them, and they drive the rate matrix, the margin floor and
 *     MIN_MONTHLY_PROCESSING_REVENUE. Letting the merchant move them would
 *     re-price a quote the rep has already cleared both floors on, seconds
 *     before it is published irreversibly. They are SHOWN on the form, locked,
 *     so the merchant can see what their quote was priced on and ring their
 *     rep if it's wrong — the rep can still change it, which is the whole
 *     point of not publishing at send (product owner, 2026-10-15).
 *   - the card rates, the margin, the products. Same reason, plus the standing
 *     rule that no customer-facing surface may reach AIO's margin.
 *   - `processing.cardPresentPct`. An assumption (CONFIG_QUOTE_ASSUMPTIONS),
 *     not something a merchant can answer, and it reweights the blended
 *     effective rate.
 *   - `ownerContact.altEmail`. A second DELIVERY address for the rep's own
 *     link emails, not a fact about the business.
 *
 * Everything else the rep can type about the merchant is here, which is what
 * "show all the same fields that the rep sees" asks for.
 */
export const CONFIRMABLE_PATHS: readonly string[] = [
  // Legal identity — what the state has on file. Required by
  // validateOnboardingFields and sent to AIO's tenant create.
  "business.legalName",
  "business.bizType",
  "business.address",
  "business.city",
  "business.state",
  "business.zip",
  // Operating address. Blank as a whole means "same as the legal address";
  // a street with no city/state/ZIP is refused by tenantFieldErrors.
  "business.dbaAddress",
  "business.dbaCity",
  "business.dbaState",
  "business.dbaZip",
  // The business itself.
  "business.dba",
  "business.phone",
  "business.website",
  "business.ein",
  // The owner — and the SIGNER: `resolveSigner` puts `ownerContact.email` on
  // the HubSpot quote, so this is the one section where a typo is both the
  // most likely and the most expensive.
  "ownerContact.firstName",
  "ownerContact.lastName",
  "ownerContact.title",
  "ownerContact.email",
  "ownerContact.phone",
  // Who gets the invoices, when that isn't the owner.
  "billingContact.firstName",
  "billingContact.lastName",
  "billingContact.email",
  "billingContact.phone",
  // Processing facts that carry no price.
  "processing.mcc",
  "processing.currentProcessor",
  "processing.previouslyTerminated",
  "processing.bankruptcy",
];

const ALLOWED = new Set(CONFIRMABLE_PATHS);

type SectionKey = keyof LeadConfirmSections;

/**
 * Merge the merchant's answers into the application's own sections.
 *
 * Only allow-listed paths are applied; everything else in `values` is dropped
 * silently, whatever the form posts. Unlike `applyLeadDetails`, a path IS
 * applied when its current value is already valid — that is the widening this
 * module exists for, and the reason the list above is the only fence.
 *
 * `billingContact` stays NULL when the merchant gives nothing for it, rather
 * than becoming an object of empty strings: null is how the rest of the
 * codebase reads "they bill the owner", and `syncBillingContact` keys on a
 * non-blank email.
 */
export function applyLeadConfirmation(
  current: LeadConfirmInput,
  values: Record<string, string>,
): LeadConfirmSections {
  const sections: Record<SectionKey, Record<string, unknown>> = {
    business: { ...(current.business ?? {}) },
    ownerContact: { ...(current.ownerContact ?? {}) },
    billingContact: { ...(current.billingContact ?? {}) },
    processing: { ...(current.processing ?? {}) },
  };

  for (const [path, raw] of Object.entries(values)) {
    if (!ALLOWED.has(path)) continue;
    const [section, key] = path.split(".") as [SectionKey, string];
    sections[section][key] = (raw ?? "").trim();
  }

  const billing = sections.billingContact;
  const hasBilling = Object.values(billing).some(v => String(v ?? "").trim());

  return {
    business: sections.business as Partial<BusinessInfo>,
    ownerContact: sections.ownerContact as Partial<OwnerContact>,
    billingContact: hasBilling ? (billing as Partial<OwnerContact>) : null,
    processing: sections.processing as Partial<ProcessingInfo>,
  };
}

/**
 * What's still wrong after the merge, keyed by the same dotted paths the form
 * renders its inputs under.
 *
 * The STRICT `validateOnboardingFields` — the same function
 * `isReadyForAioProvisioning` runs — so a confirmed row always satisfies the
 * AIO provisioning gate. That is the point of making this a gate rather than
 * a nicety: the ordering that broke `prospect_1792016501714` (pay first, fill
 * the form afterwards, cron attempts in between) cannot arise when the form
 * comes BEFORE the payment.
 *
 * Unlike `remainingErrors` in leadDetails.ts this does not filter to the
 * allow-list, and it must not: everything the validator can complain about is
 * editable here, so an unfiltered error always has an input box to land in.
 * If a path ever leaves CONFIRMABLE_PATHS while staying required, the error
 * would have nowhere to go — `unreachableErrorPaths` below is the test hook
 * that asserts that hasn't happened.
 */
export function confirmationErrors(next: LeadConfirmInput): OnboardingFieldErrors {
  return { ...validateOnboardingFields(next), ...confirmationOnlyErrors(next) };
}

/**
 * The label each field is asked for under, shared by the form and the
 * "still needed" summary beneath its button.
 *
 * One map rather than a label on the input and a second copy in the summary:
 * a merchant told to supply "Trading name" who is looking at a box marked
 * "DBA" has been given a puzzle, and two literals drift the moment one is
 * reworded.
 */
export const FIELD_LABELS: Record<string, string> = {
  "business.legalName": "Legal business name, as registered",
  "business.dba": "Trading name (DBA)",
  "business.bizType": "Entity type",
  "business.ein": "Federal EIN",
  "business.phone": "Business phone",
  "business.website": "Website",
  "business.address": "Street address",
  "business.city": "City",
  "business.state": "State",
  "business.zip": "ZIP",
  "business.dbaAddress": "Operating street address",
  "business.dbaCity": "City",
  "business.dbaState": "State",
  "business.dbaZip": "ZIP",
  "ownerContact.firstName": "First name",
  "ownerContact.lastName": "Last name",
  "ownerContact.title": "Title",
  "ownerContact.email": "Email",
  "ownerContact.phone": "Mobile",
  "billingContact.firstName": "First name",
  "billingContact.lastName": "Last name",
  "billingContact.email": "Email",
  "billingContact.phone": "Phone",
  "processing.mcc": "Merchant category code",
  "processing.currentProcessor": "Current processor",
};

/**
 * Which panel a field sits in, used to QUALIFY it in the "still needed"
 * summary and nowhere else.
 *
 * The labels above are the ones printed beside the boxes, where the panel
 * heading is already on screen — so "City" and "First name" are unambiguous
 * there and prefixing them would just be noise. Pulled out of that context and
 * listed under a disabled button they are not: this form asks for a city
 * twice and a first name twice. Hence one label, qualified at the one place
 * the context is missing.
 */
const SECTION_OF: Record<string, string> = {
  "business.address": "Registered address",
  "business.city": "Registered address",
  "business.state": "Registered address",
  "business.zip": "Registered address",
  "business.dbaAddress": "Operating address",
  "business.dbaCity": "Operating address",
  "business.dbaState": "Operating address",
  "business.dbaZip": "Operating address",
  "ownerContact.firstName": "Owner",
  "ownerContact.lastName": "Owner",
  "ownerContact.title": "Owner",
  "ownerContact.email": "Owner",
  "ownerContact.phone": "Owner",
  "billingContact.firstName": "Billing contact",
  "billingContact.lastName": "Billing contact",
  "billingContact.email": "Billing contact",
  "billingContact.phone": "Billing contact",
};

// EINs are always nine digits, written NN-NNNNNNN. Checked for SHAPE as well
// as presence, for the same reason `validateOnboardingFields` checks the ZIP
// and the phone rather than merely requiring them: this is the one tax id AIO
// stores, it lands on a CRM record a human later reads as fact, and nothing
// downstream verifies it — Adyen and Check each collect and verify their own.
// An eight-digit typo would otherwise sit there looking authoritative.
const EIN = /^\d{2}-?\d{7}$/;

const blank = (v: string | undefined | null) => !(v ?? "").trim();

/**
 * What the CONFIRMATION STEP requires on top of the tenant rules.
 *
 * Deliberately NOT folded into `validateOnboardingFields` (2026-10-15, product
 * owner: everything on this form is required). That function is also what
 * `isReadyForAioProvisioning` runs, and a field added there is a field every
 * ALREADY-PAID row is suddenly missing — the provisioning cron would hold them
 * at `missing_business_details` forever, for want of an EIN nobody had ever
 * been asked for. It is also what the rep form checks through `stripBlanks`,
 * where the standing decision is that reps stay lenient.
 *
 * So these are requirements of the MOMENT, not of the tenant: the merchant is
 * in front of the form, every box is on screen, and this is the last point
 * anything can be corrected. The provisioning gate is untouched.
 *
 * The billing contact is required only when the merchant says it is someone
 * other than the owner. Ticking "same as the owner above" posts an all-blank
 * contact, which `applyLeadConfirmation` reads as null — that IS an answer,
 * and demanding four more boxes for a person already named above would be
 * asking them to type it twice.
 */
function confirmationOnlyErrors(input: LeadConfirmInput): OnboardingFieldErrors {
  const errors: OnboardingFieldErrors = {};
  const biz = input.business ?? {};

  if (blank(biz.dba)) errors["business.dba"] = "Enter the name customers know you by.";
  if (blank(biz.bizType)) errors["business.bizType"] = "Choose how the business is registered.";
  if (blank(biz.ein)) errors["business.ein"] = "Enter the business's 9-digit federal EIN.";
  else if (!EIN.test((biz.ein ?? "").trim())) errors["business.ein"] = "An EIN is 9 digits, e.g. 12-3456789.";

  if (blank(input.ownerContact?.title)) errors["ownerContact.title"] = "Enter their role, e.g. Owner.";

  const billing = input.billingContact;
  if (billing) {
    if (blank(billing.firstName)) errors["billingContact.firstName"] = "Enter the billing contact's first name.";
    if (blank(billing.lastName)) errors["billingContact.lastName"] = "Enter the billing contact's last name.";
    if (blank(billing.email)) errors["billingContact.email"] = "Enter the billing contact's email address.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billing.email!.trim())) {
      errors["billingContact.email"] = "Enter a valid email address.";
    }
    if (blank(billing.phone)) errors["billingContact.phone"] = "Enter the billing contact's phone number.";
  }

  return errors;
}

/**
 * The labels of everything still outstanding, in the order the form asks for
 * them — so a disabled button can say what it is waiting on.
 *
 * Without this the merchant meets a dead button and no reason, which is the
 * standing failure mode of a form that validates only on submit and then
 * refuses to let you submit.
 */
export function missingConfirmationFields(input: LeadConfirmInput): string[] {
  const errors = confirmationErrors(input);
  const ordered = Object.keys(FIELD_LABELS).filter(p => errors[p]);
  const rest = Object.keys(errors).filter(p => !(p in FIELD_LABELS));
  return [...ordered, ...rest].map(p => {
    const label = FIELD_LABELS[p] ?? p;
    const section = SECTION_OF[p];
    return section ? `${section} — ${label}` : label;
  });
}

/**
 * Any path the validator can REQUIRE that this form cannot edit. Always empty
 * — asserted by a test, so that narrowing the allow-list or adding a required
 * field can't silently produce a message the merchant is shown but given no
 * way to act on.
 */
export function unreachableErrorPaths(): string[] {
  const nothing = confirmationErrors({});
  return Object.keys(nothing).filter(p => !ALLOWED.has(p));
}
