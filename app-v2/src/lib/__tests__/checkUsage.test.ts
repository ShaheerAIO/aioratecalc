import { describe, it, expect } from "vitest";
import { normalizeCompanyName, parseUsageCsv, periodLabel, pickBillingSubscription } from "@/lib/payroll/checkUsage";

const HEADER = "id,period_start,period_end,provider_uuid,provider,company,company_name,category,count";
const row = (company: string, name: string, category: string, count: number, period = "2026-09-01,2026-09-30") =>
  `x,${period},p,AIO,${company},${name},${category},${count}`;

describe("parseUsageCsv", () => {
  it("sums employee rows per company and ignores the other categories", () => {
    const csv = [
      HEADER,
      row("com_a", "Espumita L.L.C.", "employee", 6),
      row("com_a", "Espumita L.L.C.", "company", 1),
      row("com_a", "Espumita L.L.C.", "company_setup", 1),
      row("com_b", "\"Stellar Restaurant Group, Inc.\"", "company", 1),
      row("com_c", "Maple House LLC", "employee", 25),
    ].join("\r\n") + "\r\n";

    expect(parseUsageCsv(csv)).toEqual({
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      companies: [
        { checkCompanyId: "com_a", checkCompanyName: "Espumita L.L.C.", employees: 6 },
        { checkCompanyId: "com_c", checkCompanyName: "Maple House LLC", employees: 25 },
        { checkCompanyId: "com_b", checkCompanyName: "Stellar Restaurant Group, Inc.", employees: 0 },
      ],
    });
  });

  it("refuses a file that is not Check's export", () => {
    expect(() => parseUsageCsv("name,amount\nfoo,1")).toThrow(/missing column/);
  });

  it("refuses a file spanning more than one month", () => {
    const csv = [HEADER, row("com_a", "A", "employee", 1), row("com_a", "A", "employee", 1, "2026-08-01,2026-08-31")].join("\n");
    expect(() => parseUsageCsv(csv)).toThrow(/one month/);
  });

  it("refuses a non-numeric count", () => {
    expect(() => parseUsageCsv([HEADER, "x,2026-09-01,2026-09-30,p,AIO,com_a,A,employee,lots"].join("\n"))).toThrow(/Bad employee count/);
  });
});

describe("normalizeCompanyName", () => {
  it("strips entity suffixes and punctuation", () => {
    expect(normalizeCompanyName("Espumita L.L.C.")).toBe("Espumita");
    expect(normalizeCompanyName("LAJEVARD EATS & CO. LLC")).toBe("LAJEVARD EATS");
    expect(normalizeCompanyName("Crazy Pita (Port St Lucie)")).toBe("Crazy Pita Port St Lucie");
  });
});

describe("pickBillingSubscription", () => {
  const sub = (id: string, status: string | null, createdAt: string, contactId: string | null = `c_${id}`) =>
    ({ subscriptionId: id, dealId: "d", contactId, status, createdAt });

  it("prefers the newest active subscription", () => {
    expect(pickBillingSubscription([
      sub("old", "active", "2026-01-01"), sub("new", "active", "2026-08-01"), sub("newest", "canceled", "2026-09-01"),
    ])?.subscriptionId).toBe("new");
  });

  it("falls back to the newest of any status, skipping ones with no contact", () => {
    expect(pickBillingSubscription([
      sub("a", "expired", "2026-01-01"), sub("b", "canceled", "2026-05-01"), sub("c", "canceled", "2026-09-01", null),
    ])?.subscriptionId).toBe("b");
  });

  it("is null when the company never subscribed", () => {
    expect(pickBillingSubscription([])).toBeNull();
  });
});

describe("periodLabel", () => {
  it("names the month", () => expect(periodLabel("2026-09-01")).toBe("September 2026"));
});
