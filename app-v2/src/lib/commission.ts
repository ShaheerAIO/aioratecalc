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

import {
  INCLUDED_SERVICE_PRODUCTS, isCompedService, isPreAuthProduct, lineNetAmount,
  PROCESSING_DISCLOSURE_PRODUCT, quoteTotals,
} from "@/lib/quoting";
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
// `rsm_commission` (both RATES) — read into `CatalogProduct` and
// snapshotted onto `QuoteLine` at `toQuoteLine` time (see both types'
// doc comments in types/merchant.ts). This section is the math over those
// snapshotted fields. THE DATA LANDED 2026-10-14: 26 of 39 active products
// carry a real cost and a real rate, so these figures are now live money
// rather than the "everything computes to null" placeholder state this
// section shipped in.
//
// Formula (product owner, verbatim, 2026-10-13):
//   rep commission for a line = ((qty * price after discount) - (qty * AE
//     Cost)) * Rep Commission %
//   rsm commission = same, with RSM Commission %
//
// Four rules, all explicit product-owner decisions — do not revisit:
//   1. ONE-TIME LINES ONLY. Both HubSpot deal properties this feeds are
//      labelled "Rep/RSM HARDWARE Commission", and mixing a monthly
//      "price after discount" into one-time hardware dollars mixes units
//      (the same reason quoteTotals keeps one-time and recurring separate).
//      A recurring line that nonetheless carries a commission rate is
//      reported via `recurringWithRate`, never silently included or dropped.
//      Every monthly platform product now carries a rate, so this list is no
//      longer the near-empty curiosity it was when it was written.
//   2. HARDWARE AIO COMPS BY POLICY EARNS NOTHING — NOT A NEGATIVE
//      (product owner, 2026-10-14). See `isPolicyComped`. This NARROWS, and
//      does not cancel, the 10/13 "this can go negative, never clamp it"
//      rule: a discount the REP chooses still eats into their own commission
//      and still goes negative, which is exactly what `cost_to_rep`'s own
//      HubSpot description ("Minimum Price rep can discount to before eating
//      into commissions") says it means. What changed is that real cost data
//      made the untargeted version absurd — a QSR Kit quote, whose nine
//      in-plan lines sit at 100% off by AIO's own decision, showed the AE
//      −$1,635.90, and the comped Install + Training pair alone put −$674.10
//      on EVERY quote. Still no Math.max(0, …) on HARDWARE.
//      NARROWED FURTHER 2026-10-28 (product owner: "cant get negative
//      commission off discounting the onboarding and installation"): the two
//      SERVICE lines (Onsite Installation, System Onboarding and Training)
//      are floored at 0 per line for rep and rsm, so a rep discounting them
//      below cost costs nothing off their commission. Hardware still goes
//      negative.
//   3. null IS NOT 0. A line contributes a commission only when BOTH its cost
//      and its rate are non-null — a missing cost means "nobody has told us
//      yet", and treating it as 0 would pay commission on the full sale
//      price. Lines missing a cost are reported via `missingCost`. A LITERAL
//      0 (a real, known zero cost) is honoured and does participate.
//   4. A line's `status` says WHICH of those it was, because "no figure" has
//      four different meanings and an AE reading a quote needs to tell "AIO
//      gives this away" from "nobody has entered a cost for the POS Unit".

/**
 * HubSpot's "Rep Commission %"/"RSM Commission %" product properties store the
 * rate as a DECIMAL FRACTION — 0.6 is 60%, not 0.6% — so this converts by
 * ×10000, not ×100. It is the ONE place that conversion happens, feeding the
 * basis-points unit the rest of this codebase's commission math uses
 * (rateMatrix.ts, wholesale.ts, SIGNING/ACTIVATION_COMMISSION_BPS above).
 *
 * CONFIRMED BY THE PRODUCT OWNER 2026-10-14, reversing the "plain percentage"
 * reading this function shipped with — which would have paid an AE $4.53 on a
 * Mega Kiosk instead of $453.00. The portal cannot settle this by itself and
 * two things in it actively argue for the wrong answer: the properties are
 * LABELLED "Rep Commission %" and carry HubSpot's `numberDisplayHint:
 * percentage`, so the CRM renders the stored 0.6 as "0.6%". What settles it is
 * the shape of the data — hardware at 0.6/0.1 against Onsite Installation and
 * Training at 0.45/0.05 is a deliberate 70%/50% split of hardware margin
 * between AE, RSM and AIO, where the literal reading makes it a $5-vs-$3
 * difference nobody would configure — plus `cost_to_rep`'s own description
 * ("Minimum Price rep can discount to before eating into commissions"), which
 * only means anything if the commission is a material share of that margin.
 * No deal in the portal carried a computed `rep_commission` to check against.
 */
export function commissionRateToBps(rate: number | null): number | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return Math.round(rate * 10000);
}

/**
 * Hardware AIO itself gives away: a package/plan-covered line, or one of the
 * policy-comped services (Onsite Installation, System Onboarding and
 * Training) sitting at exactly $0. These earn NO commission — see rule 2
 * above. Deliberately judged on the line as BUILT rather than on the
 * adjustments that produced it, because that is the one representation both
 * the configurator and a saved quote share; `coveredByPackage` is set only by
 * `decomposePackages` and the comped services only reach $0 through
 * `applyServiceComp`'s default, so neither can be forged by a rep edit.
 *
 * A rep's OWN discount is not policy and is not excluded here, even at 100%:
 * that is the case the never-clamp rule is for.
 */
export function isPolicyComped(line: QuoteLine): boolean {
  if (line.coveredByPackage) return true;
  return isCompedService(line) && lineNetAmount(line) === 0;
}

/**
 * A line that is not a sale at all: the $0 rate-disclosure line, which exists
 * to state this merchant's card rates on the document, and the $0.50 pre-auth,
 * which exists to clear HubSpot's checkout minimum. Both are derived and
 * untouchable — no rep put them on the quote and nobody could take them off.
 *
 * It matters that this is NOT `no_cost`. "No cost on file" is a live warning
 * that someone should go and price a product in HubSpot (POS Unit, mPOS and
 * both tablets genuinely are unpriced), and these two were landing in it —
 * printing "n/a" beside them on the quote and listing them in the admin panel
 * as data gaps to fix, when there is nothing to fix and never will be.
 */
export function isNotCommissionable(line: QuoteLine): boolean {
  return (
    line.hubspotProductId === PROCESSING_DISCLOSURE_PRODUCT.hubspotProductId ||
    isPreAuthProduct(line.hubspotProductId, line.name)
  );
}

/** Why a line produced the figure it did — or produced none. */
export type LineCommissionStatus =
  /** A real figure, from a real cost and at least one real rate. */
  | "computed"
  /** AIO comps it (in-plan, in-package, or a comped service) — earns nothing. */
  | "included"
  /** Never a sale — the rate disclosure and the pre-auth. See `isNotCommissionable`. */
  | "not_commissionable"
  /** Recurring: not hardware dollars. Carries a rate only by mistake. */
  | "recurring"
  /** One-time, but no "Cost to Rep" on file — unknown, not zero. */
  | "no_cost"
  /** Cost on file, but neither commission rate is set on the product. */
  | "no_rate";

/** One line's rep/rsm hardware commission, or the reason it didn't produce one. */
export type LineHardwareCommission = {
  hubspotProductId: string;
  name: string;
  rep: number | null;
  rsm: number | null;
  status: LineCommissionStatus;
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
// The FIRST KIOSK (QuoteLine.firstKiosk — at list, or discounted by the rep,
// up to 100%) pays a flat, lower rate than the product's own, and is floored
// at 0 like the service lines (product owner, 2026-10-29: "lower commission rate
// for the first kiosk, 45 & 5"; "discounting first kiosk does not remove
// commission"). One unit only: any other kiosks on the same line (a discount
// set across all of them) earn the product's own rates, unfloored, like any
// hardware.
export const FIRST_KIOSK_REP_BPS = 4500; // 45%
export const FIRST_KIOSK_RSM_BPS = 500; // 5%

export function lineHardwareCommission(line: QuoteLine): LineHardwareCommission {
  const none = (status: LineCommissionStatus): LineHardwareCommission => ({
    hubspotProductId: line.hubspotProductId,
    name: line.name,
    rep: null,
    rsm: null,
    status,
  });

  if (line.billingFrequency !== "one_time") return none("recurring");
  // Both before the cost check, so a line with no cost on file reads as "AIO
  // gives this away" / "this was never a sale" rather than as missing data
  // someone should go fix.
  if (isNotCommissionable(line)) return none("not_commissionable");
  if (isPolicyComped(line)) return none("included");

  const cost = line.costToRep ?? null;
  if (cost === null) return none("no_cost");

  const firstKiosk = line.firstKiosk === true;
  const repBps = line.repCommissionBps ?? null;
  const rsmBps = line.rsmCommissionBps ?? null;
  if (!firstKiosk && repBps === null && rsmBps === null) return none("no_rate");

  const marginTotal = lineNetAmount(line) - cost * line.qty;

  // Service lines (install/training) never go negative; hardware does.
  const floor = INCLUDED_SERVICE_PRODUCTS.some(s => s.hubspotProductId === line.hubspotProductId) ? 0 : -Infinity;
  const at = (margin: number, bps: number | null, min: number) =>
    bps === null ? null : Math.max(min, margin * (bps / 10000));

  if (firstKiosk) {
    // One unit's share of the margin at the flat rate, floored; the rest of
    // the line (0 when it is the usual single unit) at the product's own.
    const unit = marginTotal / line.qty;
    const rest = marginTotal - unit;
    return {
      hubspotProductId: line.hubspotProductId,
      name: line.name,
      rep: at(unit, FIRST_KIOSK_REP_BPS, 0)! + (at(rest, repBps, floor) ?? 0),
      rsm: at(unit, FIRST_KIOSK_RSM_BPS, 0)! + (at(rest, rsmBps, floor) ?? 0),
      status: "computed",
    };
  }

  return {
    hubspotProductId: line.hubspotProductId,
    name: line.name,
    rep: at(marginTotal, repBps, floor),
    rsm: at(marginTotal, rsmBps, floor),
    status: "computed",
  };
}

/** Totals + per-line detail + warnings over a whole quote's lines. */
export type QuoteHardwareCommission = {
  /** Sum of every line's non-null rep commission. 0 when nothing qualified. */
  rep: number;
  /** Sum of every line's non-null rsm commission. 0 when nothing qualified. */
  rsm: number;
  perLine: LineHardwareCommission[];
  /** Names of one-time, non-comped lines with no "Cost to Rep" on file. */
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

    const result = lineHardwareCommission(line);

    // "Somebody needs to fill a cost in", so comped lines are left out of it:
    // they earn nothing whatever their cost says, and listing them would send
    // an admin off to fix data that would change no figure on any quote.
    if (result.status === "no_cost") missingCost.push(line.name);

    perLine.push(result);
    rep += result.rep ?? 0;
    rsm += result.rsm ?? 0;
  }

  return { rep, rsm, perLine, missingCost, recurringWithRate };
}
