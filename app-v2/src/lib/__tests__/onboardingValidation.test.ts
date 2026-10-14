import { describe, it, expect } from "vitest";
import {
  stripBlanks,
  validateOnboardingConsent,
  validateOnboardingFields,
  validateOnboardingSubmission,
} from "@/lib/onboardingValidation";
import type { AgreementInfo, BusinessInfo, OwnerContact } from "@/types/merchant";

// The set adapters/adyen.ts's legal-entity → onboarding-link chain needs:
// organization.legalName plus a complete registeredAddress (street, city,
// 2-letter stateOrProvince, postalCode). Everything else on the form is
// format-checked only if it's filled in.
const BUSINESS: BusinessInfo = {
  legalName: "Torta Palace LLC",
  dba: "Torta Palace",
  bizType: "llc",
  address: "1200 Wilshire Blvd",
  city: "Los Angeles",
  state: "CA",
  zip: "90017",
  phone: "555-000-0000",
  website: "tortapalace.com",
  yearsInBusiness: "5",
  annualRevenue: "1200000",
};

const OWNER: OwnerContact = {
  firstName: "Ana",
  lastName: "Reyes",
  title: "Owner",
  email: "ana@tortapalace.com",
  phone: "555-000-0001",
};

const check = (biz: Partial<BusinessInfo> = {}, owner: Partial<OwnerContact> = {}) =>
  validateOnboardingFields({ business: { ...BUSINESS, ...biz }, ownerContact: { ...OWNER, ...owner } });

describe("validateOnboardingFields — the all-valid case", () => {
  it("passes a fully filled, well-formed form", () => {
    expect(check()).toEqual({});
  });

  // What is STILL optional, after tenantFieldErrors made the AIO-facing set
  // required on 2026-10-14: the website and the second email, and nothing
  // else. The phone and the owner's email used to be on this list — both are
  // sent to AIO's business create, which 400s on a blank.
  it("passes with the genuinely optional fields left blank", () => {
    expect(check({ dba: "", website: "", yearsInBusiness: "" }, { title: "", altEmail: "" })).toEqual({});
  });

  it("requires every field AIO's tenant create reads", () => {
    const e = check({ phone: "" }, { firstName: "", lastName: "", email: "", phone: "" });
    expect(Object.keys(e).sort()).toEqual([
      "business.phone",
      "ownerContact.email", "ownerContact.firstName", "ownerContact.lastName", "ownerContact.phone",
    ]);
  });

  // The live failure this rule exists for: prospect_1792016501714, 2026-10-14,
  // "pocInfo.0.contactNo should not be empty" — one blank box, five burned
  // attempts, and a checklist telling the merchant no action was needed.
  it("flags the owner phone that failed AIO's business create", () => {
    expect(Object.keys(check({}, { phone: "" }))).toEqual(["ownerContact.phone"]);
  });

  it("rejects an owner phone that E.164 conversion can't handle", () => {
    expect(Object.keys(check({}, { phone: "call the office" }))).toEqual(["ownerContact.phone"]);
  });

  it("accepts a spelled-out state and a ZIP+4", () => {
    expect(check({ state: "California", zip: "90017-1234" })).toEqual({});
  });
});

describe("validateOnboardingFields — each required field missing", () => {
  // One field at a time: a validator that only reports the first problem sends
  // the customer round the loop once per blank box.
  const required: Array<[keyof BusinessInfo, string]> = [
    ["legalName", "business.legalName"],
    ["address", "business.address"],
    ["city", "business.city"],
    ["state", "business.state"],
    ["zip", "business.zip"],
  ];

  for (const [field, path] of required) {
    it(`flags a missing ${field}`, () => {
      const errors = check({ [field]: "" });
      expect(Object.keys(errors)).toEqual([path]);
      expect(errors[path]).toBeTruthy();
    });

    it(`flags a whitespace-only ${field}`, () => {
      expect(Object.keys(check({ [field]: "   " }))).toEqual([path]);
    });
  }

  it("reports every blank required field at once", () => {
    expect(Object.keys(check({ legalName: "", address: "", city: "", state: "", zip: "" })).sort()).toEqual([
      "business.address", "business.city", "business.legalName", "business.state", "business.zip",
    ]);
  });

  it("treats a wholly absent business section as every field missing", () => {
    expect(Object.keys(validateOnboardingFields({})).sort()).toEqual([
      "business.address", "business.city", "business.legalName", "business.phone",
      "business.state", "business.zip",
      "ownerContact.email", "ownerContact.firstName", "ownerContact.lastName", "ownerContact.phone",
    ]);
  });
});

describe("validateOnboardingFields — present but malformed", () => {
  it("rejects a state that isn't a real US state", () => {
    // usStateCode passes an unrecognized 2-letter value straight through, so
    // "XX" would reach Adyen and 422 the legal entity.
    for (const state of ["XX", "Kalifornia", "Ontario", "C"]) {
      expect(Object.keys(check({ state }))).toEqual(["business.state"]);
    }
  });

  it("rejects a ZIP that isn't 5 digits or ZIP+4", () => {
    for (const zip of ["9001", "900177", "ABCDE", "90017-12"]) {
      expect(Object.keys(check({ zip }))).toEqual(["business.zip"]);
    }
  });

  it("rejects a phone Adyen's E.164 conversion can't handle", () => {
    // toE164Phone returns anything it can't confidently map UNCHANGED, so these
    // reach Adyen verbatim and fail store creation.
    for (const phone of ["555-0000", "call the office", "555-000-0000 ext 12", "442079460958"]) {
      expect(Object.keys(check({ phone }))).toEqual(["business.phone"]);
    }
  });

  it("accepts the phone formats that do convert", () => {
    for (const phone of ["5106680242", "(714) 833-5760", "15106680242", "+15106680242"]) {
      expect(check({ phone })).toEqual({});
    }
  });

  it("rejects free text in the website box", () => {
    // adapters/adyen.ts prefixes https:// before sending webAddress, which turns
    // "not applicable" into "https://not applicable" and 422s the business line.
    for (const website of ["not applicable", "n/a", "none", "my site.com", "aioapp"]) {
      expect(Object.keys(check({ website }))).toEqual(["business.website"]);
    }
  });

  it("accepts a bare domain as well as a full URL", () => {
    for (const website of ["tortapalace.com", "www.tortapalace.com", "https://tortapalace.com/menu?x=1", "HTTP://TORTAPALACE.COM"]) {
      expect(check({ website })).toEqual({});
    }
  });

  it("rejects a malformed owner email", () => {
    for (const email of ["ana", "ana@", "ana@tortapalace", "a b@x.com"]) {
      expect(Object.keys(check({}, { email }))).toEqual(["ownerContact.email"]);
    }
  });

  it("keys errors by the form's own dotted field paths", () => {
    // The onboarding form renders each message next to the input identified by
    // this path — a renamed key silently stops rendering.
    expect(check({ zip: "bad", state: "XX" }, { email: "nope" })).toEqual({
      "business.state": expect.any(String),
      "business.zip": expect.any(String),
      "ownerContact.email": expect.any(String),
    });
  });
});

// The merchant's own consent, checked in the same pass as the Adyen fields so
// the Server Action has one gate to run before the handoff. The RULE lives in
// lib/consent.ts (and is tested there) — these are about it being asked.
const CONSENT: AgreementInfo = {
  sigName: "Ana Reyes", sigDate: "2026-08-19",
  termsAccepted: true, electronicConsentAccepted: true, actor: "customer",
};

const withoutActor = (agreement: AgreementInfo): AgreementInfo => {
  const legacy = { ...agreement };
  delete legacy.actor;
  return legacy;
};

describe("validateOnboardingConsent", () => {
  it("passes the merchant's own, complete consent", () => {
    expect(validateOnboardingConsent(CONSENT)).toEqual({});
  });

  it("rejects a missing agreement", () => {
    for (const agreement of [null, undefined]) {
      expect(Object.keys(validateOnboardingConsent(agreement))).toEqual(["agreement.consent"]);
    }
  });

  it("rejects a half-ticked agreement", () => {
    for (const consent of [
      { termsAccepted: false, electronicConsentAccepted: true },
      { termsAccepted: true, electronicConsentAccepted: false },
      { termsAccepted: false, electronicConsentAccepted: false },
    ]) {
      expect(Object.keys(validateOnboardingConsent({ ...CONSENT, ...consent })))
        .toEqual(["agreement.consent"]);
    }
  });

  it("rejects consent with no recorded author", () => {
    // Legacy JSONB rows have no `actor`, and unknown origin is not the
    // merchant's consent — the safe direction to be wrong in.
    expect(Object.keys(validateOnboardingConsent(withoutActor(CONSENT))))
      .toEqual(["agreement.consent"]);
  });
});

// The rep step's "block on malformed, warn on missing" split — see the doc
// comment on stripBlanks for the mechanism.
describe("validateOnboardingFields(stripBlanks(input)) — malformed-only", () => {
  it("reports nothing for a wholly blank business section", () => {
    expect(validateOnboardingFields(stripBlanks({}))).toEqual({});
  });

  it("reports nothing when required fields are merely missing", () => {
    const errors = validateOnboardingFields(stripBlanks({
      business: { ...BUSINESS, legalName: "", address: "", city: "", state: "", zip: "" },
    }));
    expect(errors).toEqual({});
  });

  it("still reports a malformed state even though it's non-blank", () => {
    const errors = validateOnboardingFields(stripBlanks({ business: { ...BUSINESS, state: "XX" } }));
    expect(Object.keys(errors)).toEqual(["business.state"]);
  });

  it("still reports a malformed ZIP even though it's non-blank", () => {
    const errors = validateOnboardingFields(stripBlanks({ business: { ...BUSINESS, zip: "bad" } }));
    expect(Object.keys(errors)).toEqual(["business.zip"]);
  });

  it("still reports a malformed phone, website or owner email", () => {
    expect(Object.keys(validateOnboardingFields(stripBlanks({ business: { ...BUSINESS, phone: "call the office" } })))).toEqual(["business.phone"]);
    expect(Object.keys(validateOnboardingFields(stripBlanks({ business: { ...BUSINESS, website: "n/a" } })))).toEqual(["business.website"]);
    expect(Object.keys(validateOnboardingFields(stripBlanks({ ownerContact: { ...OWNER, email: "nope" } })))).toEqual(["ownerContact.email"]);
  });

  // The "gate blocks, rep stays lenient" decision (2026-10-14): the fields
  // tenantFieldErrors made required are placeholdered here too, so a rep
  // working from a HubSpot deal that carries no owner phone can still create
  // the prospect. The merchant's form requires them, and
  // isReadyForAioProvisioning refuses to attempt a create without them — so
  // nothing fails, it waits somewhere visible.
  it("still lets a rep through with the AIO-required fields blank", () => {
    const sparse = {
      business: { ...BUSINESS, phone: "" },
      ownerContact: { firstName: "", lastName: "", title: "", email: "", phone: "" } as OwnerContact,
    };
    expect(validateOnboardingFields(sparse)).not.toEqual({});
    expect(validateOnboardingFields(stripBlanks(sparse))).toEqual({});
  });

  it("still reports a malformed owner phone the rep DID type", () => {
    expect(Object.keys(validateOnboardingFields(stripBlanks({
      ownerContact: { ...OWNER, phone: "call the office" },
    })))).toEqual(["ownerContact.phone"]);
  });

  // The DBA placeholders are conditional, so a rep who left the whole DBA
  // address blank isn't handed three stand-ins for a rule that never fires.
  it("placeholders the DBA pieces only when a DBA street was given", () => {
    const withStreet = stripBlanks({ business: { ...BUSINESS, dbaAddress: "9 Dining St" } });
    expect(withStreet.business?.dbaCity).toBeTruthy();
    const without = stripBlanks({ business: BUSINESS });
    expect(without.business?.dbaCity).toBeUndefined();
  });

  it("passes a fully valid form with no errors at all", () => {
    expect(validateOnboardingFields(stripBlanks({ business: BUSINESS, ownerContact: OWNER }))).toEqual({});
  });
});

describe("validateOnboardingSubmission", () => {
  it("passes a well-formed form with the merchant's consent", () => {
    expect(validateOnboardingSubmission({
      business: BUSINESS, ownerContact: OWNER, agreement: CONSENT,
    })).toEqual({});
  });

  it("reports field errors and missing consent together", () => {
    expect(validateOnboardingSubmission({
      business: { ...BUSINESS, zip: "" },
      ownerContact: OWNER,
      agreement: withoutActor(CONSENT),
    })).toEqual({
      "business.zip": expect.any(String),
      "agreement.consent": expect.any(String),
    });
  });

  it("blocks on consent even when every field is perfect", () => {
    expect(validateOnboardingSubmission({ business: BUSINESS, ownerContact: OWNER })).toEqual({
      "agreement.consent": expect.any(String),
    });
  });
});
