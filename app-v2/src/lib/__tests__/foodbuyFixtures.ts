// Shared Foodbuy agreement fixtures for foodbuyForm.test.ts and foodbuyPdf.test.ts.
import { defaultFoodbuyForm } from "@/lib/foodbuyForm";
import type { BusinessInfo, FoodbuyFormData, OwnerContact } from "@/types/merchant";

export const BUSINESS: BusinessInfo = {
  legalName: "Torta Palace LLC",
  dba: "Torta Palace",
  bizType: "llc",
  address: "123 Main St",
  city: "Anaheim",
  state: "CA",
  zip: "92804",
  phone: "555-0100",
  website: "",
  yearsInBusiness: "5",
  annualRevenue: "500000",
};

export const CONTACT: OwnerContact = {
  firstName: "Jane",
  lastName: "Doe",
  title: "Owner",
  email: "jane@tortapalace.com",
  phone: "555-0101",
};

export const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A form the customer has finished: pre-fill plus everything they enter. */
export function completeForm(): FoodbuyFormData {
  const f = defaultFoodbuyForm({ business: BUSINESS, ownerContact: CONTACT, foodbuyIds: null });
  return {
    ...f,
    business: { ...f.business, ein: "12-3456789" },
    gpo: { participates: false, name: "" },
    locations: [{ ...f.locations[0], distributor: "Sysco Los Angeles", acct: "168255" }],
    sysco: { name: "Miguel Perez", phone: "510-695-5147", email: "miguel@sysco.com" },
    accept: true,
    signature: SIGNATURE,
    signedDate: "08/04/2026",
  };
}
