// AIO's STANDARD CARD: the flat rates a quote carries when a rep chooses not to
// price it off the rate matrix (product owner, 2026-11-11: "Allow a user to
// select a button for standard rates (this can be used for a new restaurant
// that doesn't have any volume yet)").
//
// Card-present is `DEFAULT_QUOTE_RATES`' flat 2.49% + $0.15, the same
// fallback every quote with no volume or ticket has always priced at.
// Card-not-present is NOT that constant's 2.49% placeholder but AIO's policy
// CNP (`getCnpPolicyRateAction` / `rate_matrix_policy.card_not_present_bps`,
// 3.30% by default), because any other CNP is an override an admin approves.
//
// Pure and dependency-free so the rep's client form (RateFields, prospect
// creation) and the server's validation (`createProspectAction`) agree on
// exactly one definition. It must never import pricing.ts: the client half
// would ship AIO's margin table with it.
import { DEFAULT_QUOTE_RATES, type QuoteRates } from "@/types/merchant";

const bps = (fraction: number) => Math.round(fraction * 10000);

/** The standard card, with `policyCnp` (a fraction) on both card-not-present lanes. */
export function standardQuoteRates(policyCnp: number): QuoteRates {
  const cp = DEFAULT_QUOTE_RATES.cardPresentRate;
  return {
    cardPresentRate: cp,
    amexCardPresentRate: cp,
    cardNotPresentRate: policyCnp,
    amexCardNotPresentRate: policyCnp,
    perTransactionFee: DEFAULT_QUOTE_RATES.perTransactionFee,
  };
}

/**
 * Whether `rates` IS the standard card, compared in whole bps (and cents for
 * the fee) so float noise from a typed box can't fail it. The AMEX lanes are
 * not compared: nothing reads them as a price any more (see `QuoteRates`).
 */
export function isStandardQuoteRates(rates: QuoteRates | null | undefined, policyCnp: number): boolean {
  if (!rates) return false;
  const std = standardQuoteRates(policyCnp);
  return bps(rates.cardPresentRate) === bps(std.cardPresentRate)
    && bps(rates.cardNotPresentRate) === bps(std.cardNotPresentRate)
    && Math.round(rates.perTransactionFee * 100) === Math.round(std.perTransactionFee * 100);
}
