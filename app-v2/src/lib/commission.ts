// Sales commission math (2026-10-13) — the product owner's "commissions
// calculator" / "immediatley work on payments stuff" item from the 10/13
// list, confirmed over several follow-up answers. Pure and dependency-light
// on purpose, same posture as quoting.ts and wholesale.ts: no DB, no
// HubSpot, nothing that isn't safe to import from a server action.
//
// TWO SEPARATE COMMISSION KINDS, and they must not be confused:
//
//   * PROCESSING commission — 10% of a deal's total ARR, split 5% at signing
//     and 5% at activation. This is NOT a new idea EasyOB is introducing: it
//     already exists, independently, on ~700 live HubSpot deals —
//     `signing_commission` and `activation_commission`, each 5% of
//     `total_arr` (a HubSpot-calculated property). This module's job is to
//     let EasyOB compute — and, behind a flag, write — the same two numbers
//     from data it already owns. `commissionFromTotalArr` is the whole of
//     it: a fixed split applied to an ARR figure the CALLER supplies. The ARR
//     itself is NOT computed here — see `sumArrOrNull` below,
//     lib/billing/processingArr.ts (payment_processing_arr; margin reused
//     verbatim, never recomputed), and `estimatedRecurringArrFromQuoteLines`
//     (this file's DISPLAY-ONLY estimate of HubSpot's `saas_revenue` — never
//     the basis for a HubSpot write; see that function's own doc comment and
//     lib/billing/commissionWriteback.ts, which reads HubSpot's real
//     `saas_revenue` instead because the two provably diverge).
//
//   * HARDWARE commission — a percentage of HARDWARE MARGIN (price minus
//     cost). The product owner asked for this on 10/13 but has not supplied
//     the rate, so it's admin-configurable (`commission_policy` table,
//     migration 0022) and starts NULL — "unset", which `hardwareCommission`
//     treats as "contributes exactly zero". Separately, and regardless of
//     the rate: EasyOB has NO hardware COST data today. The catalog
//     (`CatalogProduct`, read from HubSpot's product library via
//     `listProducts()` in adapters/hubspot.ts) carries id/name/price/type —
//     there is no cost field anywhere, not on the catalog, not on
//     `QuoteLine`, not in the database. So `hardwareCommission` takes a
//     margin figure as its first argument rather than deriving one, and
//     every call site in this codebase that could supply one today has
//     nothing real to put there (see the function's own doc comment for
//     what data would have to exist first). Do not invent a number here.
//
// Both rates are expressed in basis points, the same convention rateMatrix.ts
// and wholesale.ts use and for the same reason: every figure is a two-decimal
// percentage (5.00%, 10.00%) that is exact in bps and not in a float, feeding
// a number that pays people.

import { quoteTotals } from "@/lib/quoting";
import type { QuoteLine } from "@/types/merchant";

// ── Processing commission ───────────────────────────────────────────────────

// FIXED, not admin-configurable. This is the split HubSpot's own automation
// already applies to ~700 live deals (product owner, 2026-10-13) — not a new
// number EasyOB gets to choose. If that ever changes, it's a code change and a
// deliberate one, the same way a settings-table knob would still need someone
// to decide the new split; a constant at least makes "what HubSpot already
// does" and "what EasyOB computes" impossible to drift apart silently.
export const SIGNING_COMMISSION_BPS = 500; // 5.00%
export const ACTIVATION_COMMISSION_BPS = 500; // 5.00%

export type CommissionFromArr = {
  /** The ARR the split below was applied to, or null when there was none. */
  totalArr: number | null;
  signingCommission: number | null;
  activationCommission: number | null;
  /**
   * signingCommission + activationCommission — what the rep-facing UI shows
   * as a single "your commission" dollar figure (PricingStep.tsx,
   * EditQuotePanel.tsx, 2026-10-13: "the only thing to display... is the
   * margin, cuz thats how reps see their commission"). Null exactly when the
   * two halves are, never a mix.
   */
  total: number | null;
};

const NO_COMMISSION: CommissionFromArr = {
  totalArr: null, signingCommission: null, activationCommission: null, total: null,
};

/**
 * The 5%/5% split applied to an already-known total ARR. Omits rather than
 * zeroes when `totalArr` is null — same rule `payment_processing_arr` follows
 * (lib/billing/processingArr.ts): a 0 here would read as a measured zero
 * commission rather than "nothing to compute one from yet".
 */
export function commissionFromTotalArr(totalArr: number | null): CommissionFromArr {
  if (totalArr === null || !Number.isFinite(totalArr)) return NO_COMMISSION;
  const signingCommission = bpsOf(totalArr, SIGNING_COMMISSION_BPS);
  const activationCommission = bpsOf(totalArr, ACTIVATION_COMMISSION_BPS);
  return { totalArr, signingCommission, activationCommission, total: signingCommission + activationCommission };
}

function bpsOf(amount: number, bps: number): number {
  return Math.round(amount * (bps / 10000));
}

/**
 * Combines two ARR components into a total, used by BOTH the real writeback
 * (payment_processing_arr + HubSpot's own real `saas_revenue`, read live —
 * see commissionWriteback.ts) and the rep/admin DISPLAY estimate
 * (payment_processing_arr + `estimatedRecurringArrFromQuoteLines` below,
 * where no HubSpot read is available or wanted). Null+null is null
 * ("nothing to compute a commission from at all"); either alone passes
 * through unchanged; both sum. Never zeroes one side to force a number out of
 * the other, for the same "omit rather than zero" reason as everything else
 * in this file.
 */
export function sumArrOrNull(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * ESTIMATE ONLY — FOR DISPLAY, NEVER FOR A HUBSPOT WRITE. This is EasyOB's own
 * guess at HubSpot's `saas_revenue`: the annualised value of this quote's
 * RECURRING lines (the platform fee, and any recurring hardware/software
 * line), built from `QuoteLine`s EasyOB already has verbatim rather than read
 * back from HubSpot. `quoteTotals` already does the "group by billing cycle,
 * normalize to monthly" work (quoting.ts); this just annualises the
 * monthly-equivalent side of it and leaves the one-time (hardware sale) side
 * out, because `saas_revenue` is a recurring-revenue concept, not a
 * one-time-sale one.
 *
 * PROVEN to diverge from HubSpot's real figure, not just "not guaranteed to
 * match": a live deal with a $399/mo platform line carries
 * `saas_revenue: 4788.50` (399 × 12, PLUS the $0.50 pre-auth line), where this
 * function returns 4788.00 flat — off by the pre-auth on the simplest
 * possible quote, and mixed-billing-frequency quotes have more room to drift.
 * `commissionWriteback.ts` does NOT use this: it reads HubSpot's own
 * `saas_revenue` live, at write time, because a commission that isn't 5% of
 * the ARR printed next to it on the same deal is a dispute waiting to happen.
 * This function exists only for the rep-facing "your commission" preview and
 * the admin commissions panel, where no live HubSpot read is available (the
 * rep hasn't saved a deal yet) or wanted (the admin panel lists every deal in
 * one query), and an approximation — clearly labelled as one — is good enough.
 */
export function estimatedRecurringArrFromQuoteLines(lines: QuoteLine[]): number | null {
  if (!lines || lines.length === 0) return null;
  const arr = Math.round(quoteTotals(lines).monthlyEquivalent * 12);
  return arr > 0 ? arr : null;
}

// ── Hardware commission ─────────────────────────────────────────────────────

export type HardwareCommissionPolicy = {
  /** null = unset = this module contributes exactly zero. Set by an admin at
   *  the Commissions tab (/admin, ?view=commissions) once the product owner
   *  gives a number — see commission_policy in schema.ts. */
  hardwareCommissionBps: number | null;
};

export const DEFAULT_HARDWARE_COMMISSION_POLICY: HardwareCommissionPolicy = {
  hardwareCommissionBps: null,
};

/**
 * `hardwareMargin` is HARDWARE REVENUE MINUS HARDWARE COST for whatever
 * hardware this figure is being computed over — and EasyOB cannot supply a
 * real one today. `CatalogProduct` (adapters/hubspot.ts, fed by
 * `listProducts()`) carries only what HubSpot's product library exposes: id,
 * name, price, type. There is no cost field anywhere — not on the catalog,
 * not on `QuoteLine`, not in the database. So every call site in this
 * codebase passes a literal 0 here today (see
 * lib/billing/commissionReport.ts), and this function returns 0 for all of
 * them regardless of the configured rate, via the policy gate below.
 *
 * To make this genuinely computable (not just "wired but inert"), AIO would
 * need a per-product COST figure from somewhere — e.g. a `cost` property
 * added to the HubSpot product library and read into `CatalogProduct`, or a
 * separate admin-maintained cost table keyed by `hubspotProductId` the way
 * `commission_policy` / `quote_limit_policy` already key other per-product
 * settings. Until one of those exists, this is a formula with a half-missing
 * input, kept pure and tested so wiring it up later is one call-site change
 * rather than a new function.
 */
export function hardwareCommission(hardwareMargin: number, policy: HardwareCommissionPolicy): number {
  if (policy.hardwareCommissionBps == null) return 0;
  return hardwareMargin * (policy.hardwareCommissionBps / 10000);
}
