import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { marginReqsPolicy } from "@/lib/db/schema";
import { MARGIN_REQS, type MarginReq } from "@/lib/pricing";
import { marginReqsProblems, type MarginReqBps } from "@/lib/marginPolicy";

// SERVER-ONLY, and deliberately NOT in a "use server" file: every export of one
// of those is a callable endpoint, and this returns AIO's true margin floors.
// Rep-facing code reaches the numbers only through derivePricingForRole.

const bps = (fraction: number) => Math.round(fraction * 10000);

/** The code defaults, as the bps rows the admin page edits. */
export function defaultMarginReqsBps(): MarginReqBps[] {
  return MARGIN_REQS.map(r => ({
    minBps: bps(r.minMargin), desiredBps: bps(r.desiredMargin), maxBps: bps(r.maxMargin),
  }));
}

/** Saved bps rows laid over the fixed bands (maxVol) and reference desiredArr from code. */
export function marginReqsFromBps(rows: MarginReqBps[]): MarginReq[] {
  return MARGIN_REQS.map((base, i) => ({
    ...base,
    minMargin: rows[i].minBps / 10000,
    desiredMargin: rows[i].desiredBps / 10000,
    maxMargin: rows[i].maxBps / 10000,
  }));
}

/** The saved rows if they are a valid table, else null (caller falls back to code). */
export function validSavedMarginBps(saved: unknown): MarginReqBps[] | null {
  if (!Array.isArray(saved)) return null;
  const rows = saved as MarginReqBps[];
  return marginReqsProblems(rows).length === 0 ? rows : null;
}

/**
 * The live margin table: the admin's saved one, or today's MARGIN_REQS when
 * there is no row, the column is empty/malformed, or the read fails (an
 * unmigrated DB must degrade to the code table, never take pricing down).
 */
export async function loadMarginReqsBps(): Promise<MarginReqBps[]> {
  try {
    const [row] = await db.select().from(marginReqsPolicy).where(eq(marginReqsPolicy.isActive, true)).limit(1);
    return validSavedMarginBps(row?.rows) ?? defaultMarginReqsBps();
  } catch (err) {
    console.error("[margin-reqs] could not read margin_reqs_policy; using MARGIN_REQS in code", err);
    return defaultMarginReqsBps();
  }
}

export async function loadMarginReqs(): Promise<MarginReq[]> {
  return marginReqsFromBps(await loadMarginReqsBps());
}
