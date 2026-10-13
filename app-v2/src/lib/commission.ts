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

import { lineNetAmount, quoteTotals } from "@/lib/quoting";
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

// ── Hardware commission (SUPERSEDED — see "Per-product hardware commission"
//    below) ───────────────────────────────────────────────────────────────
//
// SUPERSEDED 2026-10-13. This section predates the discovery that HubSpot's
// product library already carries per-product `cost_to_rep`/`rep_commission`/
// `rsm_commission` (see CatalogProduct in types/merchant.ts and the
// per-product functions at the bottom of this file). A single admin-typed
// global bps rate applied to a margin nobody could compute was always a
// placeholder for the real, per-product design below — not a feature to keep
// alongside it. Kept, not deleted: `commission_policy` (migration 0022) still
// exists with no rows and no UI, and `lib/billing/commissionReport.ts` still
// calls `hardwareCommission` — that call site is owned by another agent and
// will switch to `quoteHardwareCommission` separately. Don't build new
// callers against this; it is dead-end math (no cost data ever reaches it).

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

// ── Per-product hardware commission (2026-10-13) ────────────────────────────
//
// Replaces the global-rate design above. HubSpot's product library carries
// real per-product inputs — `cost_to_rep` ("AE Cost"), `rep_commission` and
// `rsm_commission` (both PERCENTAGES) — read into `CatalogProduct` and
// snapshotted onto `QuoteLine` at `toQuoteLine` time (see both types'
// doc comments in types/merchant.ts). This section is the math over those
// snapshotted fields. As of 2026-10-13 every rate is null and 8 populated
// costs are all 0, so every real quote computes to "no commissions yet" —
// that is the correct, expected state until Elizabeth uploads real values,
// not a bug.
//
// Formula (product owner, verbatim, 2026-10-13):
//   rep commission for a line = ((qty * price after discount) - (qty * AE
//     Cost)) * Rep Commission %
//   rsm commission = same, with RSM Commission %
//
// Three rules, all explicit product-owner decisions — do not revisit:
//   1. ONE-TIME LINES ONLY. Both HubSpot deal properties this feeds are
//      labelled "Rep/RSM HARDWARE Commission", and mixing a monthly
//      "price after discount" into one-time hardware dollars mixes units
//      (the same reason quoteTotals keeps one-time and recurring separate).
//      A recurring line that nonetheless carries a commission rate is
//      reported via `recurringWithRate`, never silently included or dropped.
//   2. NEGATIVE IS INTENDED, NEVER CLAMPED. A package-covered line sits at
//      100% off, so `netAmount - cost*qty` is negative by construction — "this
//      can go negative" (product owner, 10/13). Don't add a Math.max(0, ...)
//      anywhere in this section.
//   3. null IS NOT 0. A line contributes a commission only when BOTH its cost
//      and its rate are non-null — a missing cost means "nobody has told us
//      yet", and treating it as 0 would pay commission on the full sale
//      price. Lines missing a cost are reported via `missingCost`. A LITERAL
//      0 (a real, known zero cost) is honoured and does participate.

/**
 * HubSpot's "Rep Commission %"/"RSM Commission %" product properties store a
 * plain percentage (e.g. a product owner entering "6" means 6%). This
 * function is the ONE place that percent is converted to the basis-points
 * unit the rest of this codebase's commission math uses (rateMatrix.ts,
 * wholesale.ts, and SIGNING/ACTIVATION_COMMISSION_BPS above) — flip it here
 * if that reading turns out wrong.
 *
 * ASSUMPTION TO CONFIRM WITH THE PRODUCT OWNER WHEN REAL VALUES LAND: every
 * `rep_commission`/`rsm_commission` row in the portal is null today (2026-10-13,
 * 0 of 39 active products populated), so this reading is UNVERIFIED against
 * real data. It is deliberately isolated to one named, exported, tested
 * function so correcting it later (e.g. if HubSpot actually stores "0.06" for
 * 6%) is a one-line change rather than a hunt through call sites.
 */
export function percentToBps(percent: number | null): number | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  return Math.round(percent * 100);
}

/** One line's rep/rsm hardware commission, or the reason it didn't produce one. */
export type LineHardwareCommission = {
  hubspotProductId: string;
  name: string;
  rep: number | null;
  rsm: number | null;
};

/**
 * The commission formula for a single line. Returns null for both figures —
 * never 0 — when the line is excluded (not one-time) or missing an input
 * (cost or rate null); `quoteHardwareCommission` below is what turns those
 * exclusions into the reportable warning lists, since a single line can't
 * report anything about itself other than its own two numbers.
 *
 * SURFACING HAZARD, accepted knowingly by the product owner (2026-10-13): the
 * rep-facing UI shows `rep` on this line. A rep who already knows their own
 * `repCommissionBps` can invert the formula — cost = netAmount -
 * rep/rateDecimal — to recover AIO's exact per-unit hardware cost. This is
 * NOT treated as secret the way the true margin floor is
 * (`derivePricingForRole`); nobody asked for it to be hidden, but don't
 * later assume it is, because it visibly is not.
 */
export function lineHardwareCommission(line: QuoteLine): LineHardwareCommission {
  const base: Pick<LineHardwareCommission, "hubspotProductId" | "name"> = {
    hubspotProductId: line.hubspotProductId,
    name: line.name,
  };

  if (line.billingFrequency !== "one_time") return { ...base, rep: null, rsm: null };

  const cost = line.costToRep ?? null;
  if (cost === null) return { ...base, rep: null, rsm: null };

  const marginTotal = lineNetAmount(line) - cost * line.qty;
  const repBps = line.repCommissionBps ?? null;
  const rsmBps = line.rsmCommissionBps ?? null;

  return {
    ...base,
    rep: repBps === null ? null : marginTotal * (repBps / 10000),
    rsm: rsmBps === null ? null : marginTotal * (rsmBps / 10000),
  };
}

/** Totals + per-line detail + warnings over a whole quote's lines. */
export type QuoteHardwareCommission = {
  /** Sum of every line's non-null rep commission. 0 when nothing qualified. */
  rep: number;
  /** Sum of every line's non-null rsm commission. 0 when nothing qualified. */
  rsm: number;
  perLine: LineHardwareCommission[];
  /** Names of one-time lines with cost or rate missing (no commission computed). */
  missingCost: string[];
  /** Names of RECURRING lines that nonetheless carry a commission rate — excluded, flagged. */
  recurringWithRate: string[];
};

/**
 * The quote-level rollup `lib/billing/commissionReport.ts` and any rep/admin
 * UI should build on going forward — see the SUPERSEDED note on
 * `hardwareCommission` above for why the old global-rate function is not it.
 */
export function quoteHardwareCommission(lines: QuoteLine[]): QuoteHardwareCommission {
  const perLine: LineHardwareCommission[] = [];
  const missingCost: string[] = [];
  const recurringWithRate: string[] = [];
  let rep = 0;
  let rsm = 0;

  for (const line of lines) {
    if (line.billingFrequency !== "one_time") {
      const hasRate = line.repCommissionBps != null || line.rsmCommissionBps != null;
      if (hasRate) recurringWithRate.push(line.name);
      continue;
    }

    // Literally "cost is missing" — not gated on a rate being set too, since
    // 0/39 products carry a rate today and gating this on "AND a rate exists"
    // would make the warning useless until rates are populated. A line with
    // a cost but no rate contributes nothing either (see lineHardwareCommission),
    // which is visible in `perLine` (rep/rsm both null) without a separate list.
    if (line.costToRep == null) missingCost.push(line.name);

    const result = lineHardwareCommission(line);
    perLine.push(result);
    rep += result.rep ?? 0;
    rsm += result.rsm ?? 0;
  }

  return { rep, rsm, perLine, missingCost, recurringWithRate };
}
