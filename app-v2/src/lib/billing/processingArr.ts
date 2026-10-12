// What AIO expects to earn from this merchant's card processing in a year —
// the figure HubSpot's deal carries as `payment_processing_arr`, and which
// `total_arr` sums with `saas_revenue` (a HubSpot-side calculation; EasyOB
// writes neither of the other two).
//
// Product owner, 2026-10-12: "when quote is confirmed payment_processing_arr
// in hs = margin x monthly volume x 12. not needed for marketing only."
//
// Three things are deliberate:
//
//   * It is written at ACCEPTANCE, not at publish. A quote nobody pays for
//     would otherwise leave a forecast on the deal that nothing ever clears,
//     and acceptance is the one moment EasyOB genuinely observes (see
//     lib/billing/acceptance.ts — it is detected from the subscription, not
//     asserted by a button).
//   * The margin is the TRUE one, `derivePricing`'s `appliedTargetMargin`:
//     what the quoted rates actually leave over interchange, computed from
//     the same tables every other internal figure uses. Not the padded one a
//     rep sees — this is AIO's own forecast of AIO's own revenue, on a CRM
//     record reps already read, and padding it would make the number wrong
//     rather than make a secret safe. The secret is the FLOOR, which is not
//     derivable from this: a margin tells you what this deal earns, never
//     what the minimum profitable one would have been.
//   * Marketing-only quotes return null. They process nothing, so there is no
//     processing margin — and a 0 written to the property would read as a
//     measured zero rather than "not applicable", which is the same reason
//     `monthly_card_volume` is deliberately never read.

import { derivePricing } from "@/lib/pricing";
import { analysisFromQuoteConfig } from "@/lib/pricing";
import { isProcessingQuote, quoteTypeOf } from "@/lib/quoting";
import type { MerchantApplication } from "@/types/merchant";

/**
 * Annual AIO processing revenue for this application, or null when there
 * isn't one to state — a marketing-only quote, or a processing quote with no
 * volume behind it yet.
 *
 * Note that `appliedTargetMargin × volume` is `aioRevenue` by construction
 * (derivePricing defines the 2-tier margin as `aioRevenue / volume`), so this
 * is the annualised projected revenue over interchange. It is written the way
 * the product owner stated it rather than as `aioRevenue × 12` so the formula
 * on the deal matches the sentence that asked for it.
 */
export function paymentProcessingArr(app: MerchantApplication): number | null {
  if (!isProcessingQuote(quoteTypeOf(app.quoteType))) return null;

  const analysis =
    app.analysis ??
    (app.quoteConfig && app.quoteConfig.monthlyVolume > 0 && app.quoteConfig.avgTicket > 0
      ? analysisFromQuoteConfig(app.quoteConfig)
      : null);
  if (!analysis) return null;

  const volume = analysis.totalVolume || 0;
  if (!(volume > 0)) return null;

  const pricing = derivePricing(
    analysis,
    app.quoteRates,
    app.pricingModel || "2-tier",
    { monthlyFee: 0, perTxnFee: 0, cpPerTxnFee: 0, cnpPerTxnFee: 0 }
  );

  const arr = pricing.appliedTargetMargin * volume * 12;
  if (!Number.isFinite(arr) || arr <= 0) return null;
  return Math.round(arr);
}
