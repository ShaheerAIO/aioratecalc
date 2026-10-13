// The token→row lookup shared by the /lead/[token] pages (the checklist and
// the quote step). Kept out of applicationRow.ts (which is
// deliberately DB-handle-free) because this one holds the query.
//
// /api/lead/[token]/accept does NOT use this — it was already built and tested
// with the lookup inlined, and touching a working, tested route for a cosmetic
// dedupe isn't worth the risk. This exists so the pages don't duplicate it.
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
