import { describe, it, expect } from "vitest";
import {
  buildProspectPrefill, buildProspectPrefillForContact, businessDescription, channelsFromModules,
  contactOptionLabel, initialContactChoice,
  monthlyVolumeFromCompany, normalizeCountry, normalizePhone, processorFromPos, streetLine,
} from "@/lib/hubspotPrefill";
import { mergeDealAndCompanyContacts, pickOwnerAssociation, rankContactAssociations, type CompanyAssociation, type HubspotCompanyProfile, type HubspotContact } from "@/lib/adapters/hubspot";

// A company with everything HubSpot could plausibly hold, using real observed
// value shapes (E.164 phone, free-text state, "USA" country, the `moduels`
// checkbox string).
const FULL: HubspotCompanyProfile = {
  id: "338486660836",
  name: "Little Arabia Restaurant",
  tenantRef: "prod-1024",
  adyenAccountHolderId: "AH32XYZ",
  mid: null,
  phone: "+17148335760",
  email: "hello@littlearabia.com",
  domain: "littlearabiarestaurant.com",
  website: "https://littlearabiarestaurant.com",
  address: "638 South Brookhurst Street",
  city: "Anaheim",
  state: "California",
  zip: "92804",
  country: "USA",
  description: "Authentic Lebanese dining, Mediterranean cuisine.",
  industryType: "TSR",
  cuisineType: "Mediterranean",
  ownershipType: "Franchisee",
  currentPos: "Clover",
  modules: "POS;MPOS;Kiosk;Website;3PO",
  processingVolume: "230000",
};

const EMPTY: HubspotCompanyProfile = {
  id: "1", name: "", tenantRef: null, adyenAccountHolderId: null, mid: null, phone: null, email: null,
  domain: null, website: null, address: null, city: null, state: null, zip: null, country: null,
  description: null, industryType: null, cuisineType: null, ownershipType: null, currentPos: null, modules: null,
  processingVolume: null,
};

const CONTACT: HubspotContact = {
  id: "536325814998",
  firstName: "Angie",
  lastName: "Johnson",
  jobTitle: "Owner",
  email: "angie@littlearabia.com",
  phone: "+1 (707) 489-1963",
  associationLabel: "Business Owner",
};

describe("normalizeCountry", () => {
  it.each(["USA", "usa", "US", "United States", "United states", "united states of america", " U.S.A. "])(
    "normalizes %s to US", (v) => expect(normalizeCountry(v)).toBe("US")
  );

  it("passes a non-US value through uppercased rather than assuming US", () => {
    expect(normalizeCountry("Canada")).toBe("CANADA");
    expect(normalizeCountry("CA")).toBe("CA");
  });

  it("is undefined for missing or blank input", () => {
    expect(normalizeCountry(null)).toBeUndefined();
    expect(normalizeCountry(undefined)).toBeUndefined();
    expect(normalizeCountry("   ")).toBeUndefined();
  });
});

describe("normalizePhone", () => {
  it.each([
    ["+15106680242", "510-668-0242"],
    ["+1 408-537-3057", "408-537-3057"],
    ["+1 (925) 293-6872", "925-293-6872"],
    [" +1 918-221-8889", "918-221-8889"],
    ["(951) 736-7571", "951-736-7571"],
    ["5106680242", "510-668-0242"],
  ])("formats %s as %s", (input, expected) => expect(normalizePhone(input)).toBe(expected));

  it("passes a non-US number through untouched rather than mangling it", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(normalizePhone("ext 4402")).toBe("ext 4402");
  });

  it("is undefined for missing or blank input", () => {
    expect(normalizePhone(null)).toBeUndefined();
    expect(normalizePhone("  ")).toBeUndefined();
  });
});

describe("streetLine", () => {
  it("strips the city/state/zip tail when the segment after the comma is the city we already have", () => {
    expect(streetLine("12303 Limonite Ave Ste 710, Eastvale, CA 91752, United States", "Eastvale"))
      .toBe("12303 Limonite Ave Ste 710");
    expect(streetLine("300 Frank H. Ogawa Plaza #130, Oakland, CA 94612, United States", " oakland "))
      .toBe("300 Frank H. Ogawa Plaza #130");
  });

  it("leaves the address alone when it can't prove the tail is city/state/zip", () => {
    expect(streetLine("201 state Highway 82 Locus bay, OK 74532", "Hulbert"))
      .toBe("201 state Highway 82 Locus bay, OK 74532");
    expect(streetLine("638 South Brookhurst Street", "Anaheim")).toBe("638 South Brookhurst Street");
    expect(streetLine("1 Main St, Suite 4", null)).toBe("1 Main St, Suite 4");
  });

  it("is undefined for missing or blank input", () => {
    expect(streetLine(null, "Anaheim")).toBeUndefined();
    expect(streetLine("   ", "Anaheim")).toBeUndefined();
  });
});

describe("channelsFromModules", () => {
  it("maps only the modules that are ordering CHANNELS, dropping hardware", () => {
    // POS / MPOS / Kiosk are hardware; they're counted from quote lines, not here.
    expect(channelsFromModules("POS;MPOS;Kiosk")).toEqual([]);
    expect(channelsFromModules("POS;Website;3PO")).toEqual(["website", "third_party_delivery"]);
    expect(channelsFromModules("QR/Online Ordering")).toEqual(["qr"]);
  });

  it("drops modules with no channel equivalent instead of guessing", () => {
    expect(channelsFromModules("Catering;Menu Board;Scheduling;Payroll;Marketing")).toEqual([]);
  });

  it("is whitespace- and case-tolerant and de-duplicates", () => {
    expect(channelsFromModules(" website ; WEBSITE ;3po")).toEqual(["website", "third_party_delivery"]);
  });

  it("is empty for missing input", () => {
    expect(channelsFromModules(null)).toEqual([]);
    expect(channelsFromModules("")).toEqual([]);
  });
});

describe("processorFromPos", () => {
  it("keeps POS vendors that are also processors", () => {
    expect(processorFromPos("Toast")).toBe("Toast");
    expect(processorFromPos("Clover")).toBe("Clover");
  });

  it("drops the values that are not processors", () => {
    expect(processorFromPos("Other")).toBeUndefined();
    expect(processorFromPos("Doordash")).toBeUndefined();
    expect(processorFromPos("chowly")).toBeUndefined();
  });

  it("is undefined for missing input", () => {
    expect(processorFromPos(null)).toBeUndefined();
    expect(processorFromPos(" ")).toBeUndefined();
  });
});

describe("businessDescription", () => {
  it("prefers HubSpot's own description", () => {
    expect(businessDescription({ description: "Donut shop.", cuisineType: "Pizza", industryType: "TSR" }))
      .toBe("Donut shop.");
  });

  it("falls back to cuisine + restaurant type", () => {
    expect(businessDescription({ description: null, cuisineType: "Mexican", industryType: "hospitality" }))
      .toBe("Mexican — hospitality");
    expect(businessDescription({ description: null, cuisineType: null, industryType: "Food Truck" }))
      .toBe("Food Truck");
  });

  it("ignores the cuisine picker's 'Other' catch-all", () => {
    expect(businessDescription({ description: null, cuisineType: "Other", industryType: "hospitality" }))
      .toBe("hospitality");
    expect(businessDescription({ description: null, cuisineType: "Other", industryType: null }))
      .toBeUndefined();
  });

  it("is undefined when there's nothing to say", () => {
    expect(businessDescription({ description: null, cuisineType: null, industryType: null })).toBeUndefined();
  });
});

describe("pickOwnerAssociation", () => {
  const assoc = (id: number, ...labels: Array<string | null>): CompanyAssociation => ({
    toObjectId: id,
    associationTypes: labels.map(label => ({ label })),
  });

  it("prefers the Business Owner label over any other", () => {
    expect(pickOwnerAssociation([
      assoc(1, "Contact with Primary Company", null),
      assoc(2, "Business Owner"),
      assoc(3, "Billing Contact"),
    ])).toEqual({ contactId: "2", label: "Business Owner" });
  });

  it("ranks a multi-labelled contact on its best label", () => {
    expect(pickOwnerAssociation([
      assoc(1, "Billing Contact"),
      assoc(2, null, "Contact with Primary Company", "Business Owner"),
    ])).toEqual({ contactId: "2", label: "Business Owner" });
  });

  it("falls back down the preference order", () => {
    expect(pickOwnerAssociation([assoc(9, "Location Liason"), assoc(8, "Billing Contact")]))
      .toEqual({ contactId: "8", label: "Billing Contact" });
  });

  it("still returns an unlabelled or unrecognised association rather than nothing", () => {
    expect(pickOwnerAssociation([assoc(7, null)])).toEqual({ contactId: "7", label: null });
    expect(pickOwnerAssociation([assoc(6, "Head Chef")])).toEqual({ contactId: "6", label: "Head Chef" });
  });

  it("is null when the company has no contacts", () => {
    expect(pickOwnerAssociation([])).toBeNull();
  });
});

describe("rankContactAssociations", () => {
  const assoc = (id: number, ...labels: Array<string | null>): CompanyAssociation => ({
    toObjectId: id,
    associationTypes: labels.map(label => ({ label })),
  });

  it("returns every contact, best label first", () => {
    expect(rankContactAssociations([
      assoc(1, "Location Liason"),
      assoc(2, null),
      assoc(3, "Business Owner"),
      assoc(4, "Billing Contact"),
    ]).map(c => c.contactId)).toEqual(["3", "4", "1", "2"]);
  });

  it("keeps HubSpot's order among equally ranked contacts", () => {
    expect(rankContactAssociations([assoc(5, null), assoc(6, null), assoc(7, null)]).map(c => c.contactId))
      .toEqual(["5", "6", "7"]);
  });

  it("collapses a contact that appears on several association rows", () => {
    expect(rankContactAssociations([
      assoc(1, "Contact with Primary Company"),
      assoc(1, "Business Owner"),
    ])).toEqual([{ contactId: "1", label: "Business Owner" }]);
  });

  it("is empty when there are no contacts", () => {
    expect(rankContactAssociations([])).toEqual([]);
  });
});

describe("choosing among several contacts", () => {
  const person = (id: string, firstName: string, email: string | null): HubspotContact => ({
    id, firstName, lastName: "Smith", jobTitle: null, email, phone: null, associationLabel: null,
  });
  const company = { ...EMPTY, name: "Bojax", email: "store@example.com" };

  it("preselects a contact only when there is exactly one", () => {
    expect(initialContactChoice([])).toBeNull();
    expect(initialContactChoice([person("1", "Ann", "a@x.com")])).toBe("1");
    expect(initialContactChoice([person("1", "Ann", "a@x.com"), person("2", "Bo", "b@x.com")])).toBeNull();
  });

  it("lists the deal's contacts first and drops a company duplicate of one", () => {
    const d = (c: HubspotContact): HubspotContact => ({ ...c, source: "deal" });
    const co = (c: HubspotContact): HubspotContact => ({ ...c, source: "company" });
    const merged = mergeDealAndCompanyContacts(
      [d(person("2", "Bo", "b@x.com"))],
      [co(person("1", "Ann", "a@x.com")), co(person("2", "Bo", "b@x.com"))]
    );
    expect(merged.map(c => c.id)).toEqual(["2", "1"]);
    expect(merged[0].source).toBe("deal");
  });

  it("preselects a lone deal contact even with company contacts underneath", () => {
    const d = { ...person("2", "Bo", "b@x.com"), source: "deal" as const };
    const c1 = { ...person("1", "Ann", "a@x.com"), source: "company" as const };
    const c3 = { ...person("3", "Cy", "c@x.com"), source: "company" as const };
    expect(initialContactChoice([d, c1, c3])).toBe("2");
    expect(initialContactChoice([d, { ...d, id: "4" }, c1])).toBeNull();
  });

  it("leaves the owner fields blank until one of several contacts is picked", () => {
    const contacts = [person("1", "Ann", "a@x.com"), person("2", "Bo", "b@x.com")];
    const p = buildProspectPrefillForContact(company, contacts, null);
    expect(p.ownerContact).toEqual({});
    expect(p.business.legalName).toBe("Bojax");
  });

  it("fills the owner fields from whichever contact was picked", () => {
    const contacts = [person("1", "Ann", "a@x.com"), person("2", "Bo", "b@x.com")];
    expect(buildProspectPrefillForContact(company, contacts, "2").ownerContact)
      .toEqual({ firstName: "Bo", lastName: "Smith", email: "b@x.com" });
  });

  it("does not stand the company's location email in for a contact who has none", () => {
    const contacts = [person("1", "Ann", null), person("2", "Bo", "b@x.com")];
    expect(buildProspectPrefillForContact(company, contacts, "1").ownerContact)
      .toEqual({ firstName: "Ann", lastName: "Smith" });
  });

  it("still uses the location email when the company has no contacts at all", () => {
    expect(buildProspectPrefillForContact(company, [], null).ownerContact).toEqual({ email: "store@example.com" });
  });

  it("labels a contact by name, title and email, then association", () => {
    expect(contactOptionLabel({
      id: "1", firstName: "Angie", lastName: "Johnson", jobTitle: "Owner",
      email: "angie@x.com", phone: null, associationLabel: "Business Owner",
    })).toBe("Angie Johnson · Owner · angie@x.com (Business Owner)");
    expect(contactOptionLabel(person("2", "Bo", null))).toBe("Bo Smith");
    expect(contactOptionLabel({
      id: "9", firstName: null, lastName: null, jobTitle: null, email: null, phone: null, associationLabel: null,
    })).toBe("Contact 9");
  });
});

describe("buildProspectPrefill", () => {
  it("maps a fully populated company and contact", () => {
    const p = buildProspectPrefill(FULL, CONTACT);
    expect(p.business).toEqual({
      legalName: "Little Arabia Restaurant",
      dba: "Little Arabia Restaurant",
      address: "638 South Brookhurst Street",
      city: "Anaheim",
      state: "CA",
      zip: "92804",
      phone: "714-833-5760",
      website: "https://littlearabiarestaurant.com",
      // The company's address doubles as the DBA (operating-location) address.
      dbaAddress: "638 South Brookhurst Street",
      dbaCity: "Anaheim",
      dbaState: "CA",
      dbaZip: "92804",
    });
    expect(p.ownerContact).toEqual({
      firstName: "Angie", lastName: "Johnson", title: "Owner",
      email: "angie@littlearabia.com", phone: "707-489-1963",
    });
    expect(p.processing).toEqual({
      currentProcessor: "Clover",
      businessDescription: "Authentic Lebanese dining, Mediterranean cuisine.",
      monthlyVolume: "230000",
    });
    expect(p.channels).toEqual(["website", "third_party_delivery"]);
    expect(p.country).toBe("US");
    expect(p.industryType).toBe("TSR");
    expect(p.ownershipType).toBe("Franchisee");
    expect(p.contactSource).toBe("Business Owner");
  });

  it("never invents an MCC, a bizType, or a ticket/card-mix figure", () => {
    const p = buildProspectPrefill(FULL, CONTACT);
    expect(p.processing.mcc).toBeUndefined();
    expect(p.processing.avgTicket).toBeUndefined();
    expect(p.processing.cardPresentPct).toBeUndefined();
    expect(p.business.bizType).toBeUndefined();
    expect(p.business.yearsInBusiness).toBeUndefined();
    expect(p.business.annualRevenue).toBeUndefined();
  });

  it("leaves monthly volume absent when the company has none", () => {
    const p = buildProspectPrefill({ ...FULL, processingVolume: null }, CONTACT);
    expect(p.processing.monthlyVolume).toBeUndefined();
    expect(p.fromHubspot).not.toContain("processing.monthlyVolume");
  });

  it("reports per-field provenance for exactly what HubSpot supplied", () => {
    const p = buildProspectPrefill(FULL, CONTACT);
    expect(p.fromHubspot).toEqual([
      "business.legalName", "business.dba", "business.address", "business.city",
      "business.state", "business.zip", "business.phone", "business.website",
      "business.dbaAddress", "business.dbaCity", "business.dbaState", "business.dbaZip",
      "ownerContact.firstName", "ownerContact.lastName", "ownerContact.title",
      "ownerContact.email", "ownerContact.phone",
      "processing.currentProcessor", "processing.businessDescription",
      "processing.monthlyVolume",
      "channels",
    ]);
  });

  it("prefills the DBA address from the company's own address, only as a whole", () => {
    const p = buildProspectPrefill(FULL, CONTACT);
    expect(p.business.dbaAddress).toBe(p.business.address);
    expect(p.business.dbaCity).toBe(p.business.city);
    expect(p.business.dbaState).toBe(p.business.state);
    expect(p.business.dbaZip).toBe(p.business.zip);
    // A city with no street is not a location: no DBA fields at all.
    const cityOnly = buildProspectPrefill({ ...FULL, address: null }, CONTACT);
    expect(Object.keys(cityOnly.business).filter(k => k.startsWith("dba") && k !== "dba")).toEqual([]);
  });

  it("returns empty, key-free partials for an empty company", () => {
    const p = buildProspectPrefill(EMPTY, null);
    expect(p).toEqual({ business: {}, ownerContact: {}, processing: {}, channels: [], fromHubspot: [] });
  });

  it("returns the same empty shape for a missing company", () => {
    expect(buildProspectPrefill(null)).toEqual({
      business: {}, ownerContact: {}, processing: {}, channels: [], fromHubspot: [],
    });
    expect(buildProspectPrefill(undefined)).toEqual({
      business: {}, ownerContact: {}, processing: {}, channels: [], fromHubspot: [],
    });
  });

  it("omits missing fields rather than emitting empty strings", () => {
    const partial: HubspotCompanyProfile = { ...EMPTY, name: "Bojax", city: "Oakland", phone: "+1 510-969-5116" };
    const p = buildProspectPrefill(partial, null);
    expect(p.business).toEqual({
      legalName: "Bojax", dba: "Bojax", city: "Oakland", phone: "510-969-5116",
    });
    expect("state" in p.business).toBe(false);
    expect("zip" in p.business).toBe(false);
    expect(p.ownerContact).toEqual({});
    expect(p.processing).toEqual({});
    expect(p.fromHubspot).toEqual(["business.legalName", "business.dba", "business.city", "business.phone"]);
  });

  it("falls back to the bare domain when there's no website", () => {
    const p = buildProspectPrefill({ ...EMPTY, domain: "bakersdozendonuts.com" }, null);
    expect(p.business.website).toBe("bakersdozendonuts.com");
  });

  it("falls back to the company's location_email when the contact has no address", () => {
    const p = buildProspectPrefill(
      { ...EMPTY, email: "store@example.com" },
      { ...CONTACT, email: null, firstName: null, lastName: null, jobTitle: null, phone: null }
    );
    expect(p.ownerContact).toEqual({ email: "store@example.com" });
    expect(p.contactSource).toBe("Business Owner");
  });

  it("handles a contact whose properties couldn't be read (403 on the billing token)", () => {
    const unreadable: HubspotContact = {
      id: "1", firstName: null, lastName: null, jobTitle: null, email: null, phone: null,
      associationLabel: "Business Owner",
    };
    const p = buildProspectPrefill(FULL, unreadable);
    expect(p.ownerContact).toEqual({ email: "hello@littlearabia.com" });
    expect(p.business.city).toBe("Anaheim");
  });

  it("normalizes messy real-world state and address values", () => {
    const messy: HubspotCompanyProfile = {
      ...EMPTY,
      name: "EastBrew Cafe",
      address: "12303 Limonite Ave Ste 710, Eastvale, CA 91752, United States",
      city: "Eastvale",
      state: "Ca ",
      country: "United States",
    };
    const p = buildProspectPrefill(messy, null);
    expect(p.business.address).toBe("12303 Limonite Ave Ste 710");
    expect(p.business.state).toBe("CA");
    expect(p.country).toBe("US");
  });

  it("keeps an unrecognised state string rather than dropping the rep's data", () => {
    const p = buildProspectPrefill({ ...EMPTY, state: "Baja California" }, null);
    expect(p.business.state).toBe("Baja California");
  });
});

// `processing_volume` is the one volume property that is actually populated —
// 24 companies on 2026-09-25, verified against the live portal. Its
// near-namesake `monthly_card_volume` has 0 and is deliberately not read.
describe("monthlyVolumeFromCompany", () => {
  it("passes a real monthly volume through as a plain number string", () => {
    expect(monthlyVolumeFromCompany("230000")).toBe("230000");
    expect(monthlyVolumeFromCompany(" 80000 ")).toBe("80000");
  });

  it("drops zero, blank and non-numeric values rather than prefilling a wrong floor input", () => {
    for (const v of ["0", "", "   ", null, undefined, "n/a", "-5"]) {
      expect(monthlyVolumeFromCompany(v)).toBeUndefined();
    }
  });
});
