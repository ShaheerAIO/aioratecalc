import { describe, it, expect } from "vitest";
import { validateOnboardingFields } from "@/lib/onboardingValidation";
import {
  applyLeadConfirmation,
  missingConfirmationFields,
  confirmationErrors,
  unreachableErrorPaths,
  CONFIRMABLE_PATHS,
} from "@/lib/leadConfirm";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";

// The merchant's confirmation of their own details — the step that publishes
// the HubSpot quote, and therefore the last moment anything on it can change.
// Two properties matter and pull in opposite directions: it must be able to
// OVERWRITE a perfectly valid value (that is the whole point — the rep typed
// the wrong billing email), and it must not be able to reach the pricing.

const BUSINESS: Partial<BusinessInfo> = {
  legalName: "Torta Palace LLC",
  dba: "Torta Palace",
  bizType: "llc",
  ein: "12-3456789",
  address: "1200 Wilshire Blvd",
  city: "Los Angeles",
  state: "CA",
  zip: "90017",
  phone: "555-000-0000",
};

const OWNER: Partial<OwnerContact> = {
  firstName: "Ana",
  lastName: "Reyes",
  title: "Owner",
  email: "ana@tortapalace.com",
  phone: "555-000-0001",
};

const PROCESSING: Partial<ProcessingInfo> = {
  monthlyVolume: "100000",
  avgTicket: "25",
  mcc: "5812",
  currentProcessor: "Square",
};

const current = { business: BUSINESS, ownerContact: OWNER, billingContact: null, processing: PROCESSING };

describe("applyLeadConfirmation — the widening", () => {
  // This is the difference from leadDetails.ts's `applyLeadDetails`, which
  // applies ONLY paths currently in error and so cannot fix a wrong-but-valid
  // value. That rule is right for a repair dialog and would make this step
  // useless: a rep's typo of a billing contact looks perfectly valid.
  it("overwrites a value that is already valid", () => {
    const next = applyLeadConfirmation(current, {
      "ownerContact.email": "ana.reyes@tortapalace.com",
      "business.address": "88 Grand Ave",
    });
    expect(next.ownerContact.email).toBe("ana.reyes@tortapalace.com");
    expect(next.business.address).toBe("88 Grand Ave");
  });

  it("trims what the merchant typed, and leaves untouched sections alone", () => {
    const next = applyLeadConfirmation(current, { "business.phone": "  555-111-2222  " });
    expect(next.business.phone).toBe("555-111-2222");
    expect(next.business.legalName).toBe("Torta Palace LLC");
    expect(next.ownerContact).toEqual(OWNER);
  });

  it("records the EIN, the one tax id AIO collects", () => {
    const next = applyLeadConfirmation(current, { "business.ein": "12-3456789" });
    expect(next.business.ein).toBe("12-3456789");
  });
});

describe("applyLeadConfirmation — the fence", () => {
  // The allow-list is the ONLY fence here, so what it leaves out is the whole
  // of the protection. Volume and average ticket are the pricing basis: the
  // rep's form derives `quoteConfig` from them, and they drive the rate
  // matrix, the margin floor and the $10/month revenue floor. A merchant who
  // could move them would re-price a quote the rep had already cleared both
  // floors on, seconds before it is published irreversibly.
  it("ignores monthly volume and average ticket, however they are posted", () => {
    const next = applyLeadConfirmation(current, {
      "processing.monthlyVolume": "5",
      "processing.avgTicket": "1",
    });
    expect(next.processing.monthlyVolume).toBe("100000");
    expect(next.processing.avgTicket).toBe("25");
  });

  it("ignores anything else not on the list", () => {
    const next = applyLeadConfirmation(current, {
      "processing.cardPresentPct": "0",
      "ownerContact.altEmail": "someone@else.com",
      "quoteRates.cardPresentRate": "0.0001",
      "targetMargin": "0",
      "business.annualRevenue": "1",
    } as Record<string, string>);
    expect(next.processing.cardPresentPct).toBeUndefined();
    expect(next.ownerContact.altEmail).toBeUndefined();
    expect(next.business.annualRevenue).toBeUndefined();
    expect(next).not.toHaveProperty("quoteRates");
    expect(next).not.toHaveProperty("targetMargin");
  });

  it("never lets the allow-list name a pricing path", () => {
    for (const path of ["processing.monthlyVolume", "processing.avgTicket", "processing.cardPresentPct"]) {
      expect(CONFIRMABLE_PATHS).not.toContain(path);
    }
  });
});

describe("applyLeadConfirmation — the billing contact", () => {
  // Null is how the rest of the codebase says "bill the owner", and
  // `syncBillingContact` keys on a non-blank email. An object of empty strings
  // would read as a real contact with no name.
  it("stays null when nothing is given for it", () => {
    const next = applyLeadConfirmation(current, {
      "billingContact.firstName": "",
      "billingContact.lastName": "",
      "billingContact.email": "",
      "billingContact.phone": "",
    });
    expect(next.billingContact).toBeNull();
  });

  it("is kept when the merchant names someone different", () => {
    const next = applyLeadConfirmation(current, {
      "billingContact.firstName": "Luis",
      "billingContact.lastName": "Ortiz",
      "billingContact.email": "ap@tortapalace.com",
      "billingContact.phone": "",
    });
    expect(next.billingContact).toMatchObject({ firstName: "Luis", email: "ap@tortapalace.com" });
  });

  it("can be cleared back to the owner by a merchant who ticks 'same as owner'", () => {
    const withBilling = { ...current, billingContact: { email: "old@wrong.com", firstName: "Old" } };
    const next = applyLeadConfirmation(withBilling, {
      "billingContact.firstName": "",
      "billingContact.lastName": "",
      "billingContact.email": "",
      "billingContact.phone": "",
    });
    expect(next.billingContact).toBeNull();
  });

  // Live 2026-10-16: the rep copied the owner into the billing contact, title
  // included. 'Same as owner' blanked the four boxes, the stored title — which
  // has no box here — kept the contact alive, and the server demanded a name,
  // email and phone on inputs the merchant could not see.
  it("is cleared even when the stored contact carries a field this form has no box for", () => {
    const withBilling = {
      ...current,
      billingContact: { firstName: "Elizabeth", lastName: "Phillips", email: "e@x.com", phone: "", title: "Marketing Associate" },
    };
    const next = applyLeadConfirmation(withBilling, {
      "billingContact.firstName": "",
      "billingContact.lastName": "",
      "billingContact.email": "",
      "billingContact.phone": "",
    });
    expect(next.billingContact).toBeNull();
    expect(Object.keys(confirmationErrors(next)).filter(p => p.startsWith("billingContact."))).toEqual([]);
  });
});

describe("applyLeadConfirmation — the operating address", () => {
  // Blank as a whole means "same as the legal address" and `locationAddress`
  // falls back on the STREET alone — so un-ticking the box has to clear all
  // four, or a stale city/state/ZIP outlives the street that justified them.
  it("clears every part when the merchant says there is no separate address", () => {
    const withDba = {
      ...current,
      business: { ...BUSINESS, dbaAddress: "9 Olive St", dbaCity: "Pasadena", dbaState: "CA", dbaZip: "91101" },
    };
    const next = applyLeadConfirmation(withDba, {
      "business.dbaAddress": "",
      "business.dbaCity": "",
      "business.dbaState": "",
      "business.dbaZip": "",
    });
    expect(next.business.dbaAddress).toBe("");
    expect(next.business.dbaCity).toBe("");
    expect(next.business.dbaZip).toBe("");
  });
});

describe("confirmationErrors", () => {
  // The STRICT validator — the same function `isReadyForAioProvisioning`
  // runs — so a confirmed row is a provisionable row. This is what makes the
  // ordering that broke prospect_1792016501714 impossible: the form now comes
  // before the payment, not after it.
  it("passes a complete row", () => {
    expect(confirmationErrors(current)).toEqual({});
  });

  it("refuses the blank owner phone that AIO's tenant create 400s on", () => {
    const next = applyLeadConfirmation(current, { "ownerContact.phone": "" });
    expect(confirmationErrors(next)).toHaveProperty("ownerContact.phone");
  });

  it("refuses a half-filled operating address", () => {
    const next = applyLeadConfirmation(current, { "business.dbaAddress": "9 Olive St" });
    const errors = confirmationErrors(next);
    expect(errors).toHaveProperty("business.dbaCity");
    expect(errors).toHaveProperty("business.dbaState");
    expect(errors).toHaveProperty("business.dbaZip");
  });

  it("refuses a malformed phone rather than passing it to AIO verbatim", () => {
    const next = applyLeadConfirmation(current, { "business.phone": "call the office" });
    expect(confirmationErrors(next)).toHaveProperty("business.phone");
  });
});

// EVERYTHING ON THIS FORM IS REQUIRED (2026-10-15, product owner). These rules
// live on the confirmation step ALONE and must never migrate into
// `validateOnboardingFields`: that function is what `isReadyForAioProvisioning`
// runs, so a field added there is a field every already-paid row is suddenly
// missing, held at `missing_business_details` for want of an EIN nobody had
// ever been asked for. It is also what the rep form checks through
// `stripBlanks`, where reps stay lenient by standing decision.
describe("the confirmation step requires every box on it", () => {
  const requiredNow: Array<[string, Record<string, string>]> = [
    ["business.dba", { "business.dba": "" }],
    ["business.bizType", { "business.bizType": "" }],
    ["business.ein", { "business.ein": "" }],
    ["ownerContact.title", { "ownerContact.title": "" }],
  ];

  for (const [path, blanked] of requiredNow) {
    it(`refuses a blank ${path}`, () => {
      expect(confirmationErrors(applyLeadConfirmation(current, blanked))).toHaveProperty(path);
    });
  }

  it("checks the EIN's SHAPE, not just that something was typed", () => {
    // Nine digits, always. Nothing downstream verifies this one — Adyen and
    // Check each collect and verify their own — so an eight-digit typo would
    // sit on the CRM record looking authoritative.
    expect(confirmationErrors(applyLeadConfirmation(current, { "business.ein": "12-345678" })))
      .toHaveProperty("business.ein");
    expect(confirmationErrors(applyLeadConfirmation(current, { "business.ein": "not an ein" })))
      .toHaveProperty("business.ein");
    expect(confirmationErrors(applyLeadConfirmation(current, { "business.ein": "123456789" })))
      .not.toHaveProperty("business.ein");
  });

  it("leaves the website and years-open optional — they were not on the list", () => {
    const next = applyLeadConfirmation(current, { "business.website": "", "business.yearsInBusiness": "" });
    expect(confirmationErrors(next)).toEqual({});
  });

  // None of the above may leak into the tenant rules, or the provisioning cron
  // starts holding paid merchants over a box it never asked them for.
  it("does NOT add any of this to validateOnboardingFields", () => {
    const stripped = { business: { ...BUSINESS, dba: "", bizType: "" as const, ein: "" }, ownerContact: { ...OWNER, title: "" } };
    expect(validateOnboardingFields(stripped)).toEqual({});
    expect(Object.keys(confirmationErrors(stripped)).sort())
      .toEqual(["business.bizType", "business.dba", "business.ein", "ownerContact.title"]);
  });
});

describe("the billing contact, required only when it is someone else", () => {
  it("is satisfied by 'same as the owner above' — that IS an answer", () => {
    const next = applyLeadConfirmation(current, {
      "billingContact.firstName": "", "billingContact.lastName": "",
      "billingContact.email": "", "billingContact.phone": "",
    });
    expect(next.billingContact).toBeNull();
    expect(confirmationErrors(next)).toEqual({});
  });

  it("demands the whole contact once the merchant names a different person", () => {
    const next = applyLeadConfirmation(current, { "billingContact.firstName": "Luis" });
    expect(Object.keys(confirmationErrors(next)).sort()).toEqual([
      "billingContact.email", "billingContact.lastName", "billingContact.phone",
    ]);
  });

  it("checks that contact's email is an email", () => {
    const next = applyLeadConfirmation(current, {
      "billingContact.firstName": "Luis", "billingContact.lastName": "Ortiz",
      "billingContact.email": "not-an-email", "billingContact.phone": "555-000-0002",
    });
    expect(confirmationErrors(next)).toHaveProperty("billingContact.email");
  });

  it("accepts a complete one", () => {
    const next = applyLeadConfirmation(current, {
      "billingContact.firstName": "Luis", "billingContact.lastName": "Ortiz",
      "billingContact.email": "ap@tortapalace.com", "billingContact.phone": "555-000-0002",
    });
    expect(confirmationErrors(next)).toEqual({});
  });
});

describe("missingConfirmationFields — what a disabled button is waiting on", () => {
  it("is empty exactly when the form is submittable", () => {
    expect(missingConfirmationFields(current)).toEqual([]);
  });

  it("qualifies the fields this form asks for twice", () => {
    // "City" and "First name" are unambiguous beside their own panel heading
    // and are not, pulled out and listed under a button.
    const next = applyLeadConfirmation(current, {
      "business.city": "", "ownerContact.firstName": "", "billingContact.lastName": "Ortiz",
    });
    const missing = missingConfirmationFields(next);
    expect(missing).toContain("Registered address — City");
    expect(missing).toContain("Owner — First name");
    expect(missing).toContain("Billing contact — First name");
  });

  it("lists them in the order the form asks for them", () => {
    const next = applyLeadConfirmation(current, { "business.ein": "", "business.dba": "" });
    expect(missingConfirmationFields(next)).toEqual(["Trading name (DBA)", "Federal EIN"]);
  });
});

describe("every error the merchant can be shown has a box to fix it in", () => {
  // Unlike leadDetails.ts's `remainingErrors`, `confirmationErrors` does NOT
  // filter to the allow-list — everything the validator requires is editable
  // here, so an unfiltered message always lands under an input. This asserts
  // that stays true: narrowing CONFIRMABLE_PATHS, or adding a required field
  // to the validator without adding it here, would otherwise produce a
  // message the merchant is shown and given no way to act on.
  it("reports no required path the form cannot edit", () => {
    expect(unreachableErrorPaths()).toEqual([]);
  });
});
