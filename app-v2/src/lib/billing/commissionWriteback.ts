// Writes `signing_commission` / `activation_commission` to the HubSpot deal,
// alongside (never instead of) `payment_processing_arr` — same moment
// (publish, see publishBillingQuote.ts; acceptance re-runs it), same "omit
// rather than zero, never for a quote with no basis" rule.
//
// BEHIND AN ENV FLAG, DEFAULT OFF — `COMMISSION_WRITEBACK_ENABLED` must be
// exactly "true" (same posture as `AIO_DASHBOARD_ENABLED`). The reason is the
// whole point of the flag, so it's stated here rather than just in a PR
// description: something in the HubSpot portal is ALREADY populating these
// two properties on ~700 live deals, and all 619 existing
// `payment_processing_arr` values were bulk-stamped in one pass on
// 2026-10-13. Nobody has identified what that automation is yet. Until it is
// found and switched off, EasyOB's own write and that automation's write
// would race on a number that pays people — silently, with no way to tell
// which one "won" on any given deal. The flag is what stops that race from
// starting before anyone has looked.
//
// THE BASIS IS HUBSPOT'S REAL NUMBERS, NOT AN ESTIMATE — corrected 2026-10-13
// after an earlier version of this file summed `payment_processing_arr` with
// `estimatedRecurringArrFromQuoteLines` (lib/commission.ts), EasyOB's own
// guess at HubSpot's `saas_revenue`. That guess is PROVEN to diverge: a live
// deal with a $399/mo platform line carries `saas_revenue: 4788.50` (399×12
// PLUS the $0.50 pre-auth line), where the estimate came out to 4788.00 flat
// on the simplest possible quote, with more room to drift on anything with
// mixed billing frequencies. Writing a commission computed off a DIFFERENT
// total_arr than the one printed on the same deal record is exactly the kind
// of disagreement that turns into a dispute over money someone gets paid —
// so this now reads HubSpot's actual `saas_revenue` live, at write time, and
// REFUSES TO WRITE AT ALL if that read doesn't come back clean. Omitting a
// commission is recoverable on the next pass (the nightly billing-sync cron
// resyncs already-accepted rows); writing a wrong one onto a CRM record is
// not — same posture `resolveSender` already takes elsewhere in this
// codebase ("could not check" is refused exactly like "wrong").
//
// ORDERING: this runs immediately after `syncDealFromApplication` has (or
// hasn't — see below) PATCHed `payment_processing_arr` onto the same deal in
// `recordAcceptance`. Two things follow from that:
//   * The PROCESSING term uses EasyOB's OWN freshly-computed
//     `paymentProcessingArrBreakdown(app).arr` — the exact value just written
//     (or attempted) — rather than reading `payment_processing_arr` back from
//     HubSpot. A read immediately after our own PATCH risks observing HubSpot
//     before it has recalculated anything derived from that property; using
//     our own in-memory value sidesteps that race entirely, and it's
//     authoritative regardless: we computed it, we (tried to) write it, it IS
//     the correct figure independent of whether the PATCH round-trip has
//     settled on HubSpot's side.
//   * The SAAS term is read live via a targeted GET of `saas_revenue` alone
//     — never `total_arr`. `total_arr` is HubSpot's own rollup of
//     `payment_processing_arr + saas_revenue`, and reading THAT immediately
//     after our own `payment_processing_arr` write risks the same staleness
//     the point above avoids: we have no guarantee HubSpot has recalculated
//     the rollup yet. `saas_revenue` is a property EasyOB never writes, so
//     it carries no such race — reading it directly and adding it to our own
//     processing figure is the version of "total ARR" that can't be stale.

import { paymentProcessingArrBreakdown } from "@/lib/billing/processingArr";
import { commissionFromTotalArr, sumArrOrNull } from "@/lib/commission";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { MerchantApplication } from "@/types/merchant";

const BASE = "https://api.hubapi.com";

export function commissionWritebackEnabled(): boolean {
  return process.env.COMMISSION_WRITEBACK_ENABLED === "true";
}

type SaasRevenueRead =
  | { ok: true; saasRevenue: number }
  | { ok: false; reason: string };

/**
 * A targeted GET of exactly one property — `saas_revenue` — on the deal.
 * Deliberately NOT `total_arr` (see the module comment on staleness) and
 * deliberately not routed through adapters/hubspot.ts (owned elsewhere and
 * under active edit as of this writing): this is its own narrow,
 * single-purpose read, the same shape as that file's own
 * `getDealProcessingArr` (a dedicated reader for one property, separate from
 * the general sync path), so it can't race a concurrent change there.
 *
 * Returns `{ ok: false }` for EVERY failure mode — network error, non-2xx,
 * missing property, or a value that doesn't parse as a finite number — never
 * a thrown error and never a guessed number. The caller's job is to refuse
 * the write on any of these, not to tell them apart.
 */
async function fetchSaasRevenue(dealId: string, token: string): Promise<SaasRevenueRead> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/crm/v3/objects/deals/${dealId}?properties=saas_revenue`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return { ok: false, reason: `saas_revenue read threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `saas_revenue read failed (${res.status}): ${await res.text()}` };
  }
  let data: { properties?: { saas_revenue?: string | null } };
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, reason: `saas_revenue read returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const raw = data.properties?.saas_revenue;
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, reason: "saas_revenue is absent on the deal" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: `saas_revenue did not parse as a number: ${JSON.stringify(raw)}` };
  }
  return { ok: true, saasRevenue: n };
}

/**
 * Best-effort, NEVER THROWS — same posture as the HubSpot deal sync it rides
 * alongside in `recordAcceptance` (acceptance.ts). Acceptance is already
 * committed by the time this runs; a failure here must not undo it or
 * surface as an acceptance failure.
 *
 * On ANY failure to read `saas_revenue` (network, non-2xx, missing,
 * unparseable) this WRITES NOTHING and records the reason to
 * `hubspotIds.lastSyncError` — the same place a failed deal sync already
 * reports to, so it's visible on the rep's billing panel instead of
 * vanishing into a Vercel log. No second attempt is scheduled from here —
 * the nightly billing-sync cron's resync of already-accepted rows is the
 * next chance, same as the deal sync it sits beside.
 */
export async function writeCommissionToDeal(app: MerchantApplication): Promise<void> {
  if (!commissionWritebackEnabled()) return;
  if (!app.hubspotDealId) return;

  const token = process.env.HUBSPOT_BILLING_PRIVATE_APP_TOKEN;
  if (!token) {
    console.error(`[commission] ${app.id}: COMMISSION_WRITEBACK_ENABLED=true but HUBSPOT_BILLING_PRIVATE_APP_TOKEN is unset`);
    return;
  }

  // Ours, authoritative — see the module comment on why this is NOT re-read
  // from HubSpot. May be null (marketing-only, no volume yet); that's a real
  // answer, not a failure, and is handled by sumArrOrNull below.
  const processingArr = paymentProcessingArrBreakdown(app).arr;

  const saas = await fetchSaasRevenue(app.hubspotDealId, token);
  if (!saas.ok) {
    console.error(`[commission] ${app.id}: refusing to write a commission — ${saas.reason}`);
    await recordCommissionSyncError(app, `commission not written: ${saas.reason}`);
    return;
  }

  const totalArr = sumArrOrNull(processingArr, saas.saasRevenue);
  const { signingCommission, activationCommission } = commissionFromTotalArr(totalArr);

  const props: Record<string, string> = {};
  // Omit rather than zero — a $0 commission reads as a measured zero, same
  // rule payment_processing_arr already follows (processingArr.ts).
  if (signingCommission !== null) props.signing_commission = String(signingCommission);
  if (activationCommission !== null) props.activation_commission = String(activationCommission);
  if (Object.keys(props).length === 0) return; // no basis — never PATCH an empty payload

  try {
    const res = await fetch(`${BASE}/crm/v3/objects/deals/${app.hubspotDealId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties: props }),
    });
    if (!res.ok) {
      const message = `commission write failed (${res.status}): ${await res.text()}`;
      console.error(`[commission] ${app.id}: HubSpot deal ${app.hubspotDealId} ${message}`);
      await recordCommissionSyncError(app, message);
    }
  } catch (err) {
    const message = `commission write threw: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[commission] ${app.id}: ${message}`);
    await recordCommissionSyncError(app, message);
  }
}

/**
 * Best-effort, never throws — mirrors the deal-sync error write already in
 * `recordAcceptance` (acceptance.ts), same `hubspotIds.lastSyncError` /
 * `lastSyncErrorAt` convention. A commission-write failure and a deal-sync
 * failure CAN overwrite each other's message if both happen in the same
 * acceptance pass (last write wins) — accepted as the same best-effort,
 * overwrite-last-wins posture the rest of this codebase's sync-error
 * reporting already has (e.g. repeated cron passes over the same row).
 */
async function recordCommissionSyncError(app: MerchantApplication, message: string): Promise<void> {
  try {
    await db.update(merchantApplications)
      .set({
        hubspotIds: { ...app.hubspotIds!, lastSyncError: message, lastSyncErrorAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(merchantApplications.id, app.id));
  } catch (writeErr) {
    console.error(
      `[commission] ${app.id}: could not persist the commission sync error`,
      writeErr instanceof Error ? writeErr.message : writeErr
    );
  }
}

/**
 * What WOULD be written, given a `saas_revenue` already in hand — split out
 * so it's testable without a HubSpot token or a live fetch. NOT a public
 * replacement for the GET above: callers (including tests) must still get
 * `saas_revenue` from somewhere real before calling this, same as
 * `writeCommissionToDeal` itself does.
 */
export function commissionWritebackProperties(app: MerchantApplication, saasRevenue: number): Record<string, string> {
  const processingArr = paymentProcessingArrBreakdown(app).arr;
  const totalArr = sumArrOrNull(processingArr, saasRevenue);
  const { signingCommission, activationCommission } = commissionFromTotalArr(totalArr);
  const props: Record<string, string> = {};
  if (signingCommission !== null) props.signing_commission = String(signingCommission);
  if (activationCommission !== null) props.activation_commission = String(activationCommission);
  return props;
}
