"use server";

// Phase G — what AIO actually earned, read back from Adyen settlement.
//
// ADMIN ONLY, and not because the numbers are merely sensitive: this is AIO's
// realised take rate per merchant, which is exactly the figure the pillowed
// margin model exists to keep away from reps (see derivePricingForRole in
// pricing.ts). A rep who could read this could derive the true floor from any
// live account, and the whole trust boundary would be decorative.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications, merchantMonthlyActuals } from "@/lib/db/schema";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { buildRevenueReport, type ActualsRow, type RevenueReport } from "@/lib/revenueView";

/**
 * Every month of settled actuals, joined to whatever application claims each
 * tenant number, shaped into the admin money view.
 *
 * The join key is `adyenIds->>'tenantNumber'`, the same jsonb lookup
 * `advanceApprovedFromSettlement` uses — `adyenIds.tenantNumber` is the AIO
 * business id, and the settlement ingest builds its `prod-{n}` store reference
 * from it. A LEFT join, deliberately: a tenant that settles money but matches
 * no application is a REAL and interesting row (an account created outside
 * EasyOB, or one whose tenant number never got written back), and dropping it
 * would quietly understate AIO's revenue. It renders with no name instead.
 *
 * The whole table is read in one go rather than a month at a time. It is one
 * row per tenant per month — a few thousand rows after several years — and one
 * query that can answer every month beats a query per click.
 */
export async function getRevenueReportAction(month?: string | null): Promise<RevenueReport> {
  const effective = await getEffectiveRole();
  if (!effective || effective.role !== "admin") throw new Error("Admin only");

  const rows = await db
    .select({
      tenantNumber: merchantMonthlyActuals.tenantNumber,
      month: merchantMonthlyActuals.month,
      grossVolume: merchantMonthlyActuals.grossVolume,
      transactionCount: merchantMonthlyActuals.transactionCount,
      aioCommission: merchantMonthlyActuals.aioCommission,
      applicationId: merchantApplications.id,
      legalName: sql<string | null>`${merchantApplications.business} ->> 'legalName'`,
      dba: sql<string | null>`${merchantApplications.business} ->> 'dba'`,
    })
    .from(merchantMonthlyActuals)
    .leftJoin(
      merchantApplications,
      sql`${merchantApplications.adyenIds} ->> 'tenantNumber' = ${merchantMonthlyActuals.tenantNumber}`
    );

  // numeric(14,2) comes back as a string from the driver — parse here, once,
  // rather than leaving every consumer to remember.
  const actuals: ActualsRow[] = rows.map(r => ({
    tenantNumber: r.tenantNumber,
    month: r.month,
    grossVolume: Number(r.grossVolume),
    transactionCount: r.transactionCount,
    aioCommission: Number(r.aioCommission),
    merchantName: r.dba?.trim() || r.legalName?.trim() || null,
    applicationId: r.applicationId ?? null,
  }));

  return buildRevenueReport(actuals, month);
}
