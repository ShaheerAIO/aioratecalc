import { describe, it, expect } from "vitest";
import { locationAddress, type BusinessInfo } from "@/types/merchant";
import { validateOnboardingFields } from "@/lib/onboardingValidation";
import { mergeReviewPrefill } from "@/lib/prefillMerge";
import { fmtCycle, fmtRecurring } from "@/lib/utils";

const LEGAL = { address: "1 Legal Way", city: "Oakland", state: "CA", zip: "94601" };

describe("locationAddress", () => {
  it("falls back to the legal address when there is no DBA address", () => {
    expect(locationAddress(LEGAL)).toEqual(LEGAL);
    expect(locationAddress({ ...LEGAL, dbaCity: "Nowhere" })).toEqual(LEGAL);
  });

  it("uses the DBA address when it has a street", () => {
    expect(locationAddress({ ...LEGAL, dbaAddress: " 9 Dining St ", dbaCity: "San Jose", dbaState: "CA", dbaZip: "95120" }))
      .toEqual({ address: "9 Dining St", city: "San Jose", state: "CA", zip: "95120" });
  });
});

describe("DBA address validation", () => {
  const BIZ: Partial<BusinessInfo> = { legalName: "X", ...LEGAL };
  it("is optional and never required", () => {
    expect(validateOnboardingFields({ business: BIZ })).toEqual({});
    expect(validateOnboardingFields({ business: { ...BIZ, dbaAddress: "9 Dining St" } })).toEqual({});
  });
  it("rejects a malformed DBA state or ZIP", () => {
    const e = validateOnboardingFields({ business: { ...BIZ, dbaAddress: "9 Dining St", dbaState: "ZZ", dbaZip: "12" } });
    expect(Object.keys(e).sort()).toEqual(["business.dbaState", "business.dbaZip"]);
  });
});

describe("DBA address prefill merge", () => {
  it("lets HubSpot fill it and the rep's own typing win", () => {
    const blank = {
      business: { legalName: "", dba: "", bizType: "llc", address: "", city: "", state: "", zip: "", phone: "", website: "", yearsInBusiness: "", annualRevenue: "" } as BusinessInfo,
      ownerContact: { firstName: "", lastName: "", title: "", email: "", phone: "" },
      processing: { monthlyVolume: "", avgTicket: "", cardPresentPct: "95", mcc: "", businessDescription: "", previouslyTerminated: "no", bankruptcy: "no", currentProcessor: "" },
    } as Parameters<typeof mergeReviewPrefill>[0];
    const incoming = { business: { dbaAddress: "9 Dining St" }, ownerContact: {}, processing: {}, channels: [], fromHubspot: [] };
    const first = mergeReviewPrefill(blank, {}, incoming);
    expect(first.values.business.dbaAddress).toBe("9 Dining St");
    const typed = { ...first.values, business: { ...first.values.business, dbaAddress: "Rep typed" } };
    const second = mergeReviewPrefill(typed, first.applied, { ...incoming, business: { dbaAddress: "Other" } });
    expect(second.values.business.dbaAddress).toBe("Rep typed");
  });
});

describe("monthly recurring presentation", () => {
  it("shows a monthly line as just its monthly price", () => {
    expect(fmtRecurring(399, "monthly")).toBe("$399.00/mo");
    expect(fmtCycle("monthly")).toBe("mo");
  });
  it("leads other cycles with the monthly equivalent but keeps the true cycle", () => {
    expect(fmtRecurring(99, "weekly")).toBe("~$429.00/mo ($99.00/week)");
    expect(fmtCycle("weekly")).toBe("week");
  });
});

// 2026-10-12: HubSpot's address stopped seeding the LEGAL address, so a
// merchant who pays before filling in their onboarding form has an operating
// address and no legal one. `createAioBusiness` used to read `biz.address`
// directly and would have created a tenant with a blank address — on an alias
// that is globally unique and never freed.
describe("the AIO tenant address", () => {
  it("is the operating address when one is on file", () => {
    const loc = locationAddress({
      address: "", city: "", state: "", zip: "",
      dbaAddress: "638 S Brookhurst St", dbaCity: "Anaheim", dbaState: "CA", dbaZip: "92804",
    });
    expect(loc).toEqual({ address: "638 S Brookhurst St", city: "Anaheim", state: "CA", zip: "92804" });
  });
});
