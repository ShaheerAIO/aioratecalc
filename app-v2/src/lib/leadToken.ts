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

/**
 * Whether the quote on this row is out of the merchant's hands right now
 * (2026-11-02): a draft, waiting on an admin's approval, or approved but not
 * yet made live by the rep. `quoteStatus` null is the only merchant-visible
 * state. A rep can push a quote the merchant already has a link to back into
 * `pending_approval` by editing it past a limit, so every lead page and every
 * lead-side write that acts on the quote checks this, not just the link-send.
 *
 * Takes the row or the mapped app — both carry `quoteStatus`.
 */
export function isQuoteLocked(app: { quoteStatus?: string | null }): boolean {
  return app.quoteStatus != null;
}

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
