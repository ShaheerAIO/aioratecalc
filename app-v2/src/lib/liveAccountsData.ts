import "server-only";
import { gte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantDailyActuals } from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import {
  batchReadCompanies,
  listAllSubscriptions,
  listCompanyMeetings,
  searchCompaniesByText,
  searchCompaniesWithProperty,
  type HubspotCompanyRecord,
  type HubspotMeetingSummary,
  type HubspotSubscriptionSummary,
} from "@/lib/adapters/hubspot";
import { listAioBusinesses } from "@/lib/adapters/aioDashboard";
import {
  MIGRATED_TENANT_PROP,
  TENANT_COMPANY_OVERRIDES,
  TENANT_ID_PROP,
  buildLiveAccounts,
  classifySubscription,
  extractTenantNumber,
  isActiveSubscriptionStatus,
  tenantsNeedingNameSearch,
  type AioBusiness,
  type LiveAccountsResult,
  type TenantActivity,
} from "@/lib/liveAccounts";

// Loader for the hidden /admin/live-accounts page. READ-ONLY against every
// source: the Adyen actuals table, HubSpot and the AIO dashboard. One source
// failing becomes a warning on the page, not an error page.

const COMPANY_PROPS = ["name", "city", TENANT_ID_PROP, MIGRATED_TENANT_PROP];
const WINDOW_DAYS = 30;
const SEARCH_CONCURRENCY = 3;

export type LiveAccountsPageData = {
  result: LiveAccountsResult;
  warnings: string[];
  asOf: string;            // ISO timestamp of this load
  since: string;           // first sale_date in the window (YYYY-MM-DD)
  until: string;           // today (YYYY-MM-DD)
  adyenDataThrough: string | null; // latest sale_date in the window
};

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function loadActivity(since: string): Promise<TenantActivity[]> {
  const rows = await db
    .select({
      tenantNumber: merchantDailyActuals.tenantNumber,
      txCount: sql<number>`sum(${merchantDailyActuals.transactionCount})::int`,
      volume: sql<string>`sum(${merchantDailyActuals.grossVolume})`,
      lastTxDate: sql<string>`max(${merchantDailyActuals.saleDate})::text`,
    })
    .from(merchantDailyActuals)
    .where(gte(merchantDailyActuals.saleDate, since))
    .groupBy(merchantDailyActuals.tenantNumber);

  // Normalise "0042" / "prod-42" style ids so they meet HubSpot's on the same key.
  const byTenant = new Map<string, TenantActivity>();
  for (const r of rows) {
    const tenantId = extractTenantNumber(r.tenantNumber) ?? r.tenantNumber.trim();
    const prev = byTenant.get(tenantId);
    const lastTxDate = r.lastTxDate ?? null;
    byTenant.set(tenantId, {
      tenantId,
      txCount: (prev?.txCount ?? 0) + Number(r.txCount ?? 0),
      volume: (prev?.volume ?? 0) + Number(r.volume ?? 0),
      lastTxDate: prev?.lastTxDate && (!lastTxDate || prev.lastTxDate > lastTxDate) ? prev.lastTxDate : lastTxDate,
    });
  }
  return [...byTenant.values()];
}

export async function loadLiveAccounts(): Promise<LiveAccountsPageData> {
  // Defence in depth: admin/layout.tsx already redirects non-admins.
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");

  const now = new Date();
  const until = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const warnings: string[] = [];

  async function attempt<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // "fetch failed" alone says nothing; the network reason is on `cause`.
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
      const code = cause && "code" in cause ? ` ${String(cause.code)}` : "";
      const message = (err instanceof Error ? err.message : String(err)) + (cause ? ` (cause:${code} ${cause.message})` : "");
      console.error(`[live-accounts] ${label} failed:`, message);
      warnings.push(`${label} failed — ${message.slice(0, 300)}`);
      return fallback;
    }
  }

  const [activity, subscriptions, withTenantId, withMigratedId, aioRaw] = await Promise.all([
    attempt("Adyen activity (merchant_daily_actuals)", () => loadActivity(since), [] as TenantActivity[]),
    attempt("HubSpot subscriptions", listAllSubscriptions, [] as HubspotSubscriptionSummary[]),
    attempt("HubSpot companies with tenant_id", () => searchCompaniesWithProperty(TENANT_ID_PROP, COMPANY_PROPS), [] as HubspotCompanyRecord[]),
    attempt("HubSpot companies with migrated tenant id", () => searchCompaniesWithProperty(MIGRATED_TENANT_PROP, COMPANY_PROPS), [] as HubspotCompanyRecord[]),
    attempt("AIO dashboard business list (names only)", listAioBusinesses, [] as Awaited<ReturnType<typeof listAioBusinesses>>),
  ]);

  const aioBusinesses: AioBusiness[] = aioRaw.map(b => ({ ...b, id: String(b.id) }));

  const companies = new Map<string, HubspotCompanyRecord>();
  for (const c of [...withTenantId, ...withMigratedId]) companies.set(c.id, c);

  // Paying companies and override targets the searches didn't already return.
  const activeSubs = subscriptions.filter(s => isActiveSubscriptionStatus(s.status));
  const wanted = new Set([...activeSubs.flatMap(s => s.companyIds), ...Object.values(TENANT_COMPANY_OVERRIDES)]);
  const missing = [...wanted].filter(id => !companies.has(id));
  const extra = await attempt("HubSpot company batch read", () => batchReadCompanies(missing, COMPANY_PROPS), [] as HubspotCompanyRecord[]);
  for (const c of extra) companies.set(c.id, c);
  const companyList = [...companies.values()];

  // Name searches, only for transacting tenants no override or tenant id claims.
  const businessById = new Map(aioBusinesses.map(b => [b.id, b]));
  const unclaimed = tenantsNeedingNameSearch(activity, companyList).filter(t => businessById.has(t));
  let searchFailures = 0;
  let lastSearchError = "";
  const nameCandidates = new Map<string, HubspotCompanyRecord[]>();
  await mapPool(unclaimed, SEARCH_CONCURRENCY, async tenantId => {
    const b = businessById.get(tenantId)!;
    const queries = [...new Set([b.businessName, ...b.restaurants.map(r => r.name)].map(q => q.trim()).filter(q => q.length >= 2))].slice(0, 3);
    const hits: HubspotCompanyRecord[] = [];
    for (const q of queries) {
      try {
        hits.push(...await searchCompaniesByText(q, COMPANY_PROPS));
      } catch (err) {
        searchFailures++;
        lastSearchError = err instanceof Error ? err.message : String(err);
      }
    }
    nameCandidates.set(tenantId, hits);
  });
  if (searchFailures) warnings.push(`HubSpot name search failed ${searchFailures} time(s) — ${lastSearchError.slice(0, 300)}`);

  // Meetings, only for companies paying for marketing.
  const marketingCompanyIds = [...new Set(activeSubs.filter(s => classifySubscription(s.name) === "marketing").flatMap(s => s.companyIds))];
  const meetingsByCompany = await attempt(
    "HubSpot meetings",
    () => listCompanyMeetings(marketingCompanyIds),
    new Map<string, HubspotMeetingSummary[]>(),
  );

  const result = buildLiveAccounts({
    activity,
    companies: companyList,
    subscriptions,
    aioBusinesses,
    nameCandidates,
    meetingsByCompany,
  });

  const adyenDataThrough = activity.reduce<string | null>((max, a) => (a.lastTxDate && (!max || a.lastTxDate > max) ? a.lastTxDate : max), null);
  return { result, warnings, asOf: now.toISOString(), since, until, adyenDataThrough };
}
