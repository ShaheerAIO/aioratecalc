import { describe, it, expect } from "vitest";
import {
  buildFoodbuyFormFileName, defaultFoodbuyForm, parseFoodbuyForm, toSavedForm, usesSysco, validateFoodbuyForm,
} from "@/lib/foodbuyForm";
import type { BusinessInfo } from "@/types/merchant";
import { BUSINESS, CONTACT, completeForm } from "./foodbuyFixtures";

describe("defaultFoodbuyForm", () => {
  it("pre-fills the business, the main contact and a first location", () => {
    const f = defaultFoodbuyForm({ business: BUSINESS, ownerContact: CONTACT, foodbuyIds: null });
    expect(f.business).toMatchObject({ legalName: "Torta Palace LLC", dba: "Torta Palace", bizType: "LLC", city: "Anaheim" });
    expect(f.contacts[0]).toMatchObject({ name: "Jane Doe", title: "Owner", email: "jane@tortapalace.com" });
    expect(f.locations).toHaveLength(1);
    expect(f.locations[0]).toMatchObject({ name: "Torta Palace", address: "123 Main St", distributor: "", acct: "" });
    expect(f.printName).toBe("Jane Doe");
  });

  it("puts the first location at the DBA address when there is one", () => {
    const f = defaultFoodbuyForm({
      business: { ...BUSINESS, dbaAddress: "9 Shop Rd", dbaCity: "Irvine", dbaState: "CA", dbaZip: "92618" },
      ownerContact: CONTACT, foodbuyIds: null,
    });
    expect(f.locations[0]).toMatchObject({ address: "9 Shop Rd", city: "Irvine", zip: "92618" });
    expect(f.business.address).toBe("123 Main St");
  });

  it("never pre-fills the EIN, even when AIO holds one", () => {
    const f = defaultFoodbuyForm({ business: { ...BUSINESS, ein: "98-7654321" } as BusinessInfo, ownerContact: CONTACT, foodbuyIds: null });
    expect(f.business.ein).toBe("");
  });

  it("leaves an unspecified business type blank rather than asserting one", () => {
    expect(defaultFoodbuyForm({ business: { ...BUSINESS, bizType: "" }, ownerContact: CONTACT, foodbuyIds: null }).business.bizType).toBe("");
  });

  it("restores the last send's answers, but never the EIN, acceptance or signature", () => {
    const saved = toSavedForm({ ...completeForm(), locations: [{ ...completeForm().locations[0], acct: "999" }] });
    expect(saved.business).not.toHaveProperty("ein");
    expect(saved).not.toHaveProperty("signature");
    const f = defaultFoodbuyForm({
      business: BUSINESS, ownerContact: CONTACT,
      foodbuyIds: { generatedAt: "2026-10-01T00:00:00Z", form: saved },
    });
    expect(f.locations[0].acct).toBe("999");
    expect(f.business.ein).toBe("");
    expect(f.accept).toBe(false);
    expect(f.signature).toBe("");
  });
});

describe("validateFoodbuyForm", () => {
  it("accepts a finished form", () => {
    expect(validateFoodbuyForm(completeForm())).toEqual({});
  });

  it("requires the EIN, GPO answer, acceptance and signature", () => {
    const f = { ...completeForm(), business: { ...completeForm().business, ein: "" }, gpo: { participates: null, name: "" }, accept: false, signature: "" };
    expect(Object.keys(validateFoodbuyForm(f))).toEqual(
      expect.arrayContaining(["business.ein", "gpo.participates", "accept", "signature"]),
    );
  });

  it("requires the GPO's name only when they're in one", () => {
    expect(validateFoodbuyForm({ ...completeForm(), gpo: { participates: true, name: "" } })).toHaveProperty(["gpo.name"]);
    expect(validateFoodbuyForm({ ...completeForm(), gpo: { participates: true, name: "Avendra" } })).toEqual({});
  });

  it("requires at least one fully filled distributor row", () => {
    expect(validateFoodbuyForm({ ...completeForm(), locations: [] })).toHaveProperty(["locations"]);
    const f = completeForm();
    const errors = validateFoodbuyForm({ ...f, locations: [f.locations[0], { ...f.locations[0], acct: "" }] });
    expect(errors).toEqual({ "locations.1.acct": "Account # is required" });
  });

  it("requires the Sysco contact only when a distributor is Sysco", () => {
    const f = { ...completeForm(), sysco: { name: "", phone: "", email: "" } };
    expect(usesSysco(f)).toBe(true);
    expect(Object.keys(validateFoodbuyForm(f))).toEqual(["sysco.name", "sysco.phone", "sysco.email"]);
    const notSysco = { ...f, locations: [{ ...f.locations[0], distributor: "US Foods" }] };
    expect(validateFoodbuyForm(notSysco)).toEqual({});
  });

  it("checks a half-filled second contact", () => {
    const f = completeForm();
    const errors = validateFoodbuyForm({ ...f, contacts: [f.contacts[0], { name: "", title: "Manager", phone: "", fax: "", email: "" }] });
    expect(Object.keys(errors)).toEqual(["contacts.1.name", "contacts.1.email"]);
  });

  it("requires every field of a listed direct agreement", () => {
    const errors = validateFoodbuyForm({ ...completeForm(), directAgreements: [{ manufacturer: "Coca-Cola", category: "", start: "", end: "" }] });
    expect(Object.keys(errors)).toEqual(["directAgreements.0.category", "directAgreements.0.start", "directAgreements.0.end"]);
  });
});

describe("parseFoodbuyForm", () => {
  it("round-trips a form", () => {
    const f = completeForm();
    expect(parseFoodbuyForm(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it("coerces junk into strings and refuses a non-object", () => {
    expect(parseFoodbuyForm(null)).toBeNull();
    const f = parseFoodbuyForm({ business: { legalName: 42 }, locations: "x", accept: "true" })!;
    expect(f.business.legalName).toBe("");
    expect(f.locations).toEqual([]);
    expect(f.accept).toBe(false);
  });
});

describe("buildFoodbuyFormFileName", () => {
  it("uses the DBA and today's date", () => {
    expect(buildFoodbuyFormFileName(BUSINESS)).toMatch(/^AIO-Foodbuy-Enrollment-Torta-Palace-\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});
