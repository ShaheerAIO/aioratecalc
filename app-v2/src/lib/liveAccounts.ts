// Pure logic behind the hidden /admin/live-accounts page (2026-11-19). No I/O:
// lib/liveAccountsData.ts fetches, this decides. See docs/claude/live-accounts.md.
//
// "Live" (product owner, 2026-11-19):
//   ORDERING  — an active (active|past_due) platform subscription on the HubSpot
//               company AND its AIO tenant ran card transactions on Adyen in
//               the last 30 days.
//   MARKETING — an active "AIO Marketing Platform…" subscription AND a meeting
//               on the company with activity type "Marketing Discovery" and
//               outcome COMPLETED. "Discovery Meeting" is the SALES discovery
//               (pre-sale) and does not count.
//
// Tenant → company is matched on the AIO tenant id only — the company's
// `tenant_id`, or the Salesforce-migrated `migrated_00nfi00000bnezluan` when
// `tenant_id` is blank (see companyTenantNumber). An Adyen store number is a
// different number space and is never compared.

// ── Subscriptions ───────────────────────────────────────────────────────────

export type SubscriptionKind = "ordering" | "marketing" | "other";

const ORDERING_NAME = /Platform|All.in.One|Order & Pay|Pre Auth|Food Truck|Billing Migration/i;

/** Classify a subscription by its `hs_name`. Order matters: "Marketing Partial
 *  Ordering" is ordering although it says Marketing, and "Payroll … Platform"
 *  is other although it says Platform. */
export function classifySubscription(name: string | null | undefined): SubscriptionKind {
  const n = (name ?? "").trim();
  if (/Marketing Partial Ordering/i.test(n)) return "ordering";
  if (/AIO Marketing Platform/i.test(n)) return "marketing";
  if (/^Payroll/i.test(n)) return "other";
  if (ORDERING_NAME.test(n)) return "ordering";
  return "other";
}

export function isActiveSubscriptionStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "active" || s === "past_due";
}

// ── Tenant numbers ──────────────────────────────────────────────────────────

export const TENANT_ID_PROP = "tenant_id";
export const MIGRATED_TENANT_PROP = "migrated_00nfi00000bnezluan";

/** "prod-1024" | "1024" → "1024". "4 (Stage)" is a staging tenant → null. */
export function extractTenantNumber(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v || /\(\s*stage\s*\)/i.test(v)) return null;
  const m = v.match(/(\d+)\s*$/);
  if (!m) return null;
  return String(Number(m[1]));
}

/**
 * Manual tenant → HubSpot company pairings, applied before any other match.
 * Exists until the Tenant Id fixes are made in HubSpot (see the page's
 * "Suggested HubSpot fixes"); delete an entry once its company carries the
 * right tenant id. Seeded 2026-11-19, each verified by restaurant address.
 */
export const TENANT_COMPANY_OVERRIDES: Record<string, string> = {
  "4": "249636969203",
  "1924": "331507743456",
  "1956": "328817270504",
  "1816": "313722836696",
  "1222": "262073222894",
  "1255": "235045948105",
  "1719": "319162348249",
  "893": "249636970170",
  "398": "326472962808",
  "1921": "329907696374",
  "2105": "343255732971",
};

// ── Name matching (suggestions only) ────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "inc", "llc", "co", "restaurant", "cafe", "and", "of", "kitchen", "grill",
]);

export function nameTokens(name: string | null | undefined): string[] {
  const cleaned = (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ");
  return [...new Set(cleaned.split(" ").filter(t => t && !STOP_WORDS.has(t)))];
}

/** Token overlap (Dice): 2·|A∩B| / (|A|+|B|), 0..1. */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = nameTokens(a);
  const tb = new Set(nameTokens(b));
  if (ta.length === 0 || tb.size === 0) return 0;
  const shared = ta.filter(t => tb.has(t)).length;
  return (2 * shared) / (ta.length + tb.size);
}

export const NAME_MATCH_THRESHOLD = 0.6;

// ── Inputs ──────────────────────────────────────────────────────────────────

/** A HubSpot company as read — the raw property bag. Only the two tenant
 *  properties are ever used for matching. */
export type CompanyRecord = { id: string; properties: Record<string, string | null | undefined> };

export type SubscriptionRecord = {
  id: string;
  name: string | null;
  status: string | null;
  frequency: string | null;
  lastPaymentDate: string | null;
  lastPaymentStatus: string | null;
  companyIds: string[];
};

export type TenantActivity = { tenantId: string; txCount: number; volume: number; lastTxDate: string | null };

export type AioBusiness = {
  id: string;
  businessName: string;
  restaurants: { name: string; address: string | null; city: string | null }[];
};

export type MeetingRecord = {
  id: string;
  title: string | null;
  activityType: string | null;
  outcome: string | null;
  startTime: string | null;
};

export type LiveAccountsInput = {
  activity: TenantActivity[];
  companies: CompanyRecord[];
  subscriptions: SubscriptionRecord[];
  aioBusinesses: AioBusiness[];
  /** Company search hits per tenant (by AIO business/restaurant name). Every
   *  company in `companies` is also considered. */
  nameCandidates: Map<string, CompanyRecord[]>;
  meetingsByCompany: Map<string, MeetingRecord[]>;
  overrides?: Record<string, string>;
};

// ── Company helpers ─────────────────────────────────────────────────────────

const prop = (c: CompanyRecord, key: string) => {
  const v = (c.properties[key] ?? "").trim();
  return v === "" ? null : v;
};

export const companyName = (c: CompanyRecord) => prop(c, "name") ?? "(unnamed company)";

/** The raw value shown as "Tenant Id": `tenant_id`, else the migrated one. */
export function storedTenantRaw(c: CompanyRecord): string | null {
  return prop(c, TENANT_ID_PROP) ?? prop(c, MIGRATED_TENANT_PROP);
}

/**
 * The company's AIO tenant number: `tenant_id` when it holds one, else the
 * migrated property. NOT both: on 2026-11-19, 43 companies had both set and 20
 * disagreed — and in those the `tenant_id` value was the one AIO's business
 * list knows by the company's name, while the migrated value mostly matched no
 * AIO business at all (an old Salesforce-era number, often a store number).
 * Treating them as equals produced fixes like "prod-1297 → should be 1252" for
 * a company whose 1297 was right.
 */
export function companyTenantNumber(c: CompanyRecord): string | null {
  return extractTenantNumber(prop(c, TENANT_ID_PROP)) ?? extractTenantNumber(prop(c, MIGRATED_TENANT_PROP));
}

// ── Matching ────────────────────────────────────────────────────────────────

export type MatchKind = "override" | "id" | "ambiguous" | "name" | "none";

export type TenantMatch = {
  kind: MatchKind;
  companyId: string | null;          // set for override / id / name
  candidates: { id: string; name: string }[]; // ambiguous: all id matches; name: the runner-ups
  score?: number;                    // name match only
  cityMatch?: boolean;               // name match only
};

/** Pass 0 (override) and pass 1 (tenant id). `none` means try names. */
export function matchTenantById(
  tenantId: string,
  companies: CompanyRecord[],
  overrides: Record<string, string> = TENANT_COMPANY_OVERRIDES,
): TenantMatch {
  const override = overrides[tenantId];
  if (override) return { kind: "override", companyId: override, candidates: [] };
  const hits = companies.filter(c => companyTenantNumber(c) === tenantId);
  const unique = [...new Map(hits.map(c => [c.id, c])).values()];
  if (unique.length === 1) return { kind: "id", companyId: unique[0].id, candidates: [] };
  if (unique.length > 1) {
    return { kind: "ambiguous", companyId: null, candidates: unique.map(c => ({ id: c.id, name: companyName(c) })) };
  }
  return { kind: "none", companyId: null, candidates: [] };
}

/** Pass 2: best company by name, preferring one in the restaurant's city. */
export function matchTenantByName(business: AioBusiness | undefined, candidates: CompanyRecord[]): TenantMatch {
  if (!business) return { kind: "none", companyId: null, candidates: [] };
  const names = [business.businessName, ...business.restaurants.map(r => r.name)].filter(Boolean);
  const cities = new Set(business.restaurants.map(r => (r.city ?? "").trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const scored: { c: CompanyRecord; score: number; cityMatch: boolean }[] = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const score = Math.max(0, ...names.map(n => nameSimilarity(n, prop(c, "name"))));
    if (score < NAME_MATCH_THRESHOLD) continue;
    const cityMatch = cities.has((prop(c, "city") ?? "").toLowerCase());
    scored.push({ c, score, cityMatch });
  }
  if (scored.length === 0) return { kind: "none", companyId: null, candidates: [] };
  scored.sort((a, b) => Number(b.cityMatch) - Number(a.cityMatch) || b.score - a.score);
  const [best, ...rest] = scored;
  return {
    kind: "name",
    companyId: best.c.id,
    candidates: rest.slice(0, 3).map(s => ({ id: s.c.id, name: companyName(s.c) })),
    score: best.score,
    cityMatch: best.cityMatch,
  };
}

/** Tenants that transacted but neither an override nor a tenant id claims —
 *  the loader runs HubSpot name searches for exactly these. */
export function tenantsNeedingNameSearch(
  activity: TenantActivity[],
  companies: CompanyRecord[],
  overrides: Record<string, string> = TENANT_COMPANY_OVERRIDES,
): string[] {
  return activity.filter(a => matchTenantById(a.tenantId, companies, overrides).kind === "none").map(a => a.tenantId);
}

// ── Marketing discovery ─────────────────────────────────────────────────────

const isCompleted = (m: MeetingRecord) => (m.outcome ?? "").trim().toUpperCase() === "COMPLETED";
const activityIs = (m: MeetingRecord, type: string) => (m.activityType ?? "").trim().toLowerCase() === type.toLowerCase();

/** The meeting that makes a marketing account live, if any. */
export function strictMarketingDiscovery(meetings: MeetingRecord[]): MeetingRecord | null {
  return latest(meetings.filter(m => activityIs(m, "Marketing Discovery") && isCompleted(m)));
}

/** A completed SALES discovery with "marketing" in the title — not live, but
 *  probably a marketing discovery logged under the wrong type. */
export function salesTypeMarketingDiscovery(meetings: MeetingRecord[]): MeetingRecord | null {
  return latest(meetings.filter(m => activityIs(m, "Discovery Meeting") && isCompleted(m) && /marketing/i.test(m.title ?? "")));
}

function latest(ms: MeetingRecord[]): MeetingRecord | null {
  return [...ms].sort((a, b) => (b.startTime ?? "").localeCompare(a.startTime ?? ""))[0] ?? null;
}

export function describeMeeting(m: MeetingRecord): string {
  const date = m.startTime ? m.startTime.slice(0, 10) : "no date";
  return `${m.activityType ?? "(no type)"} · ${m.outcome ?? "(no outcome)"} · ${date} · ${m.title ?? "(untitled)"}`;
}

// ── Output ──────────────────────────────────────────────────────────────────

export type BucketId =
  | "live_ordering"
  | "live_marketing"
  | "transacting_not_paying"
  | "paying_no_transactions"
  | "paying_no_tenant"
  | "marketing_sales_type_discovery"
  | "marketing_no_discovery"
  | "other_only";

export const BUCKETS: { id: BucketId; title: string; description: string }[] = [
  { id: "live_ordering", title: "Live – ordering", description: "Active platform subscription and Adyen card transactions in the last 30 days." },
  { id: "live_marketing", title: "Live – marketing", description: "Active AIO Marketing Platform subscription and a completed Marketing Discovery meeting." },
  { id: "transacting_not_paying", title: "Transacting, not paying in HubSpot", description: "A tenant ran card transactions, but no company with an active platform subscription is confirmed for it (includes ambiguous and name-only matches)." },
  { id: "paying_no_transactions", title: "Paying (ordering), no Adyen transactions in 30 days", description: "Active platform subscription and a known tenant, but no card transactions in the window." },
  { id: "paying_no_tenant", title: "Paying (ordering), company has no tenant id", description: "Active platform subscription, but neither the company nor an override names its AIO tenant." },
  { id: "marketing_sales_type_discovery", title: "Marketing – discovery logged under sales type", description: "A completed \"Discovery Meeting\" (the sales type) with \"marketing\" in its title, but no Marketing Discovery." },
  { id: "marketing_no_discovery", title: "Marketing – no marketing discovery", description: "Active marketing subscription without a completed Marketing Discovery meeting." },
  { id: "other_only", title: "Other subscription only", description: "Only payroll, hardware payments or other non-platform subscriptions." },
];

export type MatchLabel = "override" | "tenant id" | "ambiguous" | "name match — suggested" | "unmatched";

export type AccountRow = {
  key: string;
  companyId: string | null;
  companyName: string | null;
  tenantIds: string[];
  aioBusinessName: string | null;
  txCount: number;
  volume: number;
  lastTxDate: string | null;
  match: MatchLabel;
  candidates: { id: string; name: string }[];
  subscriptions: string;
  discovery: string | null;
  notes: string[];
};

export type SuggestedFix = {
  companyId: string;
  companyName: string;
  tenantId: string;
  source: "override" | "id" | "name";
  text: string;
};

export type LiveAccountsResult = {
  buckets: Record<BucketId, AccountRow[]>;
  fixes: SuggestedFix[];
};

/** "Tenant Id is 2071 → should be 2033" / "Set Tenant Id = 1987". */
export function suggestedFixText(storedRaw: string | null, tenantId: string): string {
  return storedRaw ? `Tenant Id is ${storedRaw} → should be ${tenantId}` : `Set Tenant Id = ${tenantId}`;
}

function summarizeSubscriptions(subs: SubscriptionRecord[]): string {
  if (subs.length === 0) return "—";
  return subs
    .map(s => {
      const bits = [s.status, s.frequency, s.lastPaymentDate ? `last paid ${s.lastPaymentDate.slice(0, 10)}` : null]
        .filter(Boolean)
        .join(", ");
      return `${s.name ?? "(unnamed)"}${bits ? ` (${bits})` : ""}`;
    })
    .join("; ");
}

const MATCH_LABEL: Record<MatchKind, MatchLabel> = {
  override: "override",
  id: "tenant id",
  ambiguous: "ambiguous",
  name: "name match — suggested",
  none: "unmatched",
};

export function buildLiveAccounts(input: LiveAccountsInput): LiveAccountsResult {
  const overrides = input.overrides ?? TENANT_COMPANY_OVERRIDES;
  const companies = new Map(input.companies.map(c => [c.id, c]));
  const companyList = [...companies.values()];
  const businesses = new Map(input.aioBusinesses.map(b => [b.id, b]));
  const activity = new Map(input.activity.map(a => [a.tenantId, a]));

  // Active subscriptions per company.
  const subsByCompany = new Map<string, SubscriptionRecord[]>();
  for (const s of input.subscriptions) {
    if (!isActiveSubscriptionStatus(s.status)) continue;
    for (const cid of new Set(s.companyIds)) subsByCompany.set(cid, [...(subsByCompany.get(cid) ?? []), s]);
  }
  const kindsOf = (cid: string) => new Set((subsByCompany.get(cid) ?? []).map(s => classifySubscription(s.name)));

  // Match every transacting tenant.
  const matches = new Map<string, TenantMatch>();
  for (const a of input.activity) {
    let m = matchTenantById(a.tenantId, companyList, overrides);
    if (m.kind === "none") {
      const pool = [...(input.nameCandidates.get(a.tenantId) ?? []), ...companyList];
      m = matchTenantByName(businesses.get(a.tenantId), pool);
      for (const c of pool) if (!companies.has(c.id)) companies.set(c.id, c);
    }
    matches.set(a.tenantId, m);
  }

  // Confirmed (override / id) tenants per company.
  const confirmedTenants = new Map<string, string[]>();
  for (const [tenantId, m] of matches) {
    if ((m.kind === "override" || m.kind === "id") && m.companyId) {
      confirmedTenants.set(m.companyId, [...(confirmedTenants.get(m.companyId) ?? []), tenantId]);
    }
  }
  // Overrides also confirm a company's tenant when that tenant didn't transact.
  for (const [tenantId, cid] of Object.entries(overrides)) {
    if (!activity.has(tenantId)) confirmedTenants.set(cid, [...(confirmedTenants.get(cid) ?? []), tenantId]);
  }

  const buckets = Object.fromEntries(BUCKETS.map(b => [b.id, [] as AccountRow[]])) as Record<BucketId, AccountRow[]>;
  const fixes: SuggestedFix[] = [];

  const sumActivity = (tenantIds: string[]) => {
    let txCount = 0, volume = 0, lastTxDate: string | null = null;
    for (const t of tenantIds) {
      const a = activity.get(t);
      if (!a) continue;
      txCount += a.txCount;
      volume += a.volume;
      if (a.lastTxDate && (!lastTxDate || a.lastTxDate > lastTxDate)) lastTxDate = a.lastTxDate;
    }
    return { txCount, volume, lastTxDate };
  };
  const businessNameFor = (tenantIds: string[]) =>
    tenantIds.map(t => businesses.get(t)?.businessName).filter(Boolean).join(", ") || null;

  // ── Company rows (every company with an active subscription) ──
  for (const [cid, subs] of subsByCompany) {
    const company = companies.get(cid);
    const kinds = kindsOf(cid);
    const confirmed = confirmedTenants.get(cid) ?? [];
    const storedNumber = company ? companyTenantNumber(company) : null;
    const stored = storedNumber ? [storedNumber] : [];
    // Stored ids not taken by an override pointing elsewhere.
    const storedOwn = stored.filter(t => !overrides[t] || overrides[t] === cid);
    const tenantIds = [...new Set([...confirmed, ...storedOwn])];
    const transacting = confirmed.filter(t => (activity.get(t)?.txCount ?? 0) > 0);
    const act = sumActivity(transacting);
    const notes: string[] = [];
    for (const t of stored) {
      if (overrides[t] && overrides[t] !== cid) notes.push(`Tenant ${t} is assigned to company ${overrides[t]} by override`);
      const m = matches.get(t);
      if (m?.kind === "ambiguous") notes.push(`Tenant ${t} is also claimed by ${m.candidates.filter(c => c.id !== cid).map(c => c.name).join(", ")}`);
    }
    for (const [t, m] of matches) {
      if (m.kind === "name" && m.companyId === cid) notes.push(`Possible tenant ${t} (name match — suggested)`);
    }
    const base: Omit<AccountRow, "key" | "discovery"> = {
      companyId: cid,
      companyName: company ? companyName(company) : `Company ${cid}`,
      tenantIds,
      aioBusinessName: businessNameFor(tenantIds),
      ...act,
      match: confirmed.some(t => overrides[t] === cid) ? "override" : tenantIds.length ? "tenant id" : "unmatched",
      candidates: [],
      subscriptions: summarizeSubscriptions(subs),
      notes,
    };

    if (kinds.has("ordering")) {
      const bucket: BucketId = transacting.length
        ? "live_ordering"
        : tenantIds.length
          ? "paying_no_transactions"
          : "paying_no_tenant";
      buckets[bucket].push({ ...base, key: `${bucket}:${cid}`, discovery: null });
    }
    if (kinds.has("marketing")) {
      const meetings = input.meetingsByCompany.get(cid) ?? [];
      const strict = strictMarketingDiscovery(meetings);
      const salesType = strict ? null : salesTypeMarketingDiscovery(meetings);
      const bucket: BucketId = strict ? "live_marketing" : salesType ? "marketing_sales_type_discovery" : "marketing_no_discovery";
      const evidence = strict ?? salesType;
      buckets[bucket].push({
        ...base,
        key: `${bucket}:${cid}`,
        discovery: evidence ? describeMeeting(evidence) : meetings.length ? `${meetings.length} meeting(s), none a completed Marketing Discovery` : "No meetings",
      });
    }
    if (!kinds.has("ordering") && !kinds.has("marketing")) {
      buckets.other_only.push({ ...base, key: `other_only:${cid}`, discovery: null });
    }
  }

  // ── Transacting tenants with no paying platform company ──
  for (const a of input.activity) {
    if (a.txCount <= 0) continue;
    const m = matches.get(a.tenantId)!;
    const confirmedCompany = (m.kind === "override" || m.kind === "id") ? m.companyId : null;
    if (confirmedCompany && kindsOf(confirmedCompany).has("ordering")) continue;
    const company = m.companyId ? companies.get(m.companyId) : undefined;
    const notes: string[] = [];
    if (confirmedCompany) {
      const kinds = [...kindsOf(confirmedCompany)];
      notes.push(kinds.length ? `Company has no active platform subscription (has: ${kinds.join(", ")})` : "Company has no active subscription");
    }
    if (m.kind === "name") notes.push(`Name score ${m.score!.toFixed(2)}${m.cityMatch ? ", same city" : ""} — verify before using`);
    buckets.transacting_not_paying.push({
      key: `transacting_not_paying:${a.tenantId}`,
      companyId: m.companyId,
      companyName: m.companyId ? (company ? companyName(company) : `Company ${m.companyId}`) : null,
      tenantIds: [a.tenantId],
      aioBusinessName: businesses.get(a.tenantId)?.businessName ?? null,
      txCount: a.txCount,
      volume: a.volume,
      lastTxDate: a.lastTxDate,
      match: MATCH_LABEL[m.kind],
      candidates: m.candidates,
      subscriptions: m.companyId ? summarizeSubscriptions(subsByCompany.get(m.companyId) ?? []) : "—",
      discovery: null,
      notes,
    });
  }

  // ── Suggested HubSpot fixes ──
  for (const [cid, tenantIds] of confirmedTenants) {
    const company = companies.get(cid);
    if (!company) continue;
    const primary = companyTenantNumber(company);
    if (primary && tenantIds.includes(primary)) continue;
    const tenantId = [...tenantIds].sort((x, y) => (activity.get(y)?.txCount ?? 0) - (activity.get(x)?.txCount ?? 0))[0];
    const source = tenantIds.some(t => overrides[t] === cid) ? "override" : "id";
    fixes.push({ companyId: cid, companyName: companyName(company), tenantId, source, text: suggestedFixText(storedTenantRaw(company), tenantId) });
  }
  for (const [tenantId, m] of matches) {
    if (m.kind !== "name" || !m.companyId || confirmedTenants.has(m.companyId)) continue;
    const company = companies.get(m.companyId);
    if (!company) continue;
    fixes.push({
      companyId: m.companyId,
      companyName: companyName(company),
      tenantId,
      source: "name",
      text: `${suggestedFixText(storedTenantRaw(company), tenantId)} (name match — verify first)`,
    });
  }

  for (const rows of Object.values(buckets)) rows.sort((a, b) => b.volume - a.volume || (a.companyName ?? "").localeCompare(b.companyName ?? ""));
  return { buckets, fixes };
}
