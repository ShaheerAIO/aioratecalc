// Check (checkhq.com) embedded-payroll onboarding adapter.
// Same shape as the Adyen module: create the remote object once, then mint a
// fresh hosted link on every click. Check's onboard links are one-time use and
// expire after 24h, so a stored link is never re-served.
//   POST /companies              → company (persist its id)
//   POST /companies/{id}/onboard → { url }   one-time, 24h
//   GET  /companies/{id}         → { onboard: { status, ... } }
// AIO never collects a bank account or the signer's SSN — Check collects those
// on its own hosted onboarding pages, mirroring the Adyen constraint. EasyOB
// does hold the merchant's EIN since 2026-10-15 (`business.ein`, from their
// confirmation step), and it is deliberately NOT sent here: Check asks for it
// on its own pages and verifies what it is given, so handing over our copy
// would substitute an unverified value for a verified one.

import type { MerchantApplication, CheckOnboardStatus } from "@/types/merchant";

// Check documents the sandbox host explicitly; the production host is not in
// the public docs, so it's env-driven rather than guessed. Set
// CHECK_API_BASE_URL when moving off sandbox.
const SANDBOX_BASE = "https://sandbox.checkhq.com";

function baseUrl(): string {
  return process.env.CHECK_API_BASE_URL || SANDBOX_BASE;
}

export function checkEnvironment(): "sandbox" | "production" {
  return baseUrl() === SANDBOX_BASE ? "sandbox" : "production";
}

// Single fetch helper — Check auth is a bearer token on every call. Throws with
// the step label + status + body so failures are self-describing.
async function checkCall(
  path: string,
  label: string,
  body?: unknown,
  method: "GET" | "POST" = "POST"
): Promise<any> {
  const apiKey = process.env.CHECK_API_KEY;
  if (!apiKey) throw new Error("CHECK_API_KEY is required for payroll onboarding");

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    throw new Error(`Check ${label} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Maps our bizType to Check's business_type enum.
// NOTE: Check's enum has no non-profit member (it stops at government_entity),
// so non-profits fall back to c_corporation — they're almost always
// incorporated. Revisit if Check adds a dedicated value.
function checkBusinessType(bizType: string | undefined): string {
  switch (bizType) {
    case "sole-prop":   return "sole_proprietorship";
    case "partnership": return "partnership";
    case "corp":        return "c_corporation";
    case "s-corp":      return "s_corporation";
    case "non-profit":  return "c_corporation";
    case "llc":
    default:            return "llc";
  }
}

// Check uses its own industry enum — NOT an MCC or SIC code, so processing.mcc
// can't be passed through the way it can to some processors. AIO sells to
// restaurants, so `restaurant` is the correct default; these are the MCCs
// common enough in AIO's book to be worth mapping away from it.
const MCC_INDUSTRY: Record<string, string> = {
  "5812": "restaurant",                            // eating places
  "5813": "restaurant",                            // drinking places (bars, taverns)
  "5814": "restaurant",                            // fast food
  "5411": "food_and_beverage_retail_or_wholesale", // grocery stores
  "5499": "food_and_beverage_retail_or_wholesale", // specialty food / convenience
  "5921": "tobacco_or_alcohol_sales",              // package/liquor stores
  "7011": "hospitality_or_accommodation",          // lodging
};

function checkIndustryType(mcc: string | undefined): string {
  return MCC_INDUSTRY[(mcc || "").trim()] || "restaurant";
}

export type PayrollSigner = { name: string; title: string; email: string };

// Creates the Check company from the business details AIO already holds.
// startDate is the company's first payday on Check — it can't be derived from
// anything we store, so the customer supplies it on the payroll opt-in form.
export async function createCheckCompany(
  app: MerchantApplication,
  startDate: string
): Promise<string> {
  // Check requires a full URL, same normalization the Adyen adapter does for
  // webAddress — merchants routinely enter a bare domain.
  const rawWebsite = app.business?.website?.trim();
  const website = rawWebsite
    ? (/^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`)
    : undefined;

  const company = await checkCall("/companies", "company creation", {
    legal_name: app.business?.legalName || "Unknown",
    trade_name: app.business?.dba || undefined,
    business_type: checkBusinessType(app.business?.bizType),
    industry_type: checkIndustryType(app.processing?.mcc),
    email: app.ownerContact?.email,
    phone: app.business?.phone,
    address: {
      line1: app.business?.address,
      city: app.business?.city,
      state: app.business?.state,
      postal_code: app.business?.zip,
      country: "US",
    },
    start_date: startDate,
    ...(website ? { website } : {}),
  });

  return company.id;
}

// Mints a FRESH one-time onboard link for an already-created company. Check
// links expire after 24h and burn on first use, so we regenerate per visit
// rather than persisting one — the same reason the Adyen module has its own
// /continue route. The signer is who's authorized to onboard for the company.
export async function createCheckOnboardLink(
  companyId: string,
  signer: PayrollSigner
): Promise<string> {
  const link = await checkCall(`/companies/${companyId}/onboard`, "onboard link", {
    signer_name: signer.name,
    signer_title: signer.title,
    email: signer.email,
  });
  return link.url;
}

// Reads how far the company got through onboarding. Check exposes this as an
// `onboard` object on the company itself, so it's a plain company GET.
export async function getCheckOnboardStatus(companyId: string): Promise<CheckOnboardStatus | null> {
  const company = await checkCall(`/companies/${companyId}`, "company fetch", undefined, "GET");
  return company?.onboard?.status ?? null;
}
