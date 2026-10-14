import { describe, it, expect } from "vitest";
import {
  applyLeadDetails,
  canRepairFromLead,
  missingTenantFields,
  remainingErrors,
  REPAIRABLE_PATHS,
} from "@/lib/leadDetails";
import type { BusinessInfo, OwnerContact } from "@/types/merchant";

// The last-resort repair of a tenant-blocking blank, from the PUBLIC lead
// token. It should never fire — but the row that prompted it
// (prospect_1792016501714, 2026-10-14) had paid, had no customer account at
// all, and was holding on one empty phone number, so the thing it must never
// do is let that token touch anything else.

const BUSINESS: Partial<BusinessInfo> = {
  legalName: "Torta Palace LLC",
  dba: "Torta Palace",
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

const complete = { business: BUSINESS, ownerContact: OWNER };

describe("missingTenantFields", () => {
  it("asks for nothing when the row is already complete", () => {
    expect(missingTenantFields(complete)).toEqual([]);
  });

  it("asks for exactly the blank field, with the validator's own message", () => {
    const fields = missingTenantFields({ business: BUSINESS, ownerContact: { ...OWNER, phone: "" } });
    expect(fields.map(f => f.path)).toEqual(["ownerContact.phone"]);
    expect(fields[0].label).toBe("Owner phone");
    expect(fields[0].message).toMatch(/phone/i);
  });

  it("asks for several at once rather than one round trip each", () => {
    const fields = missingTenantFields({
      business: { ...BUSINESS, phone: "" },
      ownerContact: { ...OWNER, firstName: "", phone: "" },
    });
    expect(fields.map(f => f.path).sort())
      .toEqual(["business.phone", "ownerContact.firstName", "ownerContact.phone"]);
  });

  it("reports a MALFORMED value too, not only a blank one", () => {
    const fields = missingTenantFields({ business: BUSINESS, ownerContact: { ...OWNER, phone: "call us" } });
    expect(fields.map(f => f.path)).toEqual(["ownerContact.phone"]);
  });
});

describe("canRepairFromLead", () => {
  it("is false when there is nothing to repair", () => {
    expect(canRepairFromLead(complete)).toBe(false);
  });

  it("is true when every missing field is one this dialog asks for", () => {
    expect(canRepairFromLead({ business: BUSINESS, ownerContact: { ...OWNER, phone: "" } })).toBe(true);
  });

  // Offering the dialog here would hand the merchant a CTA that leaves them
  // exactly as stuck — the legal address is deliberately not repairable from a
  // public token (see REPAIRABLE in leadDetails.ts).
  it("is false when something OUTSIDE the dialog is also missing", () => {
    expect(canRepairFromLead({
      business: { ...BUSINESS, zip: "", phone: "" },
      ownerContact: OWNER,
    })).toBe(false);
  });
});

describe("applyLeadDetails — what a public token may rewrite", () => {
  it("fills the field that was actually missing", () => {
    const next = applyLeadDetails(
      { business: BUSINESS, ownerContact: { ...OWNER, phone: "" } },
      { "ownerContact.phone": "415-555-0143" },
    );
    expect(next.ownerContact.phone).toBe("415-555-0143");
  });

  it("REFUSES to overwrite a value that was already good", () => {
    // The whole fence: the form can post anything, and a token holder is not
    // necessarily the merchant.
    const next = applyLeadDetails(complete, {
      "ownerContact.email": "attacker@example.com",
      "business.phone": "999-999-9999",
    });
    expect(next.ownerContact.email).toBe(OWNER.email);
    expect(next.business.phone).toBe(BUSINESS.phone);
  });

  it("ignores a path that isn't on the allow-list, even when it IS blank", () => {
    const next = applyLeadDetails(
      { business: { ...BUSINESS, zip: "", phone: "" }, ownerContact: OWNER },
      { "business.zip": "94016", "business.legalName": "Someone Else LLC" },
    );
    expect(next.business.zip).toBe("");
    expect(next.business.legalName).toBe(BUSINESS.legalName);
    expect(REPAIRABLE_PATHS).not.toContain("business.zip");
  });

  it("trims what the merchant typed, and leaves every other field alone", () => {
    const next = applyLeadDetails(
      { business: BUSINESS, ownerContact: { ...OWNER, phone: "" } },
      { "ownerContact.phone": "  415-555-0143  " },
    );
    expect(next.ownerContact.phone).toBe("415-555-0143");
    expect(next.business).toEqual(BUSINESS);
    expect(next.ownerContact.firstName).toBe(OWNER.firstName);
  });
});

describe("remainingErrors", () => {
  it("is empty once the merchant's answer is good", () => {
    const next = applyLeadDetails(
      { business: BUSINESS, ownerContact: { ...OWNER, phone: "" } },
      { "ownerContact.phone": "415-555-0143" },
    );
    expect(remainingErrors(next)).toEqual({});
  });

  it("reports a badly-formatted answer against the box it came from", () => {
    const next = applyLeadDetails(
      { business: BUSINESS, ownerContact: { ...OWNER, phone: "" } },
      { "ownerContact.phone": "call the office" },
    );
    expect(Object.keys(remainingErrors(next))).toEqual(["ownerContact.phone"]);
  });

  // A message with no input box under it is a message with nowhere to go.
  it("never reports a path the dialog has no box for", () => {
    expect(remainingErrors({ business: { ...BUSINESS, zip: "" }, ownerContact: OWNER })).toEqual({});
  });
});
