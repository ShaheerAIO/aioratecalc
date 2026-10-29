// The Foodbuy participation agreement (AIO_Foodbuy_Enrollment_Form_V1) as a
// form the customer fills in on the Foodbuy step: what it starts with, how it
// is checked, and how a request body is coerced back into it. Pure, so the
// browser and the routes share one validator. lib/foodbuyPdf.ts renders it.
//
// Pre-filled from what AIO already holds: business identity and address, the
// main contact, and a first location row at the business's DBA address.
// Everything else the customer enters: their distributors and account
// numbers, GPO affiliation, direct manufacturer agreements, their Sysco rep,
// and the signature.
//
// The Federal ID # (EIN) always starts BLANK. EasyOB does hold one since
// 2026-10-15 (`business.ein`), and it is still deliberately not pre-filled:
// this line sits above a legal attestation the merchant signs, so the
// merchant is the one who types it. It is also never saved (FoodbuySavedForm).
import {
  locationAddress,
  type BusinessInfo, type FoodbuyContact, type FoodbuyDirectAgreement, type FoodbuyFormData,
  type FoodbuyLocation, type FoodbuySavedForm, type MerchantApplication,
} from "@/types/merchant";

const BIZ_TYPE_LABEL: Record<BusinessInfo["bizType"], string> = {
  // Unspecified stays blank for the customer to fill in: never assert a legal
  // entity nobody stated.
  "": "",
  llc: "LLC",
  corp: "Corporation",
  "s-corp": "S-Corp",
  "sole-prop": "Sole Proprietorship",
  partnership: "Partnership",
  "non-profit": "Non-Profit",
};

/** Rows the PDF has room for: page 4 holds 22 locations, page 3 eight agreements. */
export const FOODBUY_LOCATIONS_PER_PAGE = 22;
export const FOODBUY_MAX_LOCATIONS = FOODBUY_LOCATIONS_PER_PAGE * 3;
export const FOODBUY_MAX_DIRECT_AGREEMENTS = 8;
/** A drawn signature is a small PNG; anything near this is not one. */
export const FOODBUY_SIGNATURE_MAX_CHARS = 300_000;
const MAX_FIELD = 200;

export const emptyContact = (): FoodbuyContact => ({ name: "", title: "", phone: "", fax: "", email: "" });
export const emptyLocation = (): FoodbuyLocation => ({ name: "", address: "", city: "", state: "", zip: "", distributor: "", acct: "" });
export const emptyDirectAgreement = (): FoodbuyDirectAgreement => ({ manufacturer: "", category: "", start: "", end: "" });

/** Today as MM/DD/YYYY, the format the form prints dates in. */
export function foodbuyDate(d: Date = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

export function defaultFoodbuyForm(app: Pick<MerchantApplication, "business" | "ownerContact" | "foodbuyIds">): FoodbuyFormData {
  const b = app.business;
  const oc = app.ownerContact;
  const contactName = [oc?.firstName, oc?.lastName].filter(Boolean).join(" ");
  const loc = b ? locationAddress(b) : { address: "", city: "", state: "", zip: "" };
  const fresh: FoodbuyFormData = {
    business: {
      legalName: b?.legalName ?? "",
      ein: "",
      dba: b?.dba ?? "",
      bizType: b ? BIZ_TYPE_LABEL[b.bizType] ?? "" : "",
      address: b?.address ?? "",
      suite: "",
      city: b?.city ?? "",
      state: b?.state ?? "",
      zip: b?.zip ?? "",
    },
    contacts: [
      { name: contactName, title: oc?.title ?? "", phone: oc?.phone ?? "", fax: "", email: oc?.email ?? "" },
      emptyContact(),
    ],
    gpo: { participates: null, name: "" },
    locations: [{ ...emptyLocation(), name: b?.dba || b?.legalName || "", ...loc }],
    directAgreements: [],
    sysco: { name: "", phone: "", email: "" },
    accept: false,
    printName: contactName,
    printTitle: oc?.title ?? "",
    signature: "",
    signedDate: foodbuyDate(),
  };
  // The last send's answers win over AIO's records: they're what the
  // customer corrected them to.
  const saved = app.foodbuyIds?.form;
  if (!saved) return fresh;
  return {
    ...fresh,
    ...saved,
    business: { ...saved.business, ein: "" },
    accept: false,
    signature: "",
    signedDate: fresh.signedDate,
  };
}

/** The answers worth keeping between visits (see FoodbuySavedForm). */
export function toSavedForm(data: FoodbuyFormData): FoodbuySavedForm {
  const { business, accept: _accept, signature: _signature, signedDate: _signedDate, ...rest } = data;
  const { ein: _ein, ...savedBusiness } = business;
  return { ...rest, business: savedBusiness };
}

/** True when a distributor row names Sysco, which makes page 5's Sysco contact required. */
export function usesSysco(data: Pick<FoodbuyFormData, "locations">): boolean {
  return data.locations.some(l => /sysco/i.test(l.distributor));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;

/**
 * Field-path → message for everything that blocks the agreement, e.g.
 * "business.ein" or "locations.2.acct". Empty when it's complete.
 */
export function validateFoodbuyForm(data: FoodbuyFormData): Record<string, string> {
  const errors: Record<string, string> = {};
  const need = (path: string, value: string, label: string) => {
    if (!value.trim()) errors[path] = `${label} is required`;
  };
  const email = (path: string, value: string) => {
    if (value.trim() && !EMAIL_RE.test(value.trim())) errors[path] = "Enter a valid email address";
  };

  const b = data.business;
  need("business.legalName", b.legalName, "Legal entity name");
  if (!/^\d{2}-?\d{7}$/.test(b.ein.trim())) errors["business.ein"] = "Enter your 9-digit Federal ID # (EIN)";
  need("business.bizType", b.bizType, "Type of business");
  need("business.address", b.address, "Corporate address");
  need("business.city", b.city, "City");
  need("business.state", b.state, "State");
  need("business.zip", b.zip, "Zip code");

  const [c1, c2] = data.contacts;
  need("contacts.0.name", c1.name, "Contact name");
  need("contacts.0.title", c1.title, "Title");
  need("contacts.0.phone", c1.phone, "Phone");
  need("contacts.0.email", c1.email, "Email");
  email("contacts.0.email", c1.email);
  // The second contact is optional, but a half-filled one would print as a
  // half-filled block on the agreement.
  if (Object.values(c2).some(v => v.trim())) {
    need("contacts.1.name", c2.name, "Contact name");
    need("contacts.1.email", c2.email, "Email");
    email("contacts.1.email", c2.email);
  }

  if (data.gpo.participates === null) errors["gpo.participates"] = "Choose whether you currently participate in a GPO";
  if (data.gpo.participates) need("gpo.name", data.gpo.name, "Your current GPO/PSO/Buying Group");

  if (data.locations.length === 0) errors["locations"] = "Add at least one location and distributor";
  if (data.locations.length > FOODBUY_MAX_LOCATIONS) errors["locations"] = `At most ${FOODBUY_MAX_LOCATIONS} rows`;
  data.locations.forEach((l, i) => {
    need(`locations.${i}.name`, l.name, "Location name");
    need(`locations.${i}.address`, l.address, "Address");
    need(`locations.${i}.city`, l.city, "City");
    need(`locations.${i}.state`, l.state, "State");
    need(`locations.${i}.zip`, l.zip, "Zip code");
    need(`locations.${i}.distributor`, l.distributor, "Distributor name/location");
    need(`locations.${i}.acct`, l.acct, "Account #");
  });

  if (data.directAgreements.length > FOODBUY_MAX_DIRECT_AGREEMENTS) {
    errors["directAgreements"] = `At most ${FOODBUY_MAX_DIRECT_AGREEMENTS} agreements`;
  }
  data.directAgreements.forEach((a, i) => {
    need(`directAgreements.${i}.manufacturer`, a.manufacturer, "Manufacturer");
    need(`directAgreements.${i}.category`, a.category, "Category");
    need(`directAgreements.${i}.start`, a.start, "Start date");
    need(`directAgreements.${i}.end`, a.end, "End date");
  });

  if (usesSysco(data)) {
    need("sysco.name", data.sysco.name, "Sysco contact name");
    need("sysco.phone", data.sysco.phone, "Sysco contact phone");
    need("sysco.email", data.sysco.email, "Sysco contact email");
  }
  email("sysco.email", data.sysco.email);

  if (!data.accept) errors["accept"] = "Accept the terms to sign the agreement";
  need("printName", data.printName, "Print name");
  need("printTitle", data.printTitle, "Title");
  if (!data.signature.startsWith("data:image/png;base64,")) errors["signature"] = "Sign the agreement";
  else if (data.signature.length > FOODBUY_SIGNATURE_MAX_CHARS) errors["signature"] = "Clear the signature and sign again";
  if (!DATE_RE.test(data.signedDate)) errors["signedDate"] = "Invalid date";

  return errors;
}

/**
 * Coerce an untrusted request body into the form's shape: every value a
 * trimmed, length-capped string, rows capped at what validation allows (plus
 * one, so an over-long list still fails validation rather than being silently
 * cut). Null when the body isn't an object at all.
 */
export function parseFoodbuyForm(raw: unknown): FoodbuyFormData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const str = (v: unknown, max = MAX_FIELD) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const rows = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max + 1).map(obj) : []);
  const contact = (v: unknown): FoodbuyContact => {
    const c = obj(v);
    return { name: str(c.name), title: str(c.title), phone: str(c.phone), fax: str(c.fax), email: str(c.email) };
  };
  const b = obj(r.business);
  const contacts = Array.isArray(r.contacts) ? r.contacts : [];
  const gpo = obj(r.gpo);
  const sysco = obj(r.sysco);
  return {
    business: {
      legalName: str(b.legalName), ein: str(b.ein), dba: str(b.dba), bizType: str(b.bizType),
      address: str(b.address), suite: str(b.suite), city: str(b.city), state: str(b.state), zip: str(b.zip),
    },
    contacts: [contact(contacts[0]), contact(contacts[1])],
    gpo: { participates: typeof gpo.participates === "boolean" ? gpo.participates : null, name: str(gpo.name) },
    locations: rows(r.locations, FOODBUY_MAX_LOCATIONS).map(l => ({
      name: str(l.name), address: str(l.address), city: str(l.city), state: str(l.state), zip: str(l.zip),
      distributor: str(l.distributor), acct: str(l.acct),
    })),
    directAgreements: rows(r.directAgreements, FOODBUY_MAX_DIRECT_AGREEMENTS).map(a => ({
      manufacturer: str(a.manufacturer), category: str(a.category), start: str(a.start), end: str(a.end),
    })),
    sysco: { name: str(sysco.name), phone: str(sysco.phone), email: str(sysco.email) },
    accept: r.accept === true,
    printName: str(r.printName),
    printTitle: str(r.printTitle),
    signature: str(r.signature, FOODBUY_SIGNATURE_MAX_CHARS + 1),
    signedDate: str(r.signedDate, 10),
  };
}

export function buildFoodbuyFormFileName(business: Pick<BusinessInfo, "dba" | "legalName">): string {
  const safeName = (business.dba || business.legalName || "Business").replace(/[^a-zA-Z0-9]/g, "-");
  const dateStr = new Date().toISOString().slice(0, 10);
  return `AIO-Foodbuy-Enrollment-${safeName}-${dateStr}.pdf`;
}
