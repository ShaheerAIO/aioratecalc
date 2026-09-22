// The token→row lookup shared by the /lead/[token] pages (the checklist, the
// quote step, the demo step). Kept out of applicationRow.ts (which is
// deliberately DB-handle-free) because this one holds the query.
//
// The two API routes (accept, analyze) do NOT use this — they were already
// built and tested with the lookup inlined, and touching working, tested
// routes for a cosmetic dedupe isn't worth the risk. This exists so the THREE
// new pages this task adds don't triple that duplication.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import type { ApplicationRow } from "@/lib/storage/applicationRow";

export type LeadTokenLookup =
  | { ok: true; row: ApplicationRow }
  | { ok: false; reason: "invalid" | "expired" };

export async function getLeadApplicationByToken(token: string): Promise<LeadTokenLookup> {
  const [row] = await db
    .select()
    .from(merchantApplications)
    .where(eq(merchantApplications.customerLinkToken, token))
    .limit(1);

  if (!row || row.customerLinkPurpose !== "lead_upload") {
    return { ok: false, reason: "invalid" };
  }
  if (row.customerLinkExpiresAt && row.customerLinkExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, row };
}
