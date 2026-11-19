import { describe, expect, it } from "vitest";
import {
  TENANT_COMPANY_OVERRIDES,
  buildLiveAccounts,
  classifySubscription,
  extractTenantNumber,
  matchTenantById,
  matchTenantByName,
  nameSimilarity,
  marketingDiscovery,
  suggestedFixText,
  tenantsNeedingNameSearch,
  type AioBusiness,
  type CompanyRecord,
  type LiveAccountsInput,
  type MeetingRecord,
  type SubscriptionRecord,
  type TenantActivity,
} from "@/lib/liveAccounts";

const company = (id: string, name: string, props: Record<string, string | null> = {}): CompanyRecord => ({
  id,
  properties: { name, ...props },
});

let subSeq = 0;
const sub = (companyId: string, name: string, status = "active"): SubscriptionRecord => ({
  id: `s${++subSeq}`,
  name,
  status,
  frequency: "monthly",
  lastPaymentDate: null,
  lastPaymentStatus: null,
  companyIds: [companyId],
});

const act = (tenantId: string, txCount: number, volume = txCount * 10): TenantActivity => ({
  tenantId,
  txCount,
  volume,
  lastTxDate: "2026-11-16",
});

const meeting = (activityType: string, outcome: string, title = "Call"): MeetingRecord => ({
  id: `${activityType}-${outcome}-${title}`,
  title,
  activityType,
  outcome,
  startTime: "2026-10-01T15:00:00Z",
});

const business = (id: string, businessName: string, restaurants: { name: string; city?: string }[] = []): AioBusiness => ({
  id,
  businessName,
  restaurants: restaurants.map(r => ({ name: r.name, address: null, city: r.city ?? null })),
});

function input(partial: Partial<LiveAccountsInput>): LiveAccountsInput {
  return {
    activity: [],
    companies: [],
    subscriptions: [],
    aioBusinesses: [],
    nameCandidates: new Map(),
    meetingsByCompany: new Map(),
    overrides: {},
    ...partial,
  };
}

describe("classifySubscription", () => {
  it.each([
    ["AIO Platform - Monthly", "ordering"],
    ["All-in-One Bundle", "ordering"],
    ["Order & Pay", "ordering"],
    ["Pre Auth Platform", "ordering"],
    ["Food Truck Plan", "ordering"],
    ["Billing Migration", "ordering"],
    ["Marketing Partial Ordering", "ordering"],
    ["AIO Marketing Platform - Growth", "marketing"],
    ["Payroll - AIO Platform (Per Person)", "other"],
    ["Monthly Hardware Payment", "other"],
    ["AIO App Investor", "other"],
    [null, "other"],
  ])("%s → %s", (name, kind) => {
    expect(classifySubscription(name)).toBe(kind);
  });
});

describe("extractTenantNumber", () => {
  it("reads prod-1024, 1024 and padded values", () => {
    expect(extractTenantNumber("prod-1024")).toBe("1024");
    expect(extractTenantNumber("1024")).toBe("1024");
    expect(extractTenantNumber(" 0042 ")).toBe("42");
  });
  it("ignores stage tenants and blanks", () => {
    expect(extractTenantNumber("4 (Stage)")).toBeNull();
    expect(extractTenantNumber("4 (stage)")).toBeNull();
    expect(extractTenantNumber("")).toBeNull();
    expect(extractTenantNumber(null)).toBeNull();
    expect(extractTenantNumber("n/a")).toBeNull();
  });
});

describe("matching", () => {
  it("an override wins over a tenant-id match", () => {
    const companies = [company("A", "Alpha", { tenant_id: "prod-10" })];
    expect(matchTenantById("10", companies, { "10": "B" })).toMatchObject({ kind: "override", companyId: "B" });
  });

  it("matches on tenant_id or the migrated property", () => {
    const companies = [
      company("A", "Alpha", { tenant_id: "prod-10" }),
      company("B", "Beta", { migrated_00nfi00000bnezluan: "20" }),
    ];
    expect(matchTenantById("10", companies, {})).toMatchObject({ kind: "id", companyId: "A" });
    expect(matchTenantById("20", companies, {})).toMatchObject({ kind: "id", companyId: "B" });
  });

  it("tenant_id wins over the migrated property; the migrated one is only a fallback", () => {
    const companies = [company("A", "Alpha", { tenant_id: "prod-1297", migrated_00nfi00000bnezluan: "1252" })];
    expect(matchTenantById("1297", companies, {})).toMatchObject({ kind: "id", companyId: "A" });
    expect(matchTenantById("1252", companies, {}).kind).toBe("none");
    const stage = [company("B", "Beta", { tenant_id: "4 (Stage)", migrated_00nfi00000bnezluan: "9" })];
    expect(matchTenantById("9", stage, {})).toMatchObject({ kind: "id", companyId: "B" });
  });

  it("two companies with the same tenant id are ambiguous", () => {
    const companies = [company("A", "Alpha", { tenant_id: "10" }), company("B", "Beta", { migrated_00nfi00000bnezluan: "prod-10" })];
    const m = matchTenantById("10", companies, {});
    expect(m.kind).toBe("ambiguous");
    expect(m.candidates.map(c => c.id)).toEqual(["A", "B"]);
  });

  it("never matches on Adyen store numbers or other numeric properties", () => {
    const companies = [company("A", "Store 1500", { mid: "1500", store_number: "1500", adyen_store_reference: "1500" })];
    expect(matchTenantById("1500", companies, {}).kind).toBe("none");
  });

  it("a stage tenant id never matches", () => {
    expect(matchTenantById("4", [company("A", "Alpha", { tenant_id: "4 (Stage)" })], {}).kind).toBe("none");
  });

  it("an id match beats a better name match", () => {
    const companies = [company("A", "Something Else", { tenant_id: "10" }), company("B", "Lajevard Eats")];
    const r = buildLiveAccounts(input({
      activity: [act("10", 5)],
      companies,
      aioBusinesses: [business("10", "Lajevard Eats")],
      subscriptions: [sub("A", "AIO Platform"), sub("B", "AIO Platform")],
    }));
    expect(r.buckets.live_ordering.map(x => x.companyId)).toEqual(["A"]);
    expect(r.buckets.paying_no_tenant.map(x => x.companyId)).toEqual(["B"]);
  });

  it("name similarity strips accents, punctuation and filler words", () => {
    expect(nameSimilarity("Café Olé Kitchen, LLC", "cafe ole")).toBe(1);
    expect(nameSimilarity("The Taco Spot", "Taco Spot Grill")).toBe(1);
    expect(nameSimilarity("Joe's Pizza", "Pizza Palace")).toBeLessThan(0.6);
  });

  it("name match prefers the company in the restaurant's city", () => {
    const b = business("10", "Taco Spot", [{ name: "Taco Spot", city: "Austin" }]);
    const m = matchTenantByName(b, [
      company("X", "Taco Spot", { city: "Dallas" }),
      company("Y", "Taco Spot", { city: "Austin" }),
    ]);
    expect(m).toMatchObject({ kind: "name", companyId: "Y", cityMatch: true });
    expect(m.candidates.map(c => c.id)).toEqual(["X"]);
  });

  it("only unclaimed tenants need a name search", () => {
    const companies = [company("A", "Alpha", { tenant_id: "10" })];
    expect(tenantsNeedingNameSearch([act("10", 1), act("11", 1), act("12", 1)], companies, { "12": "Z" })).toEqual(["11"]);
  });

  it("ships the verified overrides", () => {
    expect(TENANT_COMPANY_OVERRIDES["4"]).toBe("249636969203");
    expect(TENANT_COMPANY_OVERRIDES["2105"]).toBe("343255732971");
    expect(Object.keys(TENANT_COMPANY_OVERRIDES)).toHaveLength(11);
  });
});

describe("marketing discovery", () => {
  const live = (type: string, outcome: string, title?: string) => marketingDiscovery([meeting(type, outcome, title)]) !== null;

  it("counts a completed Marketing Discovery or Marketing Catchup, whatever the title", () => {
    expect(live("Marketing Discovery", "COMPLETED")).toBe(true);
    expect(live("Marketing Catchup", "COMPLETED", "(no title)")).toBe(true);
    expect(live("Marketing Discovery", "SCHEDULED")).toBe(false);
    expect(live("Marketing Catchup", "NO_SHOW")).toBe(false);
  });

  it("counts completed untyped marketing sessions by title (real titles from HubSpot)", () => {
    expect(live("", "COMPLETED", "AIO Marketing Onboarding | Entre Comales")).toBe(true);
    expect(live("", "COMPLETED", "Marketing Meeting - El Paladar")).toBe(true);
    expect(live("", "COMPLETED", "BrandBook Review Meeting - Pop Haus")).toBe(true);
    expect(live("", "COMPLETED", "Pop Haus - Marketing Catchup")).toBe(true);
    expect(live("", "SCHEDULED", "AIO Marketing Onboarding | Vietnoms")).toBe(false);
  });

  it("does not count pre-sale or generic meetings", () => {
    // The sales discovery, even when its title says marketing.
    expect(live("Discovery Meeting", "COMPLETED", "Fog of London <> AIO Marketing Discovery Meeting")).toBe(false);
    expect(live("", "COMPLETED", "Underdogs Cantina <> AIO Marketing Suite")).toBe(false);
    expect(live("", "COMPLETED", "AIO | Marketing Suite Meeting | Pulcinella Pizza & Pasta")).toBe(false);
    expect(live("Onboarding Call", "COMPLETED", "AIO Onboarding Call for Underdogs Cantina")).toBe(false);
    expect(live("", "COMPLETED", "Declined: AIO Marketing Onboarding | Entre Comales")).toBe(false);
  });

  it("returns the latest qualifying session", () => {
    const m = marketingDiscovery([
      { ...meeting("Marketing Catchup", "COMPLETED", "first"), startTime: "2026-10-01T00:00:00Z" },
      { ...meeting("Marketing Catchup", "COMPLETED", "second"), startTime: "2026-11-01T00:00:00Z" },
    ]);
    expect(m?.title).toBe("second");
  });
});

describe("buildLiveAccounts buckets", () => {
  const r = buildLiveAccounts(input({
    overrides: { "70": "G" },
    activity: [act("10", 100, 5000), act("20", 3), act("30", 7), act("70", 9), act("80", 4)],
    companies: [
      company("A", "Live Ordering Co", { tenant_id: "prod-10" }),
      company("B", "Live Marketing Co"),
      company("C", "Transacting Free Co", { tenant_id: "20" }),
      company("D", "Paying Idle Co", { tenant_id: "40" }),
      company("E", "No Tenant Co"),
      company("F", "Catchup Co"),
      company("G", "Override Co", { tenant_id: "71" }),
      company("H", "Payroll Only Co"),
      company("I", "No Discovery Co"),
      company("J", "Dup One", { tenant_id: "30" }),
      company("K", "Dup Two", { tenant_id: "prod-30" }),
      company("L", "Bean Counter"),
    ],
    aioBusinesses: [business("80", "Bean Counter Cafe")],
    subscriptions: [
      sub("A", "AIO Platform"),
      sub("B", "AIO Marketing Platform - Pro"),
      sub("D", "Order & Pay"),
      sub("E", "Food Truck"),
      sub("F", "AIO Marketing Platform"),
      sub("G", "AIO Platform"),
      sub("H", "Payroll - AIO Platform (Per Person)"),
      sub("I", "AIO Marketing Platform"),
      sub("C", "AIO Platform", "canceled"),
    ],
    meetingsByCompany: new Map([
      ["B", [meeting("Marketing Discovery", "COMPLETED", "Kickoff")]],
      ["F", [meeting("Marketing Catchup", "COMPLETED")]],
      ["I", [meeting("Discovery Meeting", "COMPLETED", "AIO Marketing discovery")]],
    ]),
  }));
  const ids = (b: keyof typeof r.buckets) => r.buckets[b].map(x => x.companyId ?? `tenant:${x.tenantIds[0]}`);

  it("1 live ordering: paying platform + transactions (incl. via override)", () => {
    expect(ids("live_ordering")).toEqual(["A", "G"]);
    expect(r.buckets.live_ordering.find(x => x.companyId === "G")!.match).toBe("override");
    expect(r.buckets.live_ordering[0]).toMatchObject({ txCount: 100, volume: 5000, match: "tenant id" });
  });
  it("2 live marketing: Marketing Discovery or a later Marketing Catchup", () => {
    expect(ids("live_marketing").sort()).toEqual(["B", "F"]);
    expect(r.buckets.live_marketing.find(x => x.companyId === "B")!.discovery).toContain("Marketing Discovery");
  });
  it("3 transacting, not paying: canceled company, ambiguous and name-only", () => {
    const rows = r.buckets.transacting_not_paying;
    expect(rows.map(x => [x.tenantIds[0], x.match])).toEqual(
      expect.arrayContaining([["20", "tenant id"], ["30", "ambiguous"], ["80", "name match — suggested"]]),
    );
    expect(rows).toHaveLength(3);
    expect(rows.find(x => x.tenantIds[0] === "30")!.candidates.map(c => c.id)).toEqual(["J", "K"]);
    expect(rows.find(x => x.tenantIds[0] === "80")!.companyId).toBe("L");
  });
  it("4 paying, no transactions", () => {
    expect(ids("paying_no_transactions")).toEqual(["D"]);
  });
  it("5 paying, no tenant id", () => {
    expect(ids("paying_no_tenant")).toEqual(["E"]);
  });
  it("6 marketing without discovery (a sales Discovery Meeting doesn't count)", () => {
    expect(ids("marketing_no_discovery")).toEqual(["I"]);
  });
  it("7 other subscription only (Payroll is other)", () => {
    expect(ids("other_only")).toEqual(["H"]);
  });

  it("suggests fixes for override and name matches, not for clean id matches", () => {
    const texts = Object.fromEntries(r.fixes.map(f => [f.companyId, f.text]));
    expect(texts.G).toBe("Tenant Id is 71 → should be 70");
    expect(texts.L).toBe("Set Tenant Id = 80 (name match — verify first)");
    expect(texts.A).toBeUndefined();
    expect(texts.C).toBeUndefined();
  });
});

describe("suggested fixes", () => {
  it("formats", () => {
    expect(suggestedFixText("2071", "2033")).toBe("Tenant Id is 2071 → should be 2033");
    expect(suggestedFixText(null, "1987")).toBe("Set Tenant Id = 1987");
  });

  it("flags a company whose tenant id disagrees with its override", () => {
    const r = buildLiveAccounts(input({
      overrides: { "2033": "A" },
      activity: [act("2033", 5)],
      companies: [company("A", "Alpha", { tenant_id: "prod-2071" })],
      subscriptions: [sub("A", "AIO Platform")],
    }));
    expect(r.fixes.map(f => f.text)).toEqual(["Tenant Id is prod-2071 → should be 2033"]);
  });

  it("asks to set a blank tenant id on an override company, and shows a stage value as stored", () => {
    const r = buildLiveAccounts(input({
      overrides: { "1924": "A", "4": "B" },
      activity: [act("1924", 5), act("4", 2)],
      companies: [company("A", "Alpha"), company("B", "Beta", { tenant_id: "4 (Stage)" })],
      subscriptions: [sub("A", "AIO Platform"), sub("B", "AIO Platform")],
    }));
    const texts = Object.fromEntries(r.fixes.map(f => [f.companyId, f.text]));
    expect(texts.A).toBe("Set Tenant Id = 1924");
    expect(texts.B).toBe("Tenant Id is 4 (Stage) → should be 4");
  });
});
