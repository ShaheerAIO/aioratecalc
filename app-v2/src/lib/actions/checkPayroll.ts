"use server";

// Check payroll billing — the hidden /admin/payroll-billing page (2026-10-23).
// An admin uploads Check's monthly usage export; each company gets one DRAFT
// HubSpot invoice for its employee count, on the contact its subscription
// bills. Drafts only: nothing is opened, sent or charged here. See
// docs/claude/check-payroll-billing.md.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { checkCompanyLinks, checkPayrollInvoices } from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import {
  INVOICE_TO_COMPANY,
  INVOICE_TO_CONTACT,
  INVOICE_TO_DEAL,
  INVOICE_TO_LINE_ITEM,
  associateInvoice,
  clearLineItemRecurrence,
  createDraftInvoice,
  createQuoteLineItems,
  draftInvoiceProperties,
  findCompaniesByCheckId,
  getContactSummaries,
  getProductPrice,
  getTenantCompany,
  listBillingSubscriptions,
  listCompanyDealIds,
  searchTenantCompanies,
  type InvoiceAssociation,
} from "@/lib/adapters/hubspot";
import {
  PAYROLL_PRODUCT_ID,
  normalizeCompanyName,
  parseUsageCsv,
  periodLabel,
  pickBillingSubscription,
} from "@/lib/payroll/checkUsage";

async function requireAdmin() {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");
  return effective;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type HubspotCompanyOption = { id: string; name: string };

export type PayrollBilling = {
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  dealId: string;
  subscriptionStatus: string | null;
};

export type PayrollRow = {
  checkCompanyId: string;
  checkCompanyName: string;
  employees: number;
  amount: number;
  link: HubspotCompanyOption | null;
  /** Only for unlinked rows: HubSpot companies whose name looks similar. */
  suggestions: HubspotCompanyOption[];
  /** Null with `billingError` set when the contact couldn't be resolved. */
  billing: PayrollBilling | null;
  billingError: string | null;
  invoice: { invoiceId: string | null; invoiced: boolean; lastError: string | null } | null;
};

export type PayrollPreview = {
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  unitPrice: number;
  rows: PayrollRow[];
};

/** The billing contact for a linked HubSpot company, or why there isn't one. */
async function resolveBilling(hubspotCompanyId: string): Promise<{ billing: PayrollBilling | null; billingError: string | null }> {
  try {
    const subs = await listBillingSubscriptions(await listCompanyDealIds(hubspotCompanyId));
    const pick = pickBillingSubscription(subs);
    if (!pick?.contactId) {
      return { billing: null, billingError: "No subscription with a contact on this company's deals — nobody to bill." };
    }
    const contact = (await getContactSummaries([pick.contactId])).get(pick.contactId);
    return {
      billing: {
        contactId: pick.contactId,
        contactName: contact?.name ?? `Contact ${pick.contactId}`,
        contactEmail: contact?.email ?? null,
        dealId: pick.dealId,
        subscriptionStatus: pick.status,
      },
      billingError: null,
    };
  } catch (err) {
    return { billing: null, billingError: `Couldn't read billing contact: ${message(err)}` };
  }
}

async function suggestCompanies(checkCompanyName: string): Promise<HubspotCompanyOption[]> {
  try {
    const hits = await searchTenantCompanies(normalizeCompanyName(checkCompanyName), 5);
    return hits.map(c => ({ id: c.id, name: c.name }));
  } catch {
    return [];
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function previewCheckUsageAction(csvText: string): Promise<PayrollPreview | { error: string }> {
  await requireAdmin();
  let usage;
  try {
    usage = parseUsageCsv(csvText);
  } catch (err) {
    return { error: message(err) };
  }

  let unitPrice: number;
  try {
    unitPrice = await getProductPrice(PAYROLL_PRODUCT_ID);
  } catch (err) {
    return { error: `Couldn't read the payroll product's price from HubSpot: ${message(err)}` };
  }

  const ids = usage.companies.map(c => c.checkCompanyId);
  const [links, invoices] = await Promise.all([
    db.select().from(checkCompanyLinks).where(inArray(checkCompanyLinks.checkCompanyId, ids)),
    db.select().from(checkPayrollInvoices).where(and(
      inArray(checkPayrollInvoices.checkCompanyId, ids),
      eq(checkPayrollInvoices.periodStart, usage.periodStart),
    )),
  ]);
  const linkOf = new Map(links.map(l => [l.checkCompanyId, l]));
  const invoiceOf = new Map(invoices.map(i => [i.checkCompanyId, i]));

  // The Check id typed onto the HubSpot company is the authority: exactly one
  // company carrying it links (or re-links) the row with no admin step. Two or
  // more are offered as suggestions instead. A failed lookup (e.g. the property
  // doesn't exist yet) just falls back to the saved links and name matching.
  let byCheckId = new Map<string, HubspotCompanyOption[]>();
  try {
    byCheckId = await findCompaniesByCheckId(ids);
  } catch (err) {
    console.warn("[payroll] Check-id lookup failed; using saved links only", message(err));
  }
  for (const c of usage.companies) {
    const hits = byCheckId.get(c.checkCompanyId);
    if (hits?.length !== 1 || linkOf.get(c.checkCompanyId)?.hubspotCompanyId === hits[0].id) continue;
    const values = {
      checkCompanyName: c.checkCompanyName,
      hubspotCompanyId: hits[0].id,
      hubspotCompanyName: hits[0].name,
      linkedBy: "hubspot:checkhq_company_id",
      linkedAt: new Date(),
    };
    const [saved] = await db.insert(checkCompanyLinks)
      .values({ checkCompanyId: c.checkCompanyId, ...values })
      .onConflictDoUpdate({ target: checkCompanyLinks.checkCompanyId, set: values })
      .returning();
    linkOf.set(c.checkCompanyId, saved);
  }

  // Sequential: a few HubSpot calls per company, and the search API is the
  // portal's tightest rate limit.
  const rows: PayrollRow[] = [];
  for (const c of usage.companies) {
    const link = linkOf.get(c.checkCompanyId);
    const inv = invoiceOf.get(c.checkCompanyId);
    const resolved = link && c.employees > 0 && !inv?.invoicedAt
      ? await resolveBilling(link.hubspotCompanyId)
      : { billing: null, billingError: null };
    rows.push({
      checkCompanyId: c.checkCompanyId,
      checkCompanyName: c.checkCompanyName,
      employees: c.employees,
      amount: round2(c.employees * unitPrice),
      link: link ? { id: link.hubspotCompanyId, name: link.hubspotCompanyName } : null,
      suggestions: link ? [] : byCheckId.get(c.checkCompanyId) ?? await suggestCompanies(c.checkCompanyName),
      ...resolved,
      invoice: inv ? { invoiceId: inv.hubspotInvoiceId, invoiced: !!inv.invoicedAt, lastError: inv.lastError } : null,
    });
  }

  return { periodStart: usage.periodStart, periodEnd: usage.periodEnd, periodLabel: periodLabel(usage.periodStart), unitPrice, rows };
}

export async function searchHubspotCompaniesAction(query: string): Promise<HubspotCompanyOption[]> {
  await requireAdmin();
  const hits = await searchTenantCompanies(query, 10);
  return hits.map(c => ({ id: c.id, name: c.name }));
}

/**
 * Remember which HubSpot company a Check company is. Re-reads the company by id
 * rather than trusting the name the picker showed. Returns the row's freshly
 * resolved billing contact.
 */
export async function linkCheckCompanyAction(
  checkCompanyId: string,
  checkCompanyName: string,
  hubspotCompanyId: string
): Promise<{ link: HubspotCompanyOption; billing: PayrollBilling | null; billingError: string | null } | { error: string }> {
  const admin = await requireAdmin();
  const company = await getTenantCompany(hubspotCompanyId);
  if (!company) return { error: `HubSpot company ${hubspotCompanyId} not found.` };

  const values = {
    checkCompanyName,
    hubspotCompanyId: company.id,
    hubspotCompanyName: company.name,
    linkedBy: admin.userId,
    linkedAt: new Date(),
  };
  await db.insert(checkCompanyLinks)
    .values({ checkCompanyId, ...values })
    .onConflictDoUpdate({ target: checkCompanyLinks.checkCompanyId, set: values });

  return { link: { id: company.id, name: company.name }, ...(await resolveBilling(company.id)) };
}

export type CreatePayrollInvoiceResult =
  | { status: "created" | "already_invoiced"; invoiceId: string }
  | { status: "failed"; error: string };

/**
 * One company's draft invoice. The employee count comes from re-parsing the
 * uploaded file here, never from the client. Idempotent per company per
 * month: the row is claimed before the first HubSpot write and every id is
 * persisted as it's created, so a retry resumes rather than billing twice.
 */
export async function createPayrollInvoiceAction(csvText: string, checkCompanyId: string): Promise<CreatePayrollInvoiceResult> {
  const admin = await requireAdmin();
  let usage;
  try {
    usage = parseUsageCsv(csvText);
  } catch (err) {
    return { status: "failed", error: message(err) };
  }
  const company = usage.companies.find(c => c.checkCompanyId === checkCompanyId);
  if (!company) return { status: "failed", error: "That company isn't in the uploaded file." };
  if (company.employees === 0) return { status: "failed", error: "No employees this month — nothing to invoice." };

  const [link] = await db.select().from(checkCompanyLinks).where(eq(checkCompanyLinks.checkCompanyId, checkCompanyId)).limit(1);
  if (!link) return { status: "failed", error: "Link this company to HubSpot first." };

  const where = and(
    eq(checkPayrollInvoices.checkCompanyId, checkCompanyId),
    eq(checkPayrollInvoices.periodStart, usage.periodStart),
  );
  let [row] = await db.select().from(checkPayrollInvoices).where(where).limit(1);
  if (row?.invoicedAt) return { status: "already_invoiced", invoiceId: row.hubspotInvoiceId! };

  // ── Claim ─────────────────────────────────────────────────────────────────
  if (!row) {
    const { billing, billingError } = await resolveBilling(link.hubspotCompanyId);
    if (!billing) return { status: "failed", error: billingError ?? "No billing contact." };
    let unitPrice: number;
    try {
      unitPrice = await getProductPrice(PAYROLL_PRODUCT_ID);
    } catch (err) {
      return { status: "failed", error: message(err) };
    }
    [row] = await db.insert(checkPayrollInvoices).values({
      checkCompanyId,
      periodStart: usage.periodStart,
      employeeCount: company.employees,
      amount: String(round2(company.employees * unitPrice)),
      hubspotCompanyId: link.hubspotCompanyId,
      contactId: billing.contactId,
      dealId: billing.dealId,
      createdBy: admin.userId,
    }).onConflictDoNothing().returning();
    // Lost the race to a concurrent click; that request owns the build.
    if (!row) return { status: "failed", error: "Another request is creating this invoice — refresh in a moment." };
  }
  // A resumed row keeps the count, contact and price it was claimed with.

  const persist = async (set: Partial<typeof checkPayrollInvoices.$inferInsert>) => {
    await db.update(checkPayrollInvoices).set({ ...set, updatedAt: new Date() }).where(eq(checkPayrollInvoices.id, row.id));
  };

  let step = "line item";
  try {
    let lineItemId = row.lineItemId;
    if (!lineItemId) {
      const unitPrice = round2(Number(row.amount) / row.employeeCount);
      [lineItemId] = await createQuoteLineItems([{
        hubspotProductId: PAYROLL_PRODUCT_ID,
        name: "Payroll - AIO Platform (Per Person)",
        qty: row.employeeCount,
        unitPrice,
        billingFrequency: "one_time",
        productType: "",
      }]);
      await clearLineItemRecurrence(lineItemId);
      await persist({ lineItemId });
    }

    step = "draft invoice";
    let invoiceId = row.hubspotInvoiceId;
    if (!invoiceId) {
      invoiceId = await createDraftInvoice({
        ...draftInvoiceProperties(new Date().toISOString().slice(0, 10)),
        hs_comments: `Payroll — ${periodLabel(row.periodStart)} (${row.employeeCount} employee${row.employeeCount === 1 ? "" : "s"})`,
      });
      await persist({ hubspotInvoiceId: invoiceId });
    }

    step = "associations";
    const assocs: InvoiceAssociation[] = [
      { toObjectType: "line_items", toObjectId: lineItemId, associationTypeId: INVOICE_TO_LINE_ITEM },
      { toObjectType: "contacts", toObjectId: row.contactId, associationTypeId: INVOICE_TO_CONTACT },
      { toObjectType: "companies", toObjectId: row.hubspotCompanyId, associationTypeId: INVOICE_TO_COMPANY },
    ];
    if (row.dealId) assocs.push({ toObjectType: "deals", toObjectId: row.dealId, associationTypeId: INVOICE_TO_DEAL });
    await associateInvoice(invoiceId, assocs);

    await persist({ invoicedAt: new Date(), lastError: null });
    console.log(`[payroll] ${checkCompanyId} ${row.periodStart}: draft invoice ${invoiceId} for $${row.amount}`);
    return { status: "created", invoiceId };
  } catch (err) {
    const error = `${step} failed: ${message(err)}`;
    await persist({ lastError: error }).catch(() => {});
    return { status: "failed", error };
  }
}
