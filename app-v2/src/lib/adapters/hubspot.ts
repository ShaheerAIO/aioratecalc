// Phase 3: HubSpot bidirectional sync via Private App Token
// Scopes required: crm.objects.deals.read/write, crm.objects.contacts.read/write

import type {
  BillingFrequency,
  CatalogProduct,
  DealStage,
  HubspotSubscriptionSnapshot,
  MerchantApplication,
  QuoteLine,
} from "@/types/merchant";

const BASE = "https://api.hubapi.com";

// AIO's real sales pipeline. Its *id* is the literal string "default" but its
// *label* is "Sales " and it carries 19 custom, mostly-numeric stage ids
// (PAYMENT-TEST-PLAN.md §1.8, O-5, read from the live portal 2026-08-20). The
// portal's only other deal pipeline is "Onboarding" (2329370331), which EasyOB
// never writes to. Sent explicitly on every write so the stage ids below are
// unambiguously scoped rather than relying on HubSpot's default.
export const HUBSPOT_DEAL_PIPELINE_ID = "default";

// EasyOB's 15 DealStage values onto that pipeline's real stage ids. `satisfies
// Record<DealStage, string>` makes a newly added DealStage a COMPILE error
// rather than a silent fall-through: the previous map omitted four values
// (including `merchant_filling`, the stage set immediately before the push)
// and fell back to the pipeline's first stage, dragging live deals backwards.
//
// Several EasyOB stages deliberately share one HubSpot stage: AIO's pipeline is
// meeting- and signature-driven and has no equivalent of "waiting on the
// merchant's statement" or "the proposal is generated but not sent yet". Two
// real stages are deliberately left unused — `appointmentscheduled`
// ("Appointment Scheduled") and `stage_0` ("Demo Meeting") are calendar events
// a rep books, not states EasyOB can observe — and so is everything after
// `closedwon` (Onboarding / Configuration / Deployment / Deal Active), which
// AIO's ops team owns in HubSpot; pushing those from here would fight them.
export const STAGE_MAP = {
  prospect_created: "3262845631",      // Sales Accepted
  lead_link_sent: "3262845631",        // Sales Accepted — nothing presented yet
  lead_analysis_pending: "2717103849", // Discovery Meeting — merchant handed over a statement
  analysis: "2717103849",              // Discovery Meeting
  pricing: "2717103849",               // Discovery Meeting — internal work, nothing sent
  proposal_ready: "2717103849",        // Discovery Meeting — generated, not sent
  quote_sent: "3634617027",            // Quote Sent
  proposal_sent: "3634617027",         // Quote Sent
  quote_accepted: "2767738593",        // Signed/Awaiting Payment Info
  merchant_link_sent: "2767738593",    // Signed/Awaiting Payment Info
  merchant_filling: "2767738593",      // Signed/Awaiting Payment Info
  adyen_kyc_pending: "2767738593",     // Signed/Awaiting Payment Info
  // Finishing KYC is the merchant's side of the work, not Adyen's verdict on
  // it — a deal isn't won until Adyen actually approves. Only adyen_approved
  // reaches closedwon, so EasyOB never inflates the forecast.
  adyen_kyc_complete: "2767738593", // Signed/Awaiting Payment Info
  adyen_approved: "closedwon",
  closed_lost: "closedlost",
} satisfies Record<DealStage, string>;

// Two private apps, two tokens. The general CRM app is companies-read-only,
// covering the tenant linkage lookups below; the billing app covers deals,
// products, quotes, line items, subscriptions and invoices. The general app
// has no deals scope, so deal sync goes through the billing app's token too —
// pick the right one per call rather than defaulting to either.
function tokenHeaders(token: string | undefined, varName: string) {
  if (!token) throw new Error(`${varName} is not set`);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function headers() {
  return tokenHeaders(process.env.HUBSPOT_PRIVATE_APP_TOKEN, "HUBSPOT_PRIVATE_APP_TOKEN");
}

function billingHeaders() {
  return tokenHeaders(process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN, "HUBSPOT_BILLING_PRIVATE_APP_TOKEN");
}

// Every property this adapter reads or writes on a DEAL, and the only ones
// that exist on the portal's DEAL object — the five the payload used to also
// carry (`current_processor`,
// `current_monthly_fees`, `projected_annual_savings`, `proposed_effective_rate`,
// `mcc_code`) were never created there, and HubSpot v3 rejects the ENTIRE
// request with 400 PROPERTY_DOESNT_EXIST when any name is unknown, so every
// deal write failed from the day this shipped. Dropped rather than created in
// the portal: the commercial detail a merchant actually signs is the quote's
// line items, and the quoted side of Phase G's comparison is frozen on the
// application itself (quoteConfig / analysis / targetMargin / quoteLines).
// Anything added here MUST exist on DEAL first — verify with
// GET /crm/v3/properties/deals before adding a name.
export const DEAL_PROPERTIES = ["dealname", "pipeline", "dealstage", "amount"] as const;

// HUBSPOT_DEFINED deal → company, unlabeled (PAYMENT-TEST-PLAN.md §1.1; 5 is
// the "Primary" labelled variant of the same pair). HubSpot marks a deal's
// first company association primary on its own, so the unlabeled id is enough
// to put the deal on the Company record where reps work it.
// deal → contact is typeId 3, but no contact id exists on MerchantApplication
// yet — that association belongs with Phase E's ensureQuoteContact.
export const DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID = 341;

export type HubspotAssociation = {
  to: { id: string };
  types: Array<{ associationCategory: "HUBSPOT_DEFINED"; associationTypeId: number }>;
};

// The three places a monthly card volume can live, in order of authority: what
// the merchant typed on the onboarding form, what their statement said, then the
// figure the rep quoted from. The third matters because the deal is now pushed
// on acceptance — a no-statement quote reaches HubSpot with only quoteConfig
// filled in, and reading the first two alone put those deals in the pipeline at
// $0. Marketing-only quotes have no volume at all and still amount to 0.
function annualVolume(app: MerchantApplication): number {
  const monthly =
    parseFloat(app.processing?.monthlyVolume || "0") ||
    app.analysis?.totalVolume ||
    app.quoteConfig?.monthlyVolume ||
    0;
  return monthly * 12;
}

/**
 * Pure: the property bag for a deal write. `pipeline`/`dealstage` are omitted
 * (rather than defaulted to the pipeline's first stage) when the row carries a
 * stage this build doesn't know — leaving a deal where it is beats shoving it
 * backwards through AIO's pipeline.
 */
export function buildDealProperties(app: MerchantApplication): Record<string, string> {
  const props: Record<string, string> = {
    dealname: app.business?.dba || app.business?.legalName || app.analysis?.merchantName || "New Deal",
    amount: String(Math.round(annualVolume(app))),
  };
  const dealstage = (STAGE_MAP as Record<string, string | undefined>)[app.stage];
  if (dealstage) {
    props.pipeline = HUBSPOT_DEAL_PIPELINE_ID;
    props.dealstage = dealstage;
  } else {
    console.warn(`pushToHubSpot: unmapped deal stage '${app.stage}' — leaving pipeline/dealstage untouched`);
  }
  return props;
}

/**
 * Pure: v3 inline associations for a deal CREATE. Empty when the application
 * has no tenant link yet — a prospect created without the HubSpot deep link
 * still gets a deal, and the manual tenant-link flow can attach it later.
 */
export function buildDealAssociations(app: MerchantApplication): HubspotAssociation[] {
  const companyId = clean(app.tenantLink?.hubspotCompanyId);
  if (!companyId) return [];
  return [{
    to: { id: companyId },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: DEAL_TO_COMPANY_ASSOCIATION_TYPE_ID }],
  }];
}

// Both call sites are fire-and-log (`src/lib/actions/customer.ts`), so the
// thrown message is the only record of what went wrong — name the stage, the
// properties and the associations that were actually sent.
function describeDealWrite(
  app: MerchantApplication,
  props: Record<string, string>,
  associations: HubspotAssociation[]
): string {
  const parts = [`properties ${Object.keys(props).join(", ")}`];
  parts.push(props.dealstage
    ? `stage '${app.stage}' → dealstage ${props.dealstage} in pipeline ${props.pipeline}`
    : `stage '${app.stage}' unmapped, dealstage/pipeline omitted`);
  parts.push(associations.length
    ? `associations ${associations.map(a => `company ${a.to.id} type ${a.types.map(t => t.associationTypeId).join("/")}`).join("; ")}`
    : "no associations (no tenantLink.hubspotCompanyId)");
  return parts.join("; ");
}

export async function pushToHubSpot(app: MerchantApplication): Promise<string> {
  const props = buildDealProperties(app);

  if (app.hubspotDealId) {
    // Update existing deal. v3 PATCH takes properties only — associations are
    // set on create (and via the v4 surface), never here.
    const res = await fetch(`${BASE}/crm/v3/objects/deals/${app.hubspotDealId}`, {
      method: "PATCH",
      headers: billingHeaders(),
      body: JSON.stringify({ properties: props }),
    });
    if (!res.ok) {
      throw hubspotErr(
        `HubSpot deal ${app.hubspotDealId} update failed (${describeDealWrite(app, props, [])})`,
        res.status, await res.text()
      );
    }
    return app.hubspotDealId;
  }

  // Create deal, associated to its tenant Company when we know it.
  const associations = buildDealAssociations(app);
  const res = await fetch(`${BASE}/crm/v3/objects/deals`, {
    method: "POST",
    headers: billingHeaders(),
    body: JSON.stringify(associations.length ? { properties: props, associations } : { properties: props }),
  });
  if (!res.ok) {
    throw hubspotErr(
      `HubSpot deal create failed (${describeDealWrite(app, props, associations)})`,
      res.status, await res.text()
    );
  }
  const data = await res.json() as { id: string };
  return data.id;
}

// ── Phase 3: tenant linkage (read-only) ─────────────────────────────────────
// HubSpot Companies are the system of record for AIO tenants and their
// AIO-dashboard-created Adyen objects (AIOad). An admin/rep links an easyob
// account (ezacc) to the right Company; we only ever READ here — no writes to
// HubSpot, no Adyen calls. Requires the private app's crm.objects.companies.read
// scope. tenant_id holds the "prod-{n}" store-ref format; adyen_account_holder_id
// is the AIOad account holder (occasionally stored with trailing whitespace).

export type TenantCompany = {
  id: string;
  name: string;
  tenantRef: string | null;            // HubSpot "tenant_id", e.g. "prod-1024"
  adyenAccountHolderId: string | null; // "AH32..."
  mid: string | null;
  phone: string | null;                // Company "phone" — reliably populated, unlike location_email
  email: string | null;                // Company "location_email" — sparsely populated; often null
};

// "phone"/"location_email" added for Phase F prospect prefill (deep link from
// the Company record). Verified live 2026-08-18: `name`/`phone` are reliably
// populated on real Company records; `location_email` is usually null (there
// is no standard "contact email" property on a HubSpot Company — that lives
// on an associated Contact, which this companies-read-only token can't read).
const TENANT_COMPANY_PROPS = ["name", "tenant_id", "adyen_account_holder_id", "mid", "phone", "location_email"];

function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

function toTenantCompany(obj: { id: string; properties: Record<string, string | null> }): TenantCompany {
  const p = obj.properties;
  return {
    id: obj.id,
    name: clean(p.name) || "(unnamed company)",
    tenantRef: clean(p.tenant_id),
    adyenAccountHolderId: clean(p.adyen_account_holder_id),
    mid: clean(p.mid),
    phone: clean(p.phone),
    email: clean(p.location_email),
  };
}

// A 403 means the private app is missing a scope. Don't name one here — this
// helper is shared across company, product and quote calls, and HubSpot's body
// already carries the specific `requiredGranularScopes` for the failing call.
function hubspotErr(prefix: string, status: number, body: string): Error {
  const hint = status === 403 ? " — the private app is missing a required scope" : "";
  return new Error(`${prefix}: ${status}${hint} ${body}`.trim());
}

// Free-text search over Companies (name/domain/etc.) for the tenant picker.
// Returns the tenant identifiers each candidate carries so the admin can
// confirm they're linking the right one before committing.
export async function searchTenantCompanies(query: string, limit = 10): Promise<TenantCompany[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await fetch(`${BASE}/crm/v3/objects/companies/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query: q, limit, properties: TENANT_COMPANY_PROPS }),
  });
  if (!res.ok) throw hubspotErr("HubSpot company search failed", res.status, await res.text());
  const data = await res.json() as { results?: Array<{ id: string; properties: Record<string, string | null> }> };
  return (data.results ?? []).map(toTenantCompany);
}

// Fetch a single Company by id at link time, so the snapshot we persist comes
// from a fresh read rather than trusting whatever the picker last showed.
export async function getTenantCompany(companyId: string): Promise<TenantCompany | null> {
  const res = await fetch(
    `${BASE}/crm/v3/objects/companies/${companyId}?properties=${TENANT_COMPANY_PROPS.join(",")}`,
    { headers: headers() }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw hubspotErr("HubSpot company fetch failed", res.status, await res.text());
  const data = await res.json() as { id: string; properties: Record<string, string | null> };
  return toTenantCompany(data);
}

// ── Phase F: prospect prefill from the Company record ───────────────────────
// A rep arriving from the HubSpot deep link should get an application filled in
// with everything the Company already knows. That's a WIDER read than the
// tenant-link lookup above, so it's a sibling call rather than a widening of
// TENANT_COMPANY_PROPS: `searchTenantCompanies` is a type-ahead picker that
// doesn't want fourteen extra properties per hit, and the tenant-link snapshot
// must keep reading exactly what it reads today.
//
// Property choice is driven by measured portal-wide fill rates (n=100), not by
// what the schema offers. Deliberately NOT read, because they're empty portal
// wide: legal_trading_name_as_registered_with_government, legal_*_address_*,
// full_name, processing_volume, monthly_card_volume, of_locations, the FEIN
// property, annualrevenue, founded_year. Note `moduels` — the typo is the real
// internal name.
export type HubspotCompanyProfile = TenantCompany & {
  domain: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;   // free text: "CA", "Ca", "California"
  zip: string | null;
  country: string | null; // free text: "USA", "United States", "US"
  description: string | null;
  industryType: string | null;  // "industrytype", labelled "Restaurant Type": hospitality | Food Truck | TSR | FD | …
  cuisineType: string | null;   // Pizza | Mexican | Thai | …
  ownershipType: string | null; // Inderpendant | Franchisee | Franchisor | Enterprise (sic — HubSpot's own spelling)
  currentPos: string | null;    // Brink | Clover | Square | Toast | …
  modules: string | null;       // "moduels", a checkbox enum: "POS;MPOS;Kiosk"
};

const COMPANY_PROFILE_PROPS = [
  ...TENANT_COMPANY_PROPS,
  "domain", "website", "address", "city", "state", "zip", "country", "description",
  "industrytype", "cuisine_type", "ownership_type", "current_pos", "moduels",
];

function toCompanyProfile(obj: { id: string; properties: Record<string, string | null> }): HubspotCompanyProfile {
  const p = obj.properties;
  return {
    ...toTenantCompany(obj),
    domain: clean(p.domain),
    website: clean(p.website),
    address: clean(p.address),
    city: clean(p.city),
    state: clean(p.state),
    zip: clean(p.zip),
    country: clean(p.country),
    description: clean(p.description),
    industryType: clean(p.industrytype),
    cuisineType: clean(p.cuisine_type),
    ownershipType: clean(p.ownership_type),
    currentPos: clean(p.current_pos),
    modules: clean(p.moduels),
  };
}

/** The wide read behind the prospect prefill. A superset of getTenantCompany. */
export async function getCompanyProfile(companyId: string): Promise<HubspotCompanyProfile | null> {
  const res = await fetch(
    `${BASE}/crm/v3/objects/companies/${companyId}?properties=${COMPANY_PROFILE_PROPS.join(",")}`,
    { headers: headers() }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw hubspotErr("HubSpot company fetch failed", res.status, await res.text());
  const data = await res.json() as { id: string; properties: Record<string, string | null> };
  return toCompanyProfile(data);
}

// ── Owner contact (associated Contact) ──────────────────────────────────────
// There is no contact-person property on a HubSpot Company; the owner lives on
// an associated Contact. Two quirks drive the shape below:
//   1. TOKEN SPLIT. /crm/v4 associations read fine on the general app's token,
//      but reading contact PROPERTIES 403s on it and needs the billing app's
//      token (verified live 2026-08-19). So this is two calls on two tokens.
//   2. A company can have several contacts with different association labels.
//      This portal defines "Business Owner" and "Location Liason" as
//      USER_DEFINED labels alongside HubSpot's "Billing Contact" and "Contact
//      with Primary Company" — pick the right one rather than the first.

export type HubspotContact = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  /** Which association label this contact was chosen on. Null when unlabelled. */
  associationLabel: string | null;
};

// Best first. Anything not listed still qualifies (it's a real association),
// it just sorts last — an unrecognised custom label beats no contact at all.
const CONTACT_LABEL_PRIORITY = [
  "Business Owner",
  "Billing Contact",
  "Contact with Primary Company",
  "Location Liason", // sic — the portal's own spelling
];

export type CompanyAssociation = {
  toObjectId: number | string;
  associationTypes?: Array<{ label?: string | null }>;
};

/**
 * Pure: which associated contact to prefill from. Kept separate from the fetch
 * so the preference order is unit-testable without HubSpot.
 */
export function pickOwnerAssociation(
  results: CompanyAssociation[]
): { contactId: string; label: string | null } | null {
  let best: { contactId: string; label: string | null; rank: number } | null = null;

  for (const result of results) {
    if (result?.toObjectId === undefined || result.toObjectId === null) continue;
    const labels = (result.associationTypes ?? []).map(t => clean(t?.label)).filter((l): l is string => !!l);
    // Rank on the contact's BEST label, so a contact that is both "Business
    // Owner" and "Contact with Primary Company" is ranked as the owner.
    let rank = CONTACT_LABEL_PRIORITY.length;
    let label: string | null = labels[0] ?? null;
    for (const l of labels) {
      const i = CONTACT_LABEL_PRIORITY.indexOf(l);
      if (i !== -1 && i < rank) { rank = i; label = l; }
    }
    if (!best || rank < best.rank) best = { contactId: String(result.toObjectId), label, rank };
  }

  return best ? { contactId: best.contactId, label: best.label } : null;
}

const CONTACT_PROPS = ["firstname", "lastname", "jobtitle", "email", "phone", "mobilephone"];

/**
 * Best-effort owner contact for a company. NEVER throws: this is enrichment on
 * a page that must still render without it, and both calls have their own
 * failure modes (missing billing token, 403, no contacts at all). A contact
 * whose properties can't be read is still returned with its id and label —
 * partial data beats none.
 */
export async function getCompanyOwnerContact(companyId: string): Promise<HubspotContact | null> {
  let picked: { contactId: string; label: string | null } | null = null;
  try {
    const res = await fetch(`${BASE}/crm/v4/objects/companies/${companyId}/associations/contacts`, {
      headers: headers(),
    });
    if (!res.ok) {
      console.warn("getCompanyOwnerContact: association read failed", companyId, res.status);
      return null;
    }
    const data = await res.json() as { results?: CompanyAssociation[] };
    picked = pickOwnerAssociation(data.results ?? []);
  } catch (err) {
    console.warn("getCompanyOwnerContact: association read errored", companyId, err);
    return null;
  }
  if (!picked) return null;

  const empty: HubspotContact = {
    id: picked.contactId, firstName: null, lastName: null, jobTitle: null,
    email: null, phone: null, associationLabel: picked.label,
  };

  try {
    const res = await fetch(
      `${BASE}/crm/v3/objects/contacts/${picked.contactId}?properties=${CONTACT_PROPS.join(",")}`,
      { headers: billingHeaders() }
    );
    if (!res.ok) {
      console.warn("getCompanyOwnerContact: contact read failed", picked.contactId, res.status);
      return empty;
    }
    const data = await res.json() as { properties: Record<string, string | null> };
    const p = data.properties;
    return {
      ...empty,
      firstName: clean(p.firstname),
      lastName: clean(p.lastname),
      jobTitle: clean(p.jobtitle),
      email: clean(p.email),
      phone: clean(p.phone) ?? clean(p.mobilephone),
    };
  } catch (err) {
    console.warn("getCompanyOwnerContact: contact read errored", picked.contactId, err);
    return empty;
  }
}

// ── Product catalog ─────────────────────────────────────────────────────────
// AIO's sellable catalog lives in HubSpot and is maintained there, so we read it
// rather than keeping a copy that would drift. Requires the `e-commerce` scope —
// the crm.objects.line_items scopes do NOT cover the Products API.

// Products with no recurringbillingfrequency are one-time (hardware, install).
const PRODUCT_PROPS = ["name", "price", "hs_product_type", "recurringbillingfrequency", "hs_status"];

// Scratch/placeholder entries a rep should never be able to put on a quote.
const EXCLUDED_PRODUCT_NAMES = ["AIO Platform fee TEST - do not use"];

type CatalogProductRow = CatalogProduct & { status: string };

function toCatalogProduct(obj: { id: string; properties: Record<string, string | null> }): CatalogProductRow {
  const p = obj.properties;
  return {
    hubspotProductId: obj.id,
    name: (p.name ?? "").trim(),
    price: parseFloat(p.price ?? "0") || 0,
    billingFrequency: (p.recurringbillingfrequency as BillingFrequency) || "one_time",
    productType: (p.hs_product_type ?? "").trim(),
    status: (p.hs_status ?? "").trim(),
  };
}

export async function listProducts(): Promise<CatalogProduct[]> {
  const products: CatalogProductRow[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({ limit: "100", properties: PRODUCT_PROPS.join(",") });
    if (after) params.set("after", after);
    const res = await fetch(`${BASE}/crm/v3/objects/products?${params}`, { headers: billingHeaders() });
    if (!res.ok) throw hubspotErr("HubSpot product list failed", res.status, await res.text());
    const data = await res.json() as {
      results?: Array<{ id: string; properties: Record<string, string | null> }>;
      paging?: { next?: { after?: string } };
    };
    products.push(...(data.results ?? []).map(toCatalogProduct));
    after = data.paging?.next?.after;
  } while (after);

  return products
    .filter(p => p.status !== "inactive" && p.name !== "" && !EXCLUDED_PRODUCT_NAMES.includes(p.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ status: _status, ...product }) => product);
}

// ── Phase F: "Push to EasyOB" from HubSpot ──────────────────────────────────
// HubSpot deprecated classic CRM cards, so the deep link lives on a Company
// URL property (`easyob_link`, created manually in the HubSpot UI) instead of
// a card data-fetch endpoint. This keeps that property in sync: every company
// should carry `{base}/rep/prospects/new?hubspotCompanyId={id}`. Reads need
// only the general app's existing companies.read scope; writes need
// companies.write, which may not be granted yet — see backfillEasyobLinks.

export function buildEasyobLink(companyId: string, baseUrl: string): string {
  return `${baseUrl}/rep/prospects/new?hubspotCompanyId=${companyId}`;
}

export type EasyobLinkCompany = { id: string; properties: { easyob_link?: string | null } };
export type EasyobLinkUpdate = { id: string; properties: { easyob_link: string } };

// Pure: given a page of companies and the base URL, return only the companies
// whose easyob_link is missing or stale. Kept separate from the network I/O
// below so it can be unit-tested without hitting HubSpot.
export function planEasyobLinkUpdates(companies: EasyobLinkCompany[], baseUrl: string): EasyobLinkUpdate[] {
  const updates: EasyobLinkUpdate[] = [];
  for (const company of companies) {
    const expected = buildEasyobLink(company.id, baseUrl);
    const current = (company.properties.easyob_link ?? "").trim();
    if (current !== expected) {
      updates.push({ id: company.id, properties: { easyob_link: expected } });
    }
  }
  return updates;
}

export type EasyobLinkBackfillSummary = { checked: number; updated: number; failed: number; error?: string };

// HubSpot's batch/update returns 200 when every record in the chunk succeeded,
// or 207 MULTI_STATUS when some failed — `results` holds only the records that
// actually updated, `errors[].context.ids` holds the ids that didn't (with
// `numErrors` as the failed count). Fetch's Response.ok is true for BOTH 200
// and 207 (both are in the 200-299 range), so the HTTP status alone can't tell
// success from partial failure — the body must be read either way.
export type HubspotBatchUpdateResponse = {
  status?: string;
  results?: Array<{ id: string }>;
  numErrors?: number;
  errors?: Array<{ status?: string; category?: string; message?: string; context?: { ids?: string[] } }>;
};

/**
 * Pure: turns one batch/update response body into per-record success/failure
 * counts. `requestedCount` is the chunk size sent, used as the fallback for
 * "failed" so a response with neither `results` nor error info still adds up
 * rather than silently under-counting. Kept separate from the fetch so it's
 * unit-testable without HubSpot.
 */
export function countBatchUpdateOutcome(
  body: HubspotBatchUpdateResponse,
  requestedCount: number
): { updated: number; failed: number } {
  const updated = body.results?.length ?? 0;
  const failed = typeof body.numErrors === "number" ? body.numErrors : Math.max(requestedCount - updated, 0);
  return { updated, failed };
}

// Companies API and platform-wide "secondly" limits are both far above these
// counts in steady state, but a 429 does happen under load — retry a few
// times (honoring Retry-After when HubSpot sends one) rather than just
// counting the chunk/page as failed, and pace requests so we don't keep
// tripping the same limit right back.
const RETRY_AFTER_DEFAULT_MS = 1100;
const REQUEST_SPACING_MS = 150;
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, init);
    if (res.status !== 429 || attempt === MAX_ATTEMPTS) return res;
    const retryAfterSec = Number(res.headers.get("Retry-After"));
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : RETRY_AFTER_DEFAULT_MS;
    await sleep(waitMs);
  }
  return res!;
}

// Pure guard for Fix 1: a base URL that resolves to localhost/127.0.0.1, has
// no dot in its hostname, or doesn't parse at all is unusable for links other
// people will click — HubSpot's URL-property validation happens to reject
// localhost values, but we shouldn't rely on that as the only backstop.
export function isPublicBaseUrl(url: string | undefined): url is string {
  if (!url) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1") return false;
  if (!hostname.includes(".")) return false;
  return true;
}

function baseUrlErrorMessage(raw: string | undefined): string {
  const shown = raw ? `'${raw}'` : "unset";
  return `NEXT_PUBLIC_BASE_URL is ${shown} — refusing to write non-public links; set a public https URL`;
}

// Pages through every Company, then batch-PATCHes the ones missing or with a
// stale easyob_link. A 403 on the batch update means the general app's token
// doesn't have companies.write yet — that's surfaced as one clear error
// rather than a per-company failure count, since it means nothing after the
// first chunk will succeed either.
export async function backfillEasyobLinks(): Promise<EasyobLinkBackfillSummary> {
  const rawBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (!isPublicBaseUrl(rawBase)) {
    return { checked: 0, updated: 0, failed: 0, error: baseUrlErrorMessage(rawBase) };
  }
  const base = rawBase;

  const companies: EasyobLinkCompany[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({ limit: "100", properties: "easyob_link" });
    if (after) params.set("after", after);
    const res = await fetchWithRetry(`${BASE}/crm/v3/objects/companies?${params}`, { headers: headers() });
    if (!res.ok) throw hubspotErr("HubSpot company list failed", res.status, await res.text());
    const data = await res.json() as {
      results?: Array<{ id: string; properties: Record<string, string | null> }>;
      paging?: { next?: { after?: string } };
    };
    companies.push(...(data.results ?? []).map(c => ({ id: c.id, properties: { easyob_link: c.properties.easyob_link } })));
    after = data.paging?.next?.after;
    if (after) await sleep(REQUEST_SPACING_MS);
  } while (after);

  const updates = planEasyobLinkUpdates(companies, base);
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100);
    const res = await fetchWithRetry(`${BASE}/crm/v3/objects/companies/batch/update`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ inputs: chunk }),
    });
    if (res.status === 403) {
      throw new Error("companies.write scope missing on the general app — grant crm.objects.companies.write and retry");
    } else if (res.ok) {
      // 200 (all succeeded) or 207 MULTI_STATUS (partial failure) — both are
      // res.ok, so the body is the only way to tell them apart.
      const body = await res.json() as HubspotBatchUpdateResponse;
      const outcome = countBatchUpdateOutcome(body, chunk.length);
      updated += outcome.updated;
      failed += outcome.failed;
      if (outcome.failed > 0) {
        console.error("backfillEasyobLinks: batch update partial failure", outcome.failed, "of", chunk.length, body.errors);
      }
    } else {
      failed += chunk.length;
      console.error("backfillEasyobLinks: batch update failed", res.status, await res.text());
    }
    if (i + 100 < updates.length) await sleep(REQUEST_SPACING_MS);
  }

  return { checked: companies.length, updated, failed };
}

// ── Phase E: the billing quote ──────────────────────────────────────────────
// Everything below is on billingHeaders() — quotes, quote templates, line
// items, contacts and subscriptions all live on the billing app's token, which
// probed 200 for every one of these calls with zero 403s. The general token
// stays companies-read-only.
//
// Publishing a quote is a ONE-WAY DOOR: a published quote cannot be edited
// (400 LOCKED), deleted (400 PUBLISHED_QUOTE_CANNOT_BE_DELETED) or voided via
// the API. Everything here is shaped around that — see publishQuote.

// ── Line items ──────────────────────────────────────────────────────────────

// ⚠️ `hs_recurring_billing_period` IS DELIBERATELY NEVER WRITTEN. This is a
// decision by the product owner (2026-08-21), not an unfinished mapping — do
// not "complete" it by adding one.
//
// PHASE-E-SPEC.md §3.3 asks for `P7D` on weekly lines, on the strength of the
// spike. That is wrong, and the property is misnamed for what it does. Read
// live from the portal 2026-08-21: `label: "Term"`, `type: string/text`,
// `description: "Product recurring billing duration"`. It is a CONTRACT TERM
// LENGTH, not the billing cycle — the cycle is `recurringbillingfrequency`,
// which we do send. HubSpot derives
// `hs_recurring_billing_number_of_payments` from the term, so `P7D` on a
// weekly line means a ONE-PAYMENT subscription: it takes a single $99 charge
// and then silently stops collecting. `P1M` on a monthly line is the same
// defect. The spike saw exactly that derivation and filed it as O-2 with the
// default "accept it, the line publishes either way" — it publishes, and then
// stops billing.
//
// The live evidence, all read-only 2026-08-21:
//   - of 1,200 weekly line items, 935 leave the term NULL; 258 carry
//     P7D/1-payment, 4 P546D/78, 2 P21D/3
//   - of 50 monthly line items, 44 are NULL, 5 are P3M/3-payments, and
//     exactly 1 is P1M/1-payment
//   - a real AIO account shows 17 consecutive weekly $99 invoices, i.e. the
//     open-ended behaviour that a NULL term produces
//
// Omission is also the recoverable direction, which is what settles it on a
// document that cannot be amended after publish: an open-ended subscription
// can be cancelled the moment anyone notices, whereas a term that quietly
// stopped billing is discovered weeks of lost revenue later.
//
// Omitting cannot reintroduce the spike's `BILLING_PERIOD_TO_FREQUENCY_FORM_MISMATCH`
// 400 either — that came from sending a period that CONTRADICTED the frequency
// (`P12M` on a weekly line). There is no mismatch to have when nothing is sent.
//
// The frequency allowlist below stays, though: a frequency nobody has seen in
// AIO's catalog must not reach a customer-facing quote silently.

// The only three frequencies in AIO's live quotable catalog (O-9). Total on
// purpose: `satisfies Record<BillingFrequency, boolean>` makes a newly added
// BillingFrequency a COMPILE error here, forcing someone to confirm against the
// portal how it should be quoted rather than letting it through unexamined.
const QUOTABLE_FREQUENCY = {
  one_time: true,
  weekly: true,
  monthly: true,
  biweekly: false,
  quarterly: false,
  per_six_months: false,
  annually: false,
  per_two_years: false,
  per_three_years: false,
  per_four_years: false,
  per_five_years: false,
} satisfies Record<BillingFrequency, boolean>;

/**
 * Pure: one QuoteLine → the line-item property bag. Throws on any frequency
 * outside AIO's quotable catalog — an unexamined frequency on a quote that
 * cannot be edited after publish is worse than refusing to build the quote.
 *
 * Never emits `hs_recurring_billing_period`; see the note above for why that
 * is deliberate.
 */
export function toLineItemProperties(line: QuoteLine): Record<string, string> {
  if (!QUOTABLE_FREQUENCY[line.billingFrequency]) {
    throw new Error(
      `Unsupported billing frequency '${line.billingFrequency}' on line '${line.name}'. ` +
      `Only one_time, weekly and monthly appear in AIO's quotable catalog — confirm against ` +
      `the portal how this frequency should be quoted before putting it on a quote.`
    );
  }

  const props: Record<string, string> = {
    hs_product_id: line.hubspotProductId,
    quantity: String(line.qty),
    // PER BILLING CYCLE, never a monthly conversion — the platform products
    // bill weekly, so $99 here means $99/week.
    price: String(line.unitPrice),
  };
  if (line.billingFrequency !== "one_time") {
    props.recurringbillingfrequency = line.billingFrequency;
  }
  return props;
}

// ── Quote property bags ─────────────────────────────────────────────────────

export type DraftQuoteInput = {
  title: string;
  /** yyyy-MM-dd. hs_expiration_date is a date-typed property (verified live). */
  expirationDate: string;
};

/**
 * Pure: the create-time property bag for a DRAFT quote.
 *
 * `hs_sender_email` and `hs_status` are deliberately ABSENT — both belong to
 * the publish PATCH, and hs_sender_email is a publish-time requirement, not a
 * create-time one. `hs_esign_enabled` is never written at all: it is derived
 * from hs_acceptance_method and silently ignores writes. `hs_quote_auth_method`
 * is left at the portal default `public_access`, which is how AIO shares quotes
 * today (confirmed on every live quote read).
 */
export function draftQuoteProperties(input: DraftQuoteInput): Record<string, string | boolean> {
  return {
    hs_template_type: "CPQ_QUOTE",
    hs_title: input.title,
    hs_expiration_date: input.expirationDate,
    // The three that turn the quote into a checkout. hs_billing_enabled is what
    // makes HubSpot create the subscription; hs_store_payment_method_at_checkout
    // is what makes the stored ACH method reusable for the recurring charges.
    hs_billing_enabled: true,
    hs_payment_enabled: true,
    hs_store_payment_method_at_checkout: true,
    // Enum AUTO_PAYMENTS|MANUAL_PAYMENTS. NOT the subscription object's
    // `automatic_payments` spelling, which 400s here.
    hs_collection_process: "AUTO_PAYMENTS",
    // print_and_sign (the default) is incompatible with hs_payment_enabled, and
    // forcing esignature is what makes the signer association (702) mandatory.
    hs_acceptance_method: "esignature",
    // enumeration/checkbox: ACH|CREDIT_OR_DEBIT_CARD|SEPA|BACS|PADS. ACH is the
    // live value on all 46 paid quotes in the portal. Never write the sibling
    // hs_allowed_commerce_payment_methods — it is derived.
    hs_allowed_payment_methods: "ACH",
  };
}

/**
 * Pure: the publish PATCH bag, and nothing else. `hs_sender_email` is the
 * OWNING REP's address, per quote — the live portal shows a different rep on
 * every quote, never a shared mailbox. The publish 400s without it.
 */
export function publishQuoteProperties(
  senderEmail: string,
  senderFirstName?: string,
  senderLastName?: string
): Record<string, string> {
  const props: Record<string, string> = {
    hs_sender_email: senderEmail,
    hs_status: "APPROVAL_NOT_NEEDED",
  };
  if (senderFirstName) props.hs_sender_firstname = senderFirstName;
  if (senderLastName) props.hs_sender_lastname = senderLastName;
  return props;
}

// ── Line-item reconciliation ────────────────────────────────────────────────

export type LineItemReconciliation = {
  /** Existing line items to leave alone, each paired with the `nextLines` index it covers. */
  keep: Array<{ lineItemId: string; nextIndex: number }>;
  /** `nextLines` entries needing a fresh line item, in order. */
  create: Array<{ nextIndex: number; line: QuoteLine }>;
  /** Existing line-item ids no longer on the quote. Delete these. */
  delete: string[];
};

// A line item's identity for reconciliation purposes. Quantity and price are
// part of it deliberately: there is no line-item PATCH in this adapter, so a
// qty or price change is a delete-and-recreate rather than an in-place edit.
// That is only ever done while the quote is a DRAFT.
function lineItemKey(line: QuoteLine): string {
  return [line.hubspotProductId, line.qty, line.unitPrice, line.billingFrequency].join("|");
}

/**
 * Pure: what a DRAFT re-save should do to the quote's line items. Without this
 * a second save duplicates every line — which on a quote carrying a $999
 * install and a weekly platform fee is a real, invoiceable error.
 *
 * `existingIds` are the ids created from `previousLines`, in that order. A
 * SHORTER id list is the partial-create case (PHASE-E-SPEC.md §5.5): the
 * unpaired previous lines simply have nothing to keep. A LONGER one means
 * stale ids we can no longer attribute — those go straight to `delete`.
 */
export function planLineItemReconciliation(
  existingIds: string[] | null | undefined,
  previousLines: QuoteLine[] | null | undefined,
  nextLines: QuoteLine[]
): LineItemReconciliation {
  const ids = existingIds ?? [];
  const previous = previousLines ?? [];

  // key → the ids still available to be reused, oldest first. A multimap, not a
  // map: two identical lines (same product, qty and price) are legitimate and
  // must each keep their own line item.
  const available = new Map<string, string[]>();
  for (let i = 0; i < previous.length && i < ids.length; i++) {
    const key = lineItemKey(previous[i]);
    const pool = available.get(key);
    if (pool) pool.push(ids[i]);
    else available.set(key, [ids[i]]);
  }

  const keep: LineItemReconciliation["keep"] = [];
  const create: LineItemReconciliation["create"] = [];
  nextLines.forEach((line, nextIndex) => {
    const reused = available.get(lineItemKey(line))?.shift();
    if (reused) keep.push({ lineItemId: reused, nextIndex });
    else create.push({ nextIndex, line });
  });

  const kept = new Set(keep.map(k => k.lineItemId));
  return { keep, create, delete: ids.filter(id => !kept.has(id)) };
}

// ── Quote templates ─────────────────────────────────────────────────────────
// Attached by v4 association typeId 286 to object type `quote_template`
// (0-14 → 0-64, HUBSPOT_DEFINED, verified live). Which template a quote uses is
// admin-configurable rather than hardcoded: the portal carries several active
// ones ("AIO Quote v3", "Marketing Only Quote", "Hardware Addition Quote"),
// inactive predecessors, and at least one named "DON'T USE …" — so the choice
// has to be a human's, made against current names.

export type QuoteTemplate = { id: string; name: string; active: boolean; templateType: string | null };

const QUOTE_TEMPLATE_PROPS = ["hs_name", "hs_active", "hs_template_type"];

/**
 * Every quote template in the portal, INCLUDING inactive ones — the caller
 * filters. An admin whose configured template was deactivated needs to see it
 * in the list to understand why quotes stopped looking right, rather than have
 * it silently vanish.
 *
 * Note `hs_template_type` here is the template object's own enum
 * (INITIAL|CHANGE|RENEWAL) and is unrelated to the QUOTE property of the same
 * name, which is CPQ_QUOTE.
 */
export async function listQuoteTemplates(): Promise<QuoteTemplate[]> {
  const templates: QuoteTemplate[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({ limit: "100", properties: QUOTE_TEMPLATE_PROPS.join(",") });
    if (after) params.set("after", after);
    const res = await fetchWithRetry(`${BASE}/crm/v3/objects/quote_template?${params}`, {
      headers: billingHeaders(),
    });
    if (!res.ok) throw hubspotErr("HubSpot quote template list failed", res.status, await res.text());
    const data = await res.json() as {
      results?: Array<{ id: string; properties: Record<string, string | null> }>;
      paging?: { next?: { after?: string } };
    };
    for (const row of data.results ?? []) {
      templates.push({
        id: row.id,
        name: clean(row.properties.hs_name) || "(unnamed template)",
        active: row.properties.hs_active === "true",
        templateType: clean(row.properties.hs_template_type),
      });
    }
    after = data.paging?.next?.after;
    if (after) await sleep(REQUEST_SPACING_MS);
  } while (after);

  return templates.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Contact ─────────────────────────────────────────────────────────────────

export type QuoteContactInput = { firstName: string; lastName: string; email: string; phone?: string };

async function findContactIdByEmail(email: string): Promise<string | null> {
  const res = await fetchWithRetry(`${BASE}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: billingHeaders(),
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"],
      limit: 1,
    }),
  });
  if (!res.ok) throw hubspotErr(`HubSpot contact search for ${email} failed`, res.status, await res.text());
  const data = await res.json() as { results?: Array<{ id: string }> };
  return data.results?.[0]?.id ?? null;
}

/**
 * The Contact the quote associates (69) and takes as signer (702). Searched by
 * email FIRST so a merchant already in AIO's CRM is not duplicated — this
 * contact receives the e-signature request and the payment receipt, so a
 * duplicate is a real-world "why did I get two of these" problem, not just
 * untidy data.
 *
 * Also the reason the create path is retry-safe: a rerun of a failed quote
 * build finds the contact it already made instead of making a second one.
 */
export async function ensureQuoteContact(input: QuoteContactInput): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!email) {
    throw new Error(
      "ensureQuoteContact: an email is required — it is both the dedupe key and where HubSpot sends the e-signature request"
    );
  }

  const existing = await findContactIdByEmail(email);
  if (existing) return existing;

  const props: Record<string, string> = { email };
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (firstName) props.firstname = firstName;
  if (lastName) props.lastname = lastName;
  const phone = input.phone?.trim();
  if (phone) props.phone = phone;

  const res = await fetchWithRetry(`${BASE}/crm/v3/objects/contacts`, {
    method: "POST",
    headers: billingHeaders(),
    body: JSON.stringify({ properties: props }),
  });
  // 409 CONFLICT means someone else created this email between our search and
  // our POST. Re-search rather than failing the quote build — the contact we
  // wanted now exists, it just wasn't us who made it.
  if (res.status === 409) {
    const raced = await findContactIdByEmail(email);
    if (raced) return raced;
    throw hubspotErr(`HubSpot contact create for ${email} conflicted but no contact was found`, res.status, await res.text());
  }
  if (!res.ok) throw hubspotErr(`HubSpot contact create for ${email} failed`, res.status, await res.text());
  const data = await res.json() as { id: string };
  return data.id;
}

// ── Line-item network calls ─────────────────────────────────────────────────

/**
 * One line item per quote line, ids returned in input order.
 *
 * Created one at a time so the returned ids are unambiguously in input order
 * (a batch response's ordering is not contractual, and `lineItemIds` is
 * order-significant — it is what reconciliation pairs against). If a create
 * fails partway, the ones already made are deleted before throwing: a line item
 * with no quote association is invisible in the CRM, so leaving it behind
 * leaves litter nobody can find, and the caller has no id to clean up with.
 */
export async function createQuoteLineItems(lines: QuoteLine[]): Promise<string[]> {
  const created: string[] = [];
  for (const line of lines) {
    // Throws before any network call on an unsupported frequency.
    const properties = toLineItemProperties(line);
    let res: Response;
    try {
      res = await fetchWithRetry(`${BASE}/crm/v3/objects/line_items`, {
        method: "POST",
        headers: billingHeaders(),
        body: JSON.stringify({ properties }),
      });
    } catch (err) {
      await discardLineItems(created);
      throw err;
    }
    if (!res.ok) {
      const body = await res.text();
      await discardLineItems(created);
      throw hubspotErr(`HubSpot line item create failed for '${line.name}'`, res.status, body);
    }
    const data = await res.json() as { id: string };
    created.push(data.id);
  }
  return created;
}

// Best-effort cleanup of line items we created and are about to forget about.
// Never throws — it runs on a path that is already failing, and the original
// error is the one worth reporting.
async function discardLineItems(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await deleteQuoteLineItem(id);
    } catch (err) {
      console.error("createQuoteLineItems: failed to clean up orphan line item", id, err);
    }
  }
}

/** Deletes one quote-side line item. Only ever called while the quote is a DRAFT. */
export async function deleteQuoteLineItem(lineItemId: string): Promise<void> {
  const res = await fetchWithRetry(`${BASE}/crm/v3/objects/line_items/${lineItemId}`, {
    method: "DELETE",
    headers: billingHeaders(),
  });
  // Already gone is the outcome we wanted — a retry of a partly-completed
  // reconciliation must not fail on the lines it already removed.
  if (res.status === 404) return;
  if (!res.ok) throw hubspotErr(`HubSpot line item ${lineItemId} delete failed`, res.status, await res.text());
}

// ── Quote network calls ─────────────────────────────────────────────────────

const QUOTE_SNAPSHOT_PROPS = ["hs_status", "hs_quote_link", "hs_payment_status", "hs_payment_date"];

/**
 * POSTs the DRAFT quote. The slug exists at create (so the public URL is
 * predictable) but `hs_quote_link` does NOT — that only populates at publish.
 * The slug read is best-effort: it is informational, and failing the quote
 * build over it would be absurd.
 */
export async function createDraftQuote(
  props: Record<string, string | boolean>
): Promise<{ quoteId: string; slug: string | null }> {
  const res = await fetchWithRetry(`${BASE}/crm/v3/objects/quotes`, {
    method: "POST",
    headers: billingHeaders(),
    body: JSON.stringify({ properties: props }),
  });
  if (!res.ok) throw hubspotErr("HubSpot draft quote create failed", res.status, await res.text());
  const data = await res.json() as { id: string; properties?: Record<string, string | null> };

  let slug = clean(data.properties?.hs_slug);
  if (!slug) {
    try {
      const read = await fetchWithRetry(`${BASE}/crm/v3/objects/quotes/${data.id}?properties=hs_slug`, {
        headers: billingHeaders(),
      });
      if (read.ok) {
        const body = await read.json() as { properties?: Record<string, string | null> };
        slug = clean(body.properties?.hs_slug);
      }
    } catch (err) {
      console.warn("createDraftQuote: slug read-back failed", data.id, err);
    }
  }
  return { quoteId: data.id, slug: slug ?? null };
}

/**
 * PATCHes a DRAFT quote's properties. Enforces nothing itself — the caller owns
 * the "draft only" precondition. A published quote answers 400 LOCKED here, and
 * that is not something to paper over: reaching this call on a published quote
 * is a caller bug, not a recoverable state.
 */
export async function updateDraftQuote(
  quoteId: string,
  props: Record<string, string | boolean>
): Promise<void> {
  const res = await fetchWithRetry(`${BASE}/crm/v3/objects/quotes/${quoteId}`, {
    method: "PATCH",
    headers: billingHeaders(),
    body: JSON.stringify({ properties: props }),
  });
  if (!res.ok) throw hubspotErr(`HubSpot quote ${quoteId} update failed`, res.status, await res.text());
}

export type QuoteAssociation = {
  toObjectType: "deals" | "contacts" | "line_items" | "quote_template";
  toObjectId: string;
  associationTypeId: number;
};

/**
 * v4 association PUT, one per pair. Idempotent, which is what makes a
 * half-finished quote build safe to rerun: the retry re-PUTs every association
 * and the ones already present are no-ops.
 *
 * Never create deal↔quote 1393 ("Deal with Primary Quote") — HubSpot adds that
 * itself at publish.
 */
export async function associateQuote(quoteId: string, assocs: QuoteAssociation[]): Promise<void> {
  for (let i = 0; i < assocs.length; i++) {
    const assoc = assocs[i];
    const res = await fetchWithRetry(
      `${BASE}/crm/v4/objects/quotes/${quoteId}/associations/${assoc.toObjectType}/${assoc.toObjectId}`,
      {
        method: "PUT",
        headers: billingHeaders(),
        body: JSON.stringify([
          { associationCategory: "HUBSPOT_DEFINED", associationTypeId: assoc.associationTypeId },
        ]),
      }
    );
    if (!res.ok) {
      throw hubspotErr(
        `HubSpot quote ${quoteId} → ${assoc.toObjectType} ${assoc.toObjectId} (type ${assoc.associationTypeId}) association failed`,
        res.status, await res.text()
      );
    }
    if (i + 1 < assocs.length) await sleep(REQUEST_SPACING_MS);
  }
}

// HUBSPOT_DEFINED deal → contact, unlabeled (verified live: the only pair in
// the label registry for that direction).
export const DEAL_TO_CONTACT_ASSOCIATION_TYPE_ID = 3;

/**
 * Puts the quote's contact on the deal too, so a rep opening the deal sees the
 * person who signed. Best-effort by design: it is CRM tidiness, and failing the
 * quote build over it would trade a working quote for a missing sidebar row.
 */
export async function associateDealToContact(dealId: string, contactId: string): Promise<void> {
  try {
    const res = await fetchWithRetry(
      `${BASE}/crm/v4/objects/deals/${dealId}/associations/contacts/${contactId}`,
      {
        method: "PUT",
        headers: billingHeaders(),
        body: JSON.stringify([
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: DEAL_TO_CONTACT_ASSOCIATION_TYPE_ID,
          },
        ]),
      }
    );
    if (!res.ok) {
      console.warn("associateDealToContact: failed", dealId, contactId, res.status, await res.text());
    }
  } catch (err) {
    console.warn("associateDealToContact: errored", dealId, contactId, err);
  }
}

export type QuoteSnapshot = {
  quoteId: string;
  status: string | null;
  quoteLink: string | null;
  paymentStatus: string | null;
  paymentDate: string | null;
};

function toQuoteSnapshot(quoteId: string, props: Record<string, string | null> | undefined): QuoteSnapshot {
  return {
    quoteId,
    status: clean(props?.hs_status),
    quoteLink: clean(props?.hs_quote_link),
    paymentStatus: clean(props?.hs_payment_status),
    paymentDate: clean(props?.hs_payment_date),
  };
}

export async function getQuoteSnapshot(quoteId: string): Promise<QuoteSnapshot | null> {
  const res = await fetchWithRetry(
    `${BASE}/crm/v3/objects/quotes/${quoteId}?properties=${QUOTE_SNAPSHOT_PROPS.join(",")}`,
    { headers: billingHeaders() }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw hubspotErr(`HubSpot quote ${quoteId} read failed`, res.status, await res.text());
  const data = await res.json() as { properties?: Record<string, string | null> };
  return toQuoteSnapshot(quoteId, data.properties);
}

// hs_quote_link populates ~3s after the publish PATCH lands. One wait, one
// re-read, no poll loop — a loop here would turn a 3-second lag into a request
// that hangs for as long as HubSpot is slow, on the click a rep is watching.
const QUOTE_LINK_SETTLE_MS = 3000;

export type PublishedQuote = {
  quoteId: string;
  status: string;
  quoteLink: string | null;
  paymentStatus: string | null;
  /** True when HubSpot answered LOCKED, i.e. this quote was already published. */
  alreadyPublished: boolean;
};

/**
 * THE ONE-WAY DOOR. Sets hs_sender_email + hs_status: APPROVAL_NOT_NEEDED, then
 * reads hs_quote_link back once, waits ~3s and reads once more if it is still
 * empty. After this returns, the quote cannot be edited, deleted or voided
 * through the API.
 *
 * Deliberately NOT wrapped in fetchWithRetry: a retried publish is a second
 * irreversible act, and the only thing a retry could fix is a 429 — which
 * would have to be answered by re-reading state, not by pushing again.
 *
 * 400 LOCKED means ALREADY PUBLISHED, and is treated as success. That is what
 * makes a crashed publish recoverable: if HubSpot accepted the publish but the
 * DB write never landed, the rerun's PATCH gets LOCKED, falls through to the
 * read, and persists the state that was true all along. Without this rule the
 * application would be permanently stuck holding a published quote it believes
 * is a draft.
 */
export async function publishQuote(
  quoteId: string,
  sender: { email: string; firstName?: string; lastName?: string }
): Promise<PublishedQuote> {
  const props = publishQuoteProperties(sender.email, sender.firstName, sender.lastName);

  const res = await fetch(`${BASE}/crm/v3/objects/quotes/${quoteId}`, {
    method: "PATCH",
    headers: billingHeaders(),
    body: JSON.stringify({ properties: props }),
  });

  let alreadyPublished = false;
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.includes("LOCKED")) {
      alreadyPublished = true;
    } else {
      throw hubspotErr(`HubSpot quote ${quoteId} publish failed`, res.status, body);
    }
  }

  let snapshot = await getQuoteSnapshot(quoteId);
  if (!snapshot?.quoteLink) {
    await sleep(QUOTE_LINK_SETTLE_MS);
    snapshot = (await getQuoteSnapshot(quoteId)) ?? snapshot;
  }
  if (!snapshot) {
    // The PATCH succeeded (or was LOCKED) but the quote can't be read. Say so
    // plainly rather than returning a fabricated snapshot — the caller must
    // report an UNKNOWN outcome and offer a re-check, never a failure, because
    // HubSpot may well have published it.
    throw new Error(
      `HubSpot quote ${quoteId} was published but could not be read back — its state is UNKNOWN. Re-check status; do NOT publish again.`
    );
  }

  return {
    quoteId,
    // Non-null by the type. An unreadable hs_status on a quote that just
    // published is not something to silently render as an empty string.
    status: snapshot.status ?? "UNKNOWN",
    quoteLink: snapshot.quoteLink,
    paymentStatus: snapshot.paymentStatus,
    alreadyPublished,
  };
}

// ── Subscriptions ───────────────────────────────────────────────────────────
// Quote → subscription is v4 association typeId 304 (reverse 303), verified
// against 45 of the 46 paid quotes in the live portal. Keyed on the QUOTE, not
// the deal: a reused deal can carry subscriptions from earlier quotes, and
// "deal-associated, newest wins" would attach the wrong one.
const QUOTE_TO_SUBSCRIPTION_ASSOCIATION_TYPE_ID = 304;

const SUBSCRIPTION_PROPS = [
  "hs_status",
  "hs_payment_method",
  "hs_recurring_billing_frequency",
  "hs_recurring_billing_start_date",
  "hs_mrr",
  "hs_next_payment_due_date",
  "hs_last_payment_status",
  "hs_number_of_completed_payments",
  "hs_total_collected_amount",
];

function num(v: string | null | undefined): number | null {
  const t = clean(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function toSubscriptionSnapshot(
  subscriptionId: string,
  props: Record<string, string | null> | undefined
): HubspotSubscriptionSnapshot {
  return {
    subscriptionId,
    status: clean(props?.hs_status),
    paymentMethod: clean(props?.hs_payment_method),
    billingFrequency: clean(props?.hs_recurring_billing_frequency),
    billingStartDate: clean(props?.hs_recurring_billing_start_date),
    mrr: num(props?.hs_mrr),
    nextPaymentDueDate: clean(props?.hs_next_payment_due_date),
    lastPaymentStatus: clean(props?.hs_last_payment_status),
    completedPayments: num(props?.hs_number_of_completed_payments),
    totalCollected: num(props?.hs_total_collected_amount),
  };
}

/**
 * Every subscription HubSpot created from this quote's checkout. PLURAL: one
 * per distinct recurringbillingfrequency on the quote, so AIO's usual
 * weekly-platform-plus-monthly-add-on quote yields two.
 *
 * Empty is a normal, meaningful answer — the customer hasn't checked out yet,
 * or the quote carried only one-time charges and there was nothing to make a
 * subscription from.
 */
export async function findSubscriptionsForQuote(quoteId: string): Promise<HubspotSubscriptionSnapshot[]> {
  const assocRes = await fetchWithRetry(
    `${BASE}/crm/v4/objects/quotes/${quoteId}/associations/subscriptions`,
    { headers: billingHeaders() }
  );
  if (assocRes.status === 404) return [];
  if (!assocRes.ok) {
    throw hubspotErr(`HubSpot quote ${quoteId} subscription associations read failed`, assocRes.status, await assocRes.text());
  }
  const assocData = await assocRes.json() as {
    results?: Array<{ toObjectId?: number | string; associationTypes?: Array<{ typeId?: number }> }>;
  };

  // Filter on 304 rather than taking every association: it is the checkout-born
  // pair specifically, and a subscription reaching the quote by some other
  // route is not this quote's billing outcome.
  const ids = (assocData.results ?? [])
    .filter(r => (r.associationTypes ?? []).some(t => t?.typeId === QUOTE_TO_SUBSCRIPTION_ASSOCIATION_TYPE_ID))
    .map(r => clean(r.toObjectId === undefined || r.toObjectId === null ? null : String(r.toObjectId)))
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return [];

  const readRes = await fetchWithRetry(`${BASE}/crm/v3/objects/subscriptions/batch/read`, {
    method: "POST",
    headers: billingHeaders(),
    body: JSON.stringify({ properties: SUBSCRIPTION_PROPS, inputs: ids.map(id => ({ id })) }),
  });
  if (!readRes.ok) {
    throw hubspotErr(`HubSpot subscription batch read failed for quote ${quoteId}`, readRes.status, await readRes.text());
  }
  const readData = await readRes.json() as {
    results?: Array<{ id: string; properties?: Record<string, string | null> }>;
  };

  // Mapped back by id, not by position — a batch read's ordering isn't
  // contractual and the ids are the join key we already hold.
  const byId = new Map((readData.results ?? []).map(r => [r.id, r.properties]));
  return ids.map(id => toSubscriptionSnapshot(id, byId.get(id)));
}

// ── Nightly reconciliation read ─────────────────────────────────────────────

/**
 * Quotes touched since `sinceIso`, for the cron to reconcile. Search-API
 * filtered so the cron pulls only what changed rather than one GET per
 * application.
 *
 * The lookback the caller passes must be generous: a quote's flip to PAID is a
 * daily ACH settlement batch landing a median 5.7 days after the customer
 * checked out, so a short window silently misses it.
 */
export async function listQuotesModifiedSince(sinceIso: string): Promise<QuoteSnapshot[]> {
  const snapshots: QuoteSnapshot[] = [];
  let after: string | undefined;

  do {
    const res = await fetchWithRetry(`${BASE}/crm/v3/objects/quotes/search`, {
      method: "POST",
      headers: billingHeaders(),
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: sinceIso }] }],
        // Sorted so paging is stable across pages.
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
        properties: QUOTE_SNAPSHOT_PROPS,
        limit: 100,
        ...(after ? { after } : {}),
      }),
    });
    if (!res.ok) throw hubspotErr("HubSpot quote search failed", res.status, await res.text());
    const data = await res.json() as {
      results?: Array<{ id: string; properties?: Record<string, string | null> }>;
      paging?: { next?: { after?: string } };
    };
    snapshots.push(...(data.results ?? []).map(r => toQuoteSnapshot(r.id, r.properties)));
    after = data.paging?.next?.after;
    if (after) await sleep(REQUEST_SPACING_MS);
  } while (after);

  return snapshots;
}
