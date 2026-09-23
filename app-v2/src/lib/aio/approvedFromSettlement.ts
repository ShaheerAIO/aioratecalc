// Settlement-derived KYC backstop.
//
// Retiring EasyOB's Adyen integration also retired the Balance Platform
// webhook, which was the only thing that moved a deal to adyen_approved on its
// own. AIO's API exposes no onboarding status we can read (verified
// 2026-09-23), so the primary replacement is a human pressing a button.
//
// This is the free second line. If a tenant shows up in Adyen's settlement
// report, that merchant is demonstrably taking money through Adyen — which
// strictly implies Adyen approved them. It's late (T+1 at best, since the
// report is daily) and it only fires for merchants who have actually
// transacted, so it can never be the only mechanism. But it is ground truth
// rather than an inference, it costs one query on data we already ingest, and
// it means a busy account can't sit at adyen_kyc_pending forever because
// nobody remembered to click.
//
// Strictly additive to the settlement pipeline: the caller must never let a
// failure here abort the ingest, which is the thing that actually matters.

import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { STAGE_RANK, shouldAdvance } from "@/lib/stages";

/**
 * Advance any application whose AIO tenant number appears in `tenantNumbers`
 * to adyen_approved, forward-only. Returns how many rows moved.
 */
export async function advanceApprovedFromSettlement(tenantNumbers: string[]): Promise<number> {
  const unique = [...new Set(tenantNumbers.filter(Boolean))];
  if (unique.length === 0) return 0;

  const rows = await db
    .select({ id: merchantApplications.id, stage: merchantApplications.stage })
    .from(merchantApplications)
    .where(inArray(sql`${merchantApplications.adyenIds}->>'tenantNumber'`, unique));

  let advanced = 0;
  for (const row of rows) {
    // closed_lost outranks adyen_approved in STAGE_RANK, so shouldAdvance
    // would happily "advance" a live merchant INTO it — guard explicitly.
    // A merchant who is settling money is not lost, but un-losing them is a
    // human's call, not a side effect of a nightly report.
    if (row.stage === "closed_lost") continue;
    if (!shouldAdvance(row.stage, "adyen_approved")) continue;

    await db
      .update(merchantApplications)
      .set({ stage: "adyen_approved", updatedAt: new Date() })
      .where(sql`${merchantApplications.id} = ${row.id} AND ${merchantApplications.stage} = ${row.stage}`);
    advanced++;
  }
  return advanced;
}

// Re-exported so a caller can assert the ranking assumption above in a test.
export { STAGE_RANK };
