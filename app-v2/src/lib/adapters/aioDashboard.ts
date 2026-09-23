// AIO dashboard (backend.internal.dev.aioapp.com) provisioning adapter.
//
// WHY THIS EXISTS. EasyOB used to create its own Adyen Balance Platform graph
// — legal entity, account holder, business line, balance account, onboarding
// link. That produced accounts that were misnamed and unlinked from the AIO
// platform, because EasyOB has no knowledge of AIO's tenant graph. Since
// 2026-09-23 this adapter is the ONLY way EasyOB obtains an Adyen account:
// AIO's own platform creates the tenant and mints a KYC link already wired to
// it.
//
//   POST /api/business/create           → { id: businessId, companyId }
//   POST /api/restaurant/post/create    → { id: locationId, workplaceId }
//   POST /api/restaurant/adyen-onboard  → { url, newOnboarding }
//   GET  /api/business/business-list?businessAlias=…  → reconciliation read
//
// EVERYTHING HERE IS IRREVERSIBLE ON AIO'S SIDE. A business alias is globally
// unique, delete is soft and never frees the alias, and the database is shared
// with other AIO teams. A duplicate create is permanent debris. That is why
// the alias is deterministic, why findAioBusinessByAlias exists, and why the
// two retries below are narrowly predicated instead of blanket.
//
// AIO never collects EIN, bank account, or SSN through this path — Adyen
// collects those on its own hosted onboarding page, same rule as check.ts.
//
// Contract facts below were verified live against internal dev on 2026-09-23;
// see app-v2/AIO-DASHBOARD-API-TRANSCRIPT.md for the raw session.

import type { MerchantApplication, OwnerContact } from "@/types/merchant";
import { toE164Phone } from "@/lib/utils";

/** AIO wants a single name field; OwnerContact is split. */
function contactName(c: OwnerContact | null | undefined): string {
  return [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();
}

/** The point-of-contact block, identical in shape for business and location.
 *  roleId 4 = Owner (GET /api/roles/list). */
function pocInfo(app: MerchantApplication) {
  return [
    {
      name: contactName(app.ownerContact),
      contactNo: toE164Phone(app.ownerContact?.phone) ?? "",
      roleId: 4,
      email: app.ownerContact?.email ?? "",
    },
  ];
}

// No default base URL, deliberately unlike check.ts's SANDBOX_BASE. The only
// plausible default is the internal-dev host, which is exactly what a
// production deployment must never reach by accident. Unset ⇒ disabled.
function baseUrl(): string {
  const base = process.env.AIO_DASHBOARD_BASE_URL;
  if (!base) throw new Error("AIO_DASHBOARD_BASE_URL is required for AIO tenant provisioning");
  return base.replace(/\/$/, "");
}

/** Which AIO deployment holds the tenant. Recorded on AioTenantIds so a row
 *  provisioned against internal dev is never mistaken for a production one. */
export function aioEnvironment(): string {
  try {
    return new URL(baseUrl()).hostname.split(".")[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** All four core vars, so a half-configured environment is OFF rather than
 *  half-broken. The master switch is separate and must be exactly "true". */
export function aioDashboardEnabled(): boolean {
  return (
    process.env.AIO_DASHBOARD_ENABLED === "true" &&
    Boolean(process.env.AIO_DASHBOARD_BASE_URL) &&
    Boolean(process.env.AIO_DASHBOARD_USERNAME) &&
    Boolean(process.env.AIO_DASHBOARD_PASSWORD)
  );
}

// ── Session ─────────────────────────────────────────────────────────────────
// Auth is TWO headers, not one: Authorization carries the Cognito AccessToken
// AND x-id-token carries the IdToken. Bearer alone returns "Invalid access
// token provided" on most routes, which points at the wrong token entirely.

type AioSession = { accessToken: string; idToken: string; expiresAt: number };

let cached: AioSession | null = null;
// Collapses the thundering herd when the provisioning cron processes N rows on
// a cold instance — otherwise every row races its own login.
let inFlight: Promise<AioSession> | null = null;

/** Test seam: drop the cached session. */
export function __resetAioSession(): void {
  cached = null;
  inFlight = null;
}

// A STABLE browser id. Cognito treats it as a device, so generating one per
// invocation would accumulate a device per call.
const DEFAULT_BROWSER_ID = "ad267d0e-52d1-4da2-a351-ec52be592fbc";

async function login(): Promise<AioSession> {
  const username = process.env.AIO_DASHBOARD_USERNAME;
  const password = process.env.AIO_DASHBOARD_PASSWORD;
  if (!username || !password) {
    throw new Error("AIO_DASHBOARD_USERNAME and AIO_DASHBOARD_PASSWORD are required");
  }

  // Content-Type matters here: without it the body is parsed as form-encoded
  // and every field reads empty ("username should not be empty").
  const res = await fetch(`${baseUrl()}/api/authentication/user-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-name": "dashboard" },
    body: JSON.stringify({
      username,
      password,
      rememberMe: false,
      browserId: process.env.AIO_DASHBOARD_BROWSER_ID || DEFAULT_BROWSER_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(`AIO dashboard login failed (${res.status}): ${await res.text()}`);
  }
  const json: any = await res.json();
  const auth = json?.data?.authChallengeResponse?.AuthenticationResult;
  const accessToken = auth?.AccessToken;
  const idToken = auth?.IdToken;
  if (!accessToken || !idToken) {
    throw new Error(`AIO dashboard login returned no tokens: ${JSON.stringify(json?.message ?? json)}`);
  }
  // Five-minute safety margin so a token can't expire midway through the
  // three-step provisioning chain.
  const ttl = Number(auth?.ExpiresIn ?? 86400);
  return { accessToken, idToken, expiresAt: Date.now() + Math.max(ttl - 300, 60) * 1000 };
}

async function session(): Promise<AioSession> {
  if (cached && cached.expiresAt > Date.now()) return cached;
  if (!inFlight) {
    inFlight = login()
      .then(s => {
        cached = s;
        return s;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// ── Transport ───────────────────────────────────────────────────────────────

type CallOpts = { method?: "GET" | "POST"; tenantId?: number; retryOn401?: boolean };

async function aioCall(path: string, label: string, body?: unknown, opts: CallOpts = {}): Promise<any> {
  const { method = "POST", tenantId, retryOn401 = true } = opts;
  const s = await session();

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${s.accessToken}`,
      "x-id-token": s.idToken,
      "x-app-name": "dashboard",
      "Content-Type": "application/json",
      ...(tenantId === undefined ? {} : { "x-tenant-id": String(tenantId) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  // One re-login on 401 (rotated keys / revoked token), then give up. Never a
  // loop: the retry is disabled on the second attempt.
  if (res.status === 401 && retryOn401) {
    cached = null;
    return aioCall(path, label, body, { ...opts, retryOn401: false });
  }
  if (!res.ok) {
    throw new Error(`AIO dashboard ${label} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Responses come back in two envelope shapes depending on the route:
//   { success, data, message }              and
//   { statusCode, response: { success, data, message } }
function unwrap(json: any): { success: boolean; data: any; message: string } {
  const env = json?.response ?? json;
  return { success: Boolean(env?.success), data: env?.data, message: String(env?.message ?? "") };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Pure helpers (exported for tests and for the provisioner) ───────────────

/** DETERMINISTIC, and that is the point. An alias is permanently burned on
 *  create, so a random suffix would mean a retry mints a second tenant. A
 *  deterministic one collides, which tells the provisioner to reconcile. */
export function aioBusinessAlias(app: Pick<MerchantApplication, "id">): string {
  return `easyob_${app.id}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60);
}

/** The ONLY way to obtain the Adyen legal entity id today: AIO's response
 *  carries an empty accountDetails and restaurant.accountId stays null, so the
 *  id is read out of the onboarding URL path. Returns null rather than
 *  throwing — the link still works without it, only our cross-reference is
 *  degraded. */
export function legalEntityIdFromOnboardingUrl(url: string): string | null {
  return /\/legalEntities\/(LE[A-Za-z0-9]+)/.exec(url)?.[1] ?? null;
}

/** Derived from the URL host rather than an env var, so it describes where the
 *  objects actually are instead of what we think we configured. */
export function adyenEnvironmentFromOnboardingUrl(url: string): "test" | "live" {
  return /onboarding-test\.adyen\.com/.test(url) ? "test" : "live";
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** Reconciliation read — the third idempotency layer. Verified to return a
 *  soft-deleted tenant too, which is exactly what we need: the alias is still
 *  burned, so "not found" genuinely means "safe to create".
 *  NB: /api/business/business-list is the authoritative list. /api/business/list
 *  is a FILTERED view that omits freshly created tenants — don't use it here. */
export async function findAioBusinessByAlias(alias: string): Promise<{
  businessId: number | null;
  businessName: string | null;
  restaurants: { id: number; name: string }[];
} | null> {
  const json = await aioCall(
    `/api/business/business-list?businessAlias=${encodeURIComponent(alias)}`,
    "business lookup by alias",
    undefined,
    { method: "GET" }
  );
  const { data } = unwrap(json);
  if (!data || Array.isArray(data)) return null;
  return {
    // This endpoint returns name/alias/restaurants but NOT the id, so a caller
    // that needs the id must have persisted it. Null here means "exists, but
    // we can't learn its id from this route" — see the provisioner.
    businessId: typeof data.id === "number" ? data.id : null,
    businessName: data.businessName ?? null,
    restaurants: Array.isArray(data.restaurants)
      ? data.restaurants.map((r: any) => ({ id: r.id, name: r.name }))
      : [],
  };
}

// ── Step 1: the tenant ("business") ─────────────────────────────────────────

/** businessName is ALSO globally unique — AIO answers "Business name already
 *  exists". Getting the name right is the entire point of this change, so the
 *  real name is always attempted first and only then disambiguated. */
export async function createAioBusiness(
  app: MerchantApplication,
  opts: { alias: string }
): Promise<{ businessId: number; companyId: string | null; businessName: string }> {
  const biz = app.business;
  if (!biz) throw new Error("AIO dashboard business create requires app.business");

  const preferred = (biz.dba || biz.legalName || "").trim();
  if (!preferred) throw new Error("AIO dashboard business create requires a business name");

  const attempt = async (businessName: string) => {
    const json = await aioCall("/api/business/create", "business create", {
      businessInfo: {
        businessName,
        contactNo: toE164Phone(biz.phone) ?? "",
        address: biz.address ?? "",
        state: biz.state ?? "",
        city: biz.city ?? "",
        zipCode: biz.zip ?? "",
        stateIso: biz.state ?? "",
        logo: null,
        businessSince: new Date().toISOString(),
        // Only value observed in the wild; see open question about the enum.
        businessType: "sole_proprietorship",
        ownerInfo: {
          ownerName: contactName(app.ownerContact),
          ownerEmail: app.ownerContact?.email ?? "",
          ownerContactNo: toE164Phone(app.ownerContact?.phone) ?? "",
        },
        businessAlias: opts.alias,
      },
      pocInfo: pocInfo(app),
    });
    const { data } = unwrap(json);
    const businessId = Number(data?.id);
    if (!Number.isFinite(businessId)) {
      throw new Error(`AIO dashboard business create returned no id: ${JSON.stringify(data)}`);
    }
    return { businessId, companyId: data?.companyId ?? null, businessName };
  };

  try {
    return await attempt(preferred);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/business name already exists/i.test(msg)) throw err;
    // Two genuinely different merchants can trade under one name.
    const shortId = app.id.slice(-6);
    return attempt(`${preferred} (EasyOB ${shortId})`);
  }
}

// ── Step 2: the location ("restaurant") ─────────────────────────────────────

// Known AIO bug, verified 2026-09-23: the FIRST call 500s because the
// per-tenant Postgres schema isn't provisioned yet. The second succeeds.
// The quotes arrive BACKSLASH-ESCAPED: the body is JSON, so res.text() yields
//   {"message":"...relation \"tenant_5217.state\" does not exist"}
// Matching a bare quote here would never fire in production.
const TENANT_SCHEMA_NOT_READY = /relation\s+\\?"tenant_\d+\.[a-z_]+\\?"\s+does not exist/i;

export async function createAioLocation(
  app: MerchantApplication,
  args: { businessId: number; companyId: string | null }
): Promise<{ locationId: number; workplaceId: string | null }> {
  const biz = app.business;
  if (!biz) throw new Error("AIO dashboard location create requires app.business");

  const body = {
    businessId: args.businessId,
    companyId: args.companyId,
    restaurant: {
      businessId: args.businessId,
      name: (biz.dba || biz.legalName || "").trim(),
      address: biz.address ?? "",
      image: "",
      orderDelayedTime: 0,
      onlineOrder: false,
      restaurantModes: "quickServe",
      onlineOrderTimer: "16:00:00",
      // AIO's form geocodes; we don't hold coordinates, and 0/0 would place
      // every merchant in the Gulf of Guinea. Left null so a wrong point is
      // never asserted — see the open question about required fields.
      latitude: null,
      longitude: null,
      phoneNo: toE164Phone(biz.phone) ?? "",
      otherMode: "",
      building: "",
      state: biz.state ?? "",
      city: biz.city ?? "",
      zipCode: biz.zip ?? "",
      status: "closed",
      autoGratuity: false,
      largePartySizeLimit: 1,
      cuisineType: "",
      timezone: "America/Los_Angeles",
      stateIso: biz.state ?? "",
      workplaceId: "",
    },
    pocInfo: pocInfo(app),
    pocEmployees: [],
  };

  // Retries EXACTLY ONCE, and only for the known schema-not-ready 500. A
  // blanket retry-all-500s is unacceptable: there is no idempotency key, so a
  // transient 500 that actually succeeded server-side would leave two
  // Locations and neither can be deleted.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await aioCall("/api/restaurant/post/create", "location create", body);
      const { data } = unwrap(json);
      const locationId = Number(data?.id);
      if (!Number.isFinite(locationId)) {
        throw new Error(`AIO dashboard location create returned no id: ${JSON.stringify(data)}`);
      }
      return { locationId, workplaceId: data?.workplaceId ?? null };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!TENANT_SCHEMA_NOT_READY.test(msg)) throw err;
      await sleep(2000);
    }
  }
  throw lastErr;
}

// ── Step 3: the Adyen KYC link ──────────────────────────────────────────────

// Known AIO bug, verified 2026-09-23: the first call returns HTTP 201 with
// success:true, newOnboarding:true and url:"". The SECOND returns the real
// URL. So success is the PAYLOAD, never the status code — a status-only client
// hands the merchant a blank link. newOnboarding is diagnostics only; reading
// it as "created, fine" is precisely the trap.
const LINK_ATTEMPTS = 3;

export async function createAioAdyenOnboardingLink(args: {
  businessId: number;
  locationId: number;
}): Promise<{ url: string; legalEntityId: string | null; newOnboarding: boolean }> {
  let newOnboarding = false;

  for (let attempt = 0; attempt < LINK_ATTEMPTS; attempt++) {
    const json = await aioCall(
      "/api/restaurant/adyen-onboard",
      "adyen onboarding link",
      { restaurantId: args.locationId },
      // Verified NOT enforced (another tenant's id still returned our link),
      // but sent anyway — it is the documented contract.
      { tenantId: args.businessId }
    );
    const { data } = unwrap(json);
    newOnboarding = Boolean(data?.newOnboarding);
    const url = String(data?.url ?? "").trim();
    if (/^https?:\/\//.test(url)) {
      return {
        url,
        legalEntityId: legalEntityIdFromOnboardingUrl(url),
        newOnboarding,
      };
    }
    if (attempt < LINK_ATTEMPTS - 1) await sleep(1500);
  }

  // Never return an empty string, and never swallow this — surviving three
  // tries is a real outage, not the known first-call quirk.
  throw new Error(
    `AIO dashboard adyen onboarding link returned an empty url after ${LINK_ATTEMPTS} attempts ` +
      `(businessId=${args.businessId}, restaurantId=${args.locationId})`
  );
}
