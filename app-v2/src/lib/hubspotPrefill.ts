// Turns a HubSpot Company (+ its owner Contact) into the app's own shapes, so a
// rep arriving from the Company deep link gets an application already filled in
// and the customer is left with as little to type as possible.
//
// Pure and network-free on purpose — same posture as quoting.ts: unit-testable,
// and safe to import from a client component. Every field is optional: a
// property HubSpot doesn't have becomes an ABSENT key, never an empty string and
// never a default. The form's own defaults then survive, and the provenance list
// stays honest about what actually came from HubSpot.

import { usStateCode } from "@/lib/utils";
import type { HubspotCompanyProfile, HubspotContact } from "@/lib/adapters/hubspot";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";

// ── Normalizers ─────────────────────────────────────────────────────────────

/**
 * HubSpot's `country` is free text — "USA", "United States", "United states",
 * "US" all occur. Anything else (including a bare "CA", which is Canada's ISO
 * code and not a US state here) passes through uppercased rather than being
 * coerced to US: a non-US company is a fact the caller needs to see, since the
 * Adyen path hardcodes country "US".
 */
export function normalizeCountry(country: string | null | undefined): string | undefined {
  const c = (country ?? "").trim();
  if (!c) return undefined;
  const key = c.toLowerCase().replace(/[.\s]+/g, " ").trim();
  if (["us", "usa", "u s a", "united states", "united states of america"].includes(key)) return "US";
  return c.toUpperCase();
}

/**
 * HubSpot phones arrive as E.164 ("+15106680242"), part-formatted
 * ("+1 (925) 293-6872"), or plain ("(951) 736-7571"). The form fields are free
 * text with a "555-000-0000" placeholder, so US numbers render in that shape.
 * Anything that isn't a 10-digit US number is passed through trimmed rather
 * than mangled — an international number must stay dialable.
 */
export function normalizePhone(phone: string | null | undefined): string | undefined {
  const raw = (phone ?? "").trim();
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return raw;
  return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}

/**
 * HubSpot's `address` is sometimes the whole address ("12303 Limonite Ave Ste
 * 710, Eastvale, CA 91752, United States") while city/state/zip are ALSO their
 * own properties. The app's `address` is the street line only, and it goes
 * straight to Adyen's registeredAddress.street, so drop the tail — but only
 * when we can prove it's a tail, i.e. the segment right after the first comma
 * is the city we already have. Anything else is left exactly as entered.
 */
export function streetLine(address: string | null | undefined, city: string | null | undefined): string | undefined {
  const raw = (address ?? "").trim();
  if (!raw) return undefined;
  const parts = raw.split(",");
  if (parts.length < 2) return raw;
  const c = (city ?? "").trim().toLowerCase();
  if (!c || parts[1].trim().toLowerCase() !== c) return raw;
  const street = parts[0].trim();
  return street || raw;
}

// `moduels` is a checkbox enum: "POS;MPOS;Kiosk". Only two of its eleven
// options are ORDERING CHANNELS in quoting.ts's sense (ORDER_POINT_CHANNELS);
// POS / MPOS / Kiosk are physical hardware that gets counted from quote lines
// instead, and Catering / Menu Board / Scheduling / Payroll / Marketing aren't
// ordering points at all. Unmapped tokens are dropped rather than guessed —
// each channel is a whole ordering point, and an extra one can flip the
// platform tier ($433/mo). "phone_ai" has no HubSpot counterpart.
//
// "website" is deliberately NOT mapped: the ordering point moved off the
// channel and onto the Website PRODUCT (hubspotProductId 333275576048,
// quoting.ts 2026-10-13) — a HubSpot module token can't prefill a picked
// product, so a deal with the Website module no longer seeds an ordering
// point from this mapper. Don't re-add "website" here; it names a channel id
// that no longer exists in ORDER_POINT_CHANNELS and is silently dropped by
// deriveOrderPoints.
const MODULE_TO_CHANNEL: Record<string, string> = {
  "qr/online ordering": "qr",
  "3po": "third_party_delivery",
};

/** Split `moduels` into ordering-point channel ids. Unknown tokens are dropped. */
export function channelsFromModules(modules: string | null | undefined): string[] {
  const out: string[] = [];
  for (const token of (modules ?? "").split(";")) {
    const channel = MODULE_TO_CHANNEL[token.trim().toLowerCase()];
    if (channel && !out.includes(channel)) out.push(channel);
  }
  return out;
}

// `current_pos` is the incumbent POS, which for AIO's market is usually also the
// incumbent processor — close enough to prefill a rep-editable "Current
// Processor" field. These three options are NOT processors and are dropped:
// "Other" carries no information, DoorDash is a delivery marketplace, and
// Chowly is order-integration middleware.
const NON_PROCESSOR_POS = ["other", "doordash", "chowly"];

/** A `current_pos` value usable as the current PROCESSOR, or undefined. */
export function processorFromPos(currentPos: string | null | undefined): string | undefined {
  const pos = (currentPos ?? "").trim();
  if (!pos || NON_PROCESSOR_POS.includes(pos.toLowerCase())) return undefined;
  return pos;
}

/**
 * A human business description. HubSpot's own `description` wins when it's
 * there; otherwise cuisine + restaurant type are stitched into a short phrase.
 * Deliberately prose, not a code: see the MCC note on buildProspectPrefill.
 */
export function businessDescription(
  company: Pick<HubspotCompanyProfile, "description" | "cuisineType" | "industryType">
): string | undefined {
  const description = (company.description ?? "").trim();
  if (description) return description;
  const cuisine = (company.cuisineType ?? "").trim();
  const industry = (company.industryType ?? "").trim();
  // "Other" is the cuisine picker's catch-all and says nothing.
  const parts = [cuisine.toLowerCase() === "other" ? "" : cuisine, industry].filter(Boolean);
  return parts.length ? parts.join(" — ") : undefined;
}

// ── The mapper ──────────────────────────────────────────────────────────────

/**
 * Everything the HubSpot Company can prefill, in the app's own shapes.
 *
 * The three record halves are PARTIALS by design — they're merged over the
 * form's existing state, so a key that isn't here means "HubSpot didn't know",
 * not "clear this field".
 */
export type ProspectPrefill = {
  business: Partial<BusinessInfo>;
  ownerContact: Partial<OwnerContact>;
  processing: Partial<ProcessingInfo>;
  /** Ordering-point channel ids from `moduels` (quoting.ts vocabulary). */
  channels: string[];
  /** Normalized ISO-ish country. BusinessInfo has no country field — this is a signal, not a form value. */
  country?: string;
  /** HubSpot "Restaurant Type" verbatim (hospitality | Food Truck | TSR | …). */
  industryType?: string;
  /** Franchise posture verbatim (Inderpendant | Franchisee | Franchisor | Enterprise). */
  ownershipType?: string;
  /** Which association label the owner contact came from, when there was one. */
  contactSource?: string;
  /**
   * Dotted paths of everything above that came from HubSpot, e.g.
   * "business.city". The UI uses it for "from HubSpot" hints; it's derived from
   * the built objects rather than tracked by hand, so it can't drift.
   */
  fromHubspot: string[];
};

/** Drops undefined values so a Partial only carries keys HubSpot actually filled. */
function compact<T extends object>(obj: { [K in keyof T]?: string | undefined }): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}

/** `mcc_code` is free text in HubSpot; only a 4-digit code is a usable MCC. */
export function mccFromCompany(mccCode: string | null | undefined): string | undefined {
  const code = (mccCode ?? "").trim();
  return /^\d{4}$/.test(code) ? code : undefined;
}

/**
 * NOT mapped, on purpose:
 *  - MCC from anything but `mcc_code`. The nearest proxies don't stand in for
 *    one: `industrytype`'s dominant value is "hospitality", a catch-all that
 *    spans 5812/5813/5814. A wrong MCC drives interchange and the Adyen
 *    industry code, so without `mcc_code` the field stays empty for a human.
 *  - bizType. `ownership_type` is a FRANCHISE posture (Franchisee/Franchisor),
 *    not a legal-entity type; nothing in HubSpot says LLC vs corp.
 *  - yearsInBusiness / annualRevenue. `founded_year` and `annualrevenue` are
 *    ~0% populated portal-wide.
 *  - Ticket and card-present split. No HubSpot property carries either; they
 *    come from the statement analysis.
 *  - Monthly volume, from `processing_volume` ("Processing Volume $") —
 *    REVERSED 2026-10-13 (product owner: "get rid of the prefilled monthly
 *    volume, just make it empty"). The property itself is real and genuinely
 *    populated — 24 companies carried a value on 2026-09-25, checked against
 *    the live portal, and its near-namesake `monthly_card_volume` is the empty
 *    one — so this is NOT a rediscovery of the old "it's empty portal-wide"
 *    mistake. The problem is what a prefilled number looks like once it's
 *    sitting in the form: indistinguishable from an answer the rep actually
 *    gave, and `monthlyVolume` feeds both the rate matrix (picks the
 *    card-present rate) and the margin floor (can refuse the quote) — so a
 *    stale or wrong value silently prices the deal. The number parser this
 *    used to call (`monthlyVolumeFromCompany`, rejected non-positive/blank
 *    values the same way `mccFromCompany` rejects a non-4-digit code) was
 *    deleted with it; it had no other caller.
 */
export function buildProspectPrefill(
  company: HubspotCompanyProfile | null | undefined,
  contact?: HubspotContact | null,
  options: {
    /**
     * Whether the Company's own `location_email` may stand in when there is no
     * contact email. Callers turn it OFF once the company is known to have
     * contacts: at that point the rep is choosing a PERSON, and an address that
     * belongs to the location would be a guess dressed as their pick.
     */
    companyEmailFallback?: boolean;
  } = {}
): ProspectPrefill {
  const { companyEmailFallback = true } = options;
  const empty: ProspectPrefill = { business: {}, ownerContact: {}, processing: {}, channels: [], fromHubspot: [] };
  if (!company) return empty;

  const name = (company.name ?? "").trim();
  // `name` is the trading name, so it seeds the DBA only. The legal name comes
  // from HubSpot's legal-name property, which EasyOB writes back after the rep
  // types it — never from `name`, which would pass the trading name off as the
  // registered one on every quote.
  const business = compact<BusinessInfo>({
    legalName: (company.legalName ?? "").trim() || undefined,
    dba: name || undefined,
    // The legal address comes from the legal properties only — see both blocks below.
    phone: normalizePhone(company.phone),
    // `website` is the real URL; `domain` is the bare host and only a fallback.
    // Neither gets an https:// prefix here — adapters/adyen.ts already adds one.
    website: (company.website ?? "").trim() || (company.domain ?? "").trim() || undefined,
  });

  // The HubSpot Company IS the restaurant, so its `address` is where the
  // business OPERATES, and that is the only thing it seeds (product owner,
  // 2026-10-12: "pull operating addy from hubspot, it's the one most likely
  // hubspot actually carries, then we ask for the legal addy").
  //
  // It used to seed the legal address as well, on the grounds that HubSpot
  // has no separate legal one. That was the wrong trade: a merchant whose
  // owner registered at home or through an accountant would have had the
  // restaurant's own address passed off as the registered one — on a form
  // whose whole purpose is to state what the state has on file, and which
  // Adyen and Check then verify against. Blank is honest; the merchant fills
  // it on their onboarding form, where `validateOnboardingFields` requires
  // it, and `saveMyApplicationOnboardingAction` writes it back to HubSpot's
  // own legal_*_as_registered_with_government properties.
  //
  // Only ever filled as a WHOLE: a city with no street is not a location.
  const operatingStreet = streetLine(company.address, company.city);
  if (operatingStreet) {
    Object.assign(business, compact<BusinessInfo>({
      dbaAddress: operatingStreet,
      dbaCity: (company.city ?? "").trim() || undefined,
      dbaState: usStateCode(company.state ?? undefined),
      dbaZip: (company.zip ?? "").trim() || undefined,
    }));
  }

  // The LEGAL address reads back from the two legal properties, and ONLY from
  // them. `company.address` is still barred from reaching these fields — the
  // paragraph above is the whole reason this prefill exists in its current
  // shape, and reading a registered address out of the operating one by
  // another route would reverse it.
  //
  // What makes this worth reading at all is that EasyOB now fills those
  // properties itself: the rep sends the legal address with the quote link
  // (`syncCompanyDetails`) and the merchant confirms it on their onboarding
  // form (`syncLegalAddressBestEffort`). So on a SECOND quote for the same
  // company, the answer someone already gave comes back instead of being
  // asked for again. On a first quote they're empty and nothing is seeded,
  // which is the old behaviour exactly.
  //
  // Street-gated, same whole-or-nothing rule as the operating address. There
  // is no legal state or ZIP property in this portal, so those two stay blank
  // for the merchant's onboarding form to collect — a partly-known registered
  // address is still better than none, since `validateOnboardingFields`
  // requires all four and will stop a submission that's short.
  const legalStreet = streetLine(company.legalStreet, company.legalCity);
  if (legalStreet) {
    Object.assign(business, compact<BusinessInfo>({
      address: legalStreet,
      city: (company.legalCity ?? "").trim() || undefined,
    }));
  }

  const ownerContact = compact<OwnerContact>({
    firstName: contact?.firstName ?? undefined,
    lastName: contact?.lastName ?? undefined,
    title: contact?.jobTitle ?? undefined,
    // The Company's own location_email is a weak fallback (~1% populated) but
    // costs nothing when the contact read didn't yield an address.
    email: contact?.email ?? (companyEmailFallback ? company.email : null) ?? undefined,
    phone: normalizePhone(contact?.phone),
  });

  const processing = compact<ProcessingInfo>({
    // The rep's own answer, once written back, beats the POS-derived guess.
    currentProcessor: (company.previousProcessor ?? "").trim() || processorFromPos(company.currentPos),
    mcc: mccFromCompany(company.mccCode),
    businessDescription: businessDescription(company),
  });

  const channels = channelsFromModules(company.modules);

  const prefill: ProspectPrefill = {
    business,
    ownerContact,
    processing,
    channels,
    ...(normalizeCountry(company.country) ? { country: normalizeCountry(company.country) } : {}),
    ...(company.industryType ? { industryType: company.industryType } : {}),
    ...(company.ownershipType ? { ownershipType: company.ownershipType } : {}),
    ...(contact?.associationLabel ? { contactSource: contact.associationLabel } : {}),
    fromHubspot: [],
  };

  prefill.fromHubspot = [
    ...Object.keys(business).map(k => `business.${k}`),
    ...Object.keys(ownerContact).map(k => `ownerContact.${k}`),
    ...Object.keys(processing).map(k => `processing.${k}`),
    ...(channels.length ? ["channels"] : []),
  ];

  return prefill;
}

// ── Choosing among several contacts ─────────────────────────────────────────
//
// A company can have many contacts and nothing in HubSpot says which one is
// THIS quote's. Guessing by association label picked the wrong person often
// enough to be a problem, so the rep chooses. The one case with no choice to
// make is a company with exactly one contact.

/**
 * The contact to preselect: only ever when there is nothing to choose between.
 * That is a lone contact overall, or a lone contact on the DEAL — the person
 * the rep attached to this very deal is the answer even when the company's
 * wider roster sits underneath. Two or more on the deal is a real choice.
 */
export function initialContactChoice(contacts: HubspotContact[]): string | null {
  if (contacts.length === 1) return contacts[0].id;
  const onDeal = contacts.filter(c => c.source === "deal");
  return onDeal.length === 1 ? onDeal[0].id : null;
}

/**
 * The prefill for a given contact choice. `selectedId` null (or not in the
 * list) leaves the owner-contact fields for the rep to fill or pick — and once
 * the company has contacts, the company's own location email is no longer
 * offered as a stand-in for one.
 */
export function buildProspectPrefillForContact(
  company: HubspotCompanyProfile | null | undefined,
  contacts: HubspotContact[],
  selectedId: string | null
): ProspectPrefill {
  const contact = contacts.find(c => c.id === selectedId) ?? null;
  return buildProspectPrefill(company, contact, { companyEmailFallback: contacts.length === 0 });
}

/** How a contact reads in the dropdown: name, then whatever identifies them. */
export function contactOptionLabel(contact: HubspotContact): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  const parts = [name, contact.jobTitle, contact.email].filter(Boolean);
  const head = parts.length ? parts.join(" · ") : `Contact ${contact.id}`;
  return contact.associationLabel ? `${head} (${contact.associationLabel})` : head;
}
