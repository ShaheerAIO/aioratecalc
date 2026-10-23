// Check payroll billing (2026-10-23, product owner). Pure helpers for the
// hidden /admin/payroll-billing page: parse Check's monthly usage export, and
// pick which HubSpot contact an invoice goes to. See
// docs/claude/check-payroll-billing.md.

/** "Payroll - AIO Platform (Per Person)" in the HubSpot catalog. */
export const PAYROLL_PRODUCT_ID = "223152695998";

/** Only employee counts are billed (product owner, 2026-10-23); `company`,
 *  `company_setup` and every other category are ignored. */
const BILLED_CATEGORY = "employee";

const REQUIRED_COLUMNS = ["period_start", "period_end", "company", "company_name", "category", "count"];

export type CheckUsageCompany = {
  checkCompanyId: string;
  checkCompanyName: string;
  employees: number;
};

export type CheckUsage = {
  periodStart: string; // yyyy-MM-dd
  periodEnd: string;
  companies: CheckUsageCompany[];
};

/** Minimal RFC 4180: quoted fields, doubled quotes, CRLF or LF. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(f => f.trim() !== "")) rows.push(row);
  return rows;
}

/**
 * Check's `usage_summaries_YYYY-M.csv`: one row per company × category. Every
 * company in the file is returned, including those with no employee rows
 * (employees: 0), so the page can say why they are not billed. Throws a
 * readable error on anything that isn't one month of that export.
 */
export function parseUsageCsv(text: string): CheckUsage {
  const [header, ...rows] = parseCsvRows(text.replace(/^﻿/, ""));
  if (!header) throw new Error("The file is empty.");
  const cols = header.map(h => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter(c => !cols.includes(c));
  if (missing.length > 0) {
    throw new Error(`This doesn't look like Check's usage summary export — missing column(s): ${missing.join(", ")}.`);
  }
  const at = (row: string[], col: string) => (row[cols.indexOf(col)] ?? "").trim();

  const periods = new Set(rows.map(r => `${at(r, "period_start")}|${at(r, "period_end")}`));
  if (periods.size !== 1) {
    throw new Error(`Upload one month at a time — this file covers ${periods.size} billing periods.`);
  }
  const [periodStart, periodEnd] = [...periods][0].split("|");

  const byId = new Map<string, CheckUsageCompany>();
  for (const r of rows) {
    const id = at(r, "company");
    if (!id) continue;
    const company = byId.get(id) ?? { checkCompanyId: id, checkCompanyName: at(r, "company_name"), employees: 0 };
    byId.set(id, company);
    if (at(r, "category") !== BILLED_CATEGORY) continue;
    const count = Number(at(r, "count"));
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Bad employee count '${at(r, "count")}' for ${company.checkCompanyName}.`);
    }
    company.employees += count;
  }

  return {
    periodStart,
    periodEnd,
    companies: [...byId.values()].sort((a, b) => a.checkCompanyName.localeCompare(b.checkCompanyName)),
  };
}

/**
 * Check carries the LEGAL name ("TEA AMPERSAND LLC"), HubSpot the restaurant's
 * ("Lajevard Eats & Co."), so an exact search almost never hits. Stripping
 * entity suffixes and punctuation turns enough of them into a usable
 * suggestion; an admin still confirms every link.
 */
export function normalizeCompanyName(name: string): string {
  return name
    .replace(/l\.l\.c\.?/gi, " ")
    .replace(/[(),.&'"]/g, " ")
    .replace(/\b(llc|inc|corp|co|ltd|the|group|restaurant)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type BillingSubscription = {
  subscriptionId: string;
  dealId: string;
  contactId: string | null;
  status: string | null;
  createdAt: string | null;
};

/**
 * The contact an invoice goes to: whoever is on the company's subscription,
 * since that is the contact holding the billing details and the one their
 * recurring invoices already go to. No portal contact carries the "Billing
 * Contact" label (checked 2026-10-23). Newest ACTIVE subscription first, then
 * newest of any status; null when the company has never subscribed.
 */
export function pickBillingSubscription(subs: BillingSubscription[]): BillingSubscription | null {
  const withContact = subs
    .filter(s => s.contactId)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return withContact.find(s => s.status === "active") ?? withContact[0] ?? null;
}

/** "2026-09-01" → "September 2026". */
export function periodLabel(periodStart: string): string {
  const [y, m] = periodStart.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
