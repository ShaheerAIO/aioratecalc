// Phase 3: HubSpot bidirectional sync via Private App Token
// Scopes required: crm.objects.deals.read/write, crm.objects.contacts.read/write

import type { BillingFrequency, CatalogProduct, DealStage, MerchantApplication } from "@/types/merchant";

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

export async function pullFromHubSpot(hubspotDealId: string): Promise<Partial<MerchantApplication>> {
  // Same DEAL_PROPERTIES list as the write path — it used to also ask for
  // `current_processor` and `current_monthly_fees`, which don't exist on DEAL.
  const res = await fetch(
    `${BASE}/crm/v3/objects/deals/${hubspotDealId}?properties=${DEAL_PROPERTIES.join(",")}`,
    { headers: billingHeaders() }
  );
  if (!res.ok) throw hubspotErr(`HubSpot deal ${hubspotDealId} read failed`, res.status, await res.text());
  const data = await res.json() as { properties: Record<string, string> };
  const p = data.properties;
  return {
    hubspotDealId,
    business: p.dealname ? { legalName: p.dealname, dba: p.dealname } as MerchantApplication["business"] : undefined,
  } as Partial<MerchantApplication>;
}
