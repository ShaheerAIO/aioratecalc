// What AIO expects to earn from this merchant's card processing in a year —
// the figure HubSpot's deal carries as `payment_processing_arr`, and which
// `total_arr` sums with `saas_revenue` (a HubSpot-side calculation; EasyOB
// writes neither of the other two).
//
// Product owner, 2026-10-12: "when quote is confirmed payment_processing_arr
// in hs = margin x monthly volume x 12. not needed for marketing only."
//
// 2026-10-13: the product owner supplied the exact margin definition this
// writes (notes.md, "commissions calculator" / "immediatley work on payments
// stuff") — Total Take Rate minus a ticket-indexed Wholesale %, built in
// `lib/wholesale.ts`. This REPLACES the margin this file used to use
// (`derivePricing`'s `appliedTargetMargin`, revenue over interchange). It is
// a DIFFERENT NUMBER, not a refinement of the old one — see wholesale.ts's
// module comment for why they're named apart, and this file's own comment
// further down for how far apart they actually come out on real data.
// `derivePricing` and `getMarginFloor`/`belowMarginFloor` (pricing.ts) are
// UNTOUCHED: that margin still gates `marginFloorBlockers`'s hard refusal,
// and swapping its definition would silently change which quotes can be
// refused. This file now imports neither.
//
// Three things are deliberate:
//
//   * It is written at PUBLISH (product owner, 2026-10-30 — was acceptance),
//     re-written at acceptance, and kept true by the nightly billing sync
//     (`planProcessingArrWrites` below), so a deal whose write was skipped or
//     failed still gets it. A quote nobody pays for leaves its forecast on
//     the deal — accepted knowingly.
//   * The margin is AIO's own forecast of AIO's own revenue, on a CRM
//     record reps already read — padding it would make the number wrong
//     rather than make a secret safe. (The TRUE margin floor stays a
//     separate, never-exposed secret in pricing.ts; see above.)
//   * Marketing-only quotes return null. They process nothing, so there is no
//     processing margin — and a 0 written to the property would read as a
//     measured zero rather than "not applicable", which is the same reason
//     `monthly_card_volume` is deliberately never read.
//   * An IMPLAUSIBLE quoted rate also returns null, not an annualised typo.
//     This figure feeds HubSpot's `total_arr`, and `total_arr` is the base
//     for `signing_commission`/`activation_commission` (each 5% of it,
//     confirmed live across ~700 deals) — so a rep's decimal-point slip
//     ("20.00% instead of 2.0%", Elizabeth's own example from the 10/9
//     notes) doesn't just misreport a forecast, it PAYS a commission
//     computed off the mistake. `MAX_PLAUSIBLE_CARD_RATE` (types/merchant.ts)
//     already exists as exactly this sanity bound on a typed rate — reused
//     here rather than inventing a second, margin-specific threshold. Same
//     posture as the no-volume/marketing-only cases above: omit rather than
//     write a wrong number.

import { analysisFromQuoteConfig, ratesFor } from "@/lib/pricing";
import { isProcessingQuote, quoteTypeOf } from "@/lib/quoting";
import { totalRevenue, totalTakeRate, wholesalePctFor } from "@/lib/wholesale";
import { averageTicketOf, MAX_PLAUSIBLE_CARD_RATE, type MerchantApplication, type QuoteRates } from "@/types/merchant";

// The inputs behind the number, for anything that needs to show its work —
// in particular scripts/backfill-processing-arr.ts, which is read by a human
// before an `--apply` touches ~700 live production deals. A bare dollar
// figure doesn't let anyone tell a real merchant from a fat-fingered test
// row (a $14M/year volume on a test account looks the same as a real one
// until you see the inputs), so the breakdown is a first-class return value
// here rather than something re-derived ad hoc in the script.
export type ProcessingArrBreakdown = {
  arr: number | null;
  // Which figure the volume/ticket came from — a real statement always wins
  // (see `prefers a real statement over the rep's typed figures` below).
  // "none" means there was nothing to derive an analysis from at all.
  source: "analysis" | "quoteConfig" | "none";
  monthlyVolume: number | null;
  avgTicket: number | null;
  // Total Revenue ÷ Monthly Volume — wholesale.ts's `totalTakeRate`, off the
  // single blended CP rate and flat per-transaction fee this merchant was
  // quoted. NOT derivePricing's appliedTargetMargin — see the module comment.
  takeRate: number | null;
  // The wholesale % this avgTicket read off the product owner's 10/13 table
  // (wholesale.ts's `wholesalePctFor`) — the OTHER half of `commissionMargin`,
  // so a human reviewing the backfill plan sees both inputs, not just the
  // difference between them.
  wholesalePct: number | null;
  // takeRate − wholesalePct — this IS the margin `arr` is built from
  // (`commissionMargin × monthlyVolume × 12`). Can be negative; negative
  // margin still reports here even though it yields no `arr` (see below).
  commissionMargin: number | null;
  // Populated ONLY when `arr` is null because a quoted rate exceeded
  // `MAX_PLAUSIBLE_CARD_RATE` — the offending rate itself, so a human (or the
  // backfill script) sees the number that needs fixing rather than a plain
  // absence indistinguishable from "marketing-only" or "no volume yet".
  implausibleRate: number | null;
};

const NO_ARR: ProcessingArrBreakdown = {
  arr: null, source: "none", monthlyVolume: null, avgTicket: null,
  takeRate: null, wholesalePct: null, commissionMargin: null, implausibleRate: null,
};

// The highest of the four percentage rate fields on a quote — `MAX_PLAUSIBLE_CARD_RATE`
// is a ceiling on a TYPED RATE, not on a resulting margin, so this checks the
// inputs directly rather than the figure derivePricing comes out with.
// `perTransactionFee` is a flat dollar amount, not a percentage, and isn't
// comparable to this bound. Null `rates` means DEFAULT_QUOTE_RATES applies
// (2.49% across the board) — always within bounds, so nothing to check.
function maxQuotedRate(rates: QuoteRates | null | undefined): number | null {
  if (!rates) return null;
  return Math.max(rates.cardPresentRate, rates.cardNotPresentRate, rates.amexCardPresentRate, rates.amexCardNotPresentRate);
}

/**
 * Same inputs and same math as `paymentProcessingArr` below, but returns the
 * figures that went into the number instead of only the number itself.
 */
export function paymentProcessingArrBreakdown(app: MerchantApplication): ProcessingArrBreakdown {
  if (!isProcessingQuote(quoteTypeOf(app.quoteType))) return NO_ARR;

  const source: ProcessingArrBreakdown["source"] = app.analysis
    ? "analysis"
    : app.quoteConfig && app.quoteConfig.monthlyVolume > 0 && app.quoteConfig.avgTicket > 0
    ? "quoteConfig"
    : "none";

  const analysis = app.analysis ?? (source === "quoteConfig" ? analysisFromQuoteConfig(app.quoteConfig!) : null);
  if (!analysis) return NO_ARR;

  const volume = analysis.totalVolume || 0;
  if (!(volume > 0)) return { ...NO_ARR, source, monthlyVolume: volume };

  // `averageTicketOf` falls back to totalVolume/totalTransactions when a real
  // statement didn't itemize an average ticket directly — same helper the rep
  // UI already reads this off of (PricingStep, EditQuotePanel), reused here
  // rather than a third copy of "what's this merchant's ticket size".
  const avgTicket = averageTicketOf(analysis);
  const rates = ratesFor(app.quoteRates);

  const base = {
    source,
    monthlyVolume: volume,
    avgTicket: avgTicket || null,
    takeRate: null as number | null,
    wholesalePct: null as number | null,
    commissionMargin: null as number | null,
    implausibleRate: null as number | null,
  };

  // No ticket means no basis for either half of the new formula (the
  // per-transaction term in Total Revenue, or the Wholesale % lookup) — omit
  // rather than guess one, same posture as every other guard in this file.
  if (!(avgTicket > 0)) return { ...base, arr: null };

  const revenue = totalRevenue(rates.cardPresentRate, volume, avgTicket, rates.perTransactionFee);
  const takeRate = totalTakeRate(revenue, volume);
  const wholesalePct = wholesalePctFor(avgTicket);
  const margin = takeRate - wholesalePct;
  const withMargin = { ...base, takeRate, wholesalePct, commissionMargin: margin };

  // Checked BEFORE trusting the math: a quoted rate past the ceiling means
  // the inputs are wrong, not that the merchant is unusually profitable. The
  // rest of the breakdown (including the now-computed margin, however wrong
  // it looks) is still returned — it's exactly what shows a human WHY the
  // rate got flagged.
  const offendingRate = maxQuotedRate(app.quoteRates);
  if (offendingRate !== null && offendingRate > MAX_PLAUSIBLE_CARD_RATE) {
    return { ...withMargin, arr: null, implausibleRate: offendingRate };
  }

  const arr = margin * volume * 12;
  if (!Number.isFinite(arr) || arr <= 0) return { ...withMargin, arr: null };
  return { ...withMargin, arr: Math.round(arr) };
}

/**
 * Annual AIO processing revenue for this application, or null when there
 * isn't one to state — a marketing-only quote, or a processing quote with no
 * volume behind it yet.
 *
 * `commissionMargin × monthlyVolume × 12` — wholesale.ts's Total Take Rate
 * minus Wholesale %, annualised, written exactly the way the product owner
 * stated it ("margin x monthly volume x 12"). See the module comment at the
 * top of this file for why this is a DIFFERENT margin from derivePricing's
 * appliedTargetMargin, and not interchangeable with it.
 */
export function paymentProcessingArr(app: MerchantApplication): number | null {
  return paymentProcessingArrBreakdown(app).arr;
}

/**
 * Pure: which published deals need `payment_processing_arr` (re)written —
 * the nightly backstop behind the publish/acceptance writes. A deal is
 * written when HubSpot's value is missing or differs from ours; one we can't
 * compute a figure for (marketing-only, no volume) is left alone, never zeroed.
 */
export function planProcessingArrWrites(
  apps: MerchantApplication[],
  current: Map<string, string | null>,
): Array<{ id: string; properties: { payment_processing_arr: string } }> {
  const writes: Array<{ id: string; properties: { payment_processing_arr: string } }> = [];
  for (const app of apps) {
    const dealId = app.hubspotDealId;
    if (!dealId || !app.hubspotIds?.publishedAt) continue;
    const arr = paymentProcessingArr(app);
    if (arr === null) continue;
    const onDeal = current.get(dealId);
    if (onDeal != null && onDeal !== "" && Number(onDeal) === arr) continue;
    writes.push({ id: dealId, properties: { payment_processing_arr: String(arr) } });
  }
  return writes;
}
