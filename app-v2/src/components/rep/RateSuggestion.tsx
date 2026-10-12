"use client";

import { useEffect, useRef, useState } from "react";
import { getSuggestedRatesAction, type RateSuggestion as Suggestion } from "@/lib/actions/rateMatrix";
import { DEFAULT_QUOTE_RATES, type QuoteRates } from "@/types/merchant";
import styles from "./RateSuggestion.module.css";

/**
 * What AIO's rate card says to quote this merchant, given their volume and
 * average ticket — and a one-click way to take it.
 *
 * A SUGGESTION, never an authority. The rate the rep ends up with is still
 * whatever is in the boxes, still checked against the margin floor
 * server-side, and still the thing the quote is built from. This only ever
 * puts a number in front of them.
 *
 * It fetches rather than computing, for two reasons: the live card is in
 * Postgres, and importing the lookup here would be the first step toward the
 * margin tables following it into a client bundle (the standing rule behind
 * `getPricingPreviewAction` and `SELECTABLE_PRICING_MODELS` living in
 * types/merchant.ts).
 */
export type RateSuggestionProps = {
  /** Null, or either figure at zero, means there is nothing to look a rate up on. */
  monthlyVolume: number;
  avgTicket: number;
  value: QuoteRates;
  onChange: (next: QuoteRates) => void;
  /**
   * Whether to apply the suggestion by itself while the rep hasn't touched
   * the rates.
   *
   * TRUE on the two surfaces that START a quote, where the rates are still
   * the flat standard default and nobody has chosen them. FALSE when
   * reopening a SAVED quote: those rates are a decision someone already made,
   * and a saved quote that happens to sit at the standard rate must not
   * change because an admin edited the rate card and a rep opened the panel.
   */
  autoApply?: boolean;
};

const sameRates = (a: QuoteRates, b: QuoteRates) =>
  a.cardPresentRate === b.cardPresentRate &&
  a.cardNotPresentRate === b.cardNotPresentRate &&
  a.amexCardPresentRate === b.amexCardPresentRate &&
  a.amexCardNotPresentRate === b.amexCardNotPresentRate &&
  a.perTransactionFee === b.perTransactionFee;

const pct = (fraction: number) => (fraction * 100).toFixed(2);

export default function RateSuggestion({
  monthlyVolume, avgTicket, value, onChange, autoApply,
}: RateSuggestionProps) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  // The last rates this component put in the boxes itself. Auto-apply only
  // ever overwrites the flat default or its OWN previous suggestion — the two
  // states that mean "nobody has chosen these". Anything else is a rate a rep
  // typed, and it is never touched.
  //
  // This replaced a one-shot-per-mount guard, which was too blunt: a rep who
  // drops a statement after typing a volume has their volume and ticket
  // replaced by the statement's, and the rate has to follow, or the quote
  // goes out priced for the merchant they guessed at rather than the one on
  // the page.
  const lastApplied = useRef<QuoteRates | null>(null);

  useEffect(() => {
    if (!(monthlyVolume > 0) || !(avgTicket > 0)) { setSuggestion(null); return; }
    let cancelled = false;
    const handle = setTimeout(() => {
      getSuggestedRatesAction({ monthlyVolume, avgTicket })
        .then(s => { if (!cancelled) setSuggestion(s); })
        // A card that can't be fetched leaves the rep on the standard rate,
        // which is exactly where they were before this existed. Never a
        // blocker: nothing here is a precondition for quoting.
        .catch(() => { if (!cancelled) setSuggestion(null); });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [monthlyVolume, avgTicket]);

  useEffect(() => {
    if (!autoApply || !suggestion) return;
    const untouched =
      sameRates(value, DEFAULT_QUOTE_RATES) ||
      (lastApplied.current !== null && sameRates(value, lastApplied.current));
    if (!untouched) return;
    if (sameRates(value, suggestion.rates)) return;
    lastApplied.current = suggestion.rates;
    onChange(suggestion.rates);
    // `value` is read, not depended on: this fires when a SUGGESTION arrives.
    // Depending on it would re-run on every keystroke in a rate box, and the
    // `untouched` test above is what decides whether to act, not the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion, autoApply]);

  if (!suggestion) return null;

  const matches = sameRates(value, suggestion.rates);
  const { cardPresentRate, cardNotPresentRate, perTransactionFee } = suggestion.rates;

  return (
    <p className={styles.row} data-matches={matches || undefined}>
      <span className={styles.text}>
        {matches ? "Rate card: " : "Rate card says "}
        <strong className={styles.rate}>
          {pct(cardPresentRate)}% in person · {pct(cardNotPresentRate)}% online · +${perTransactionFee.toFixed(2)}
        </strong>{" "}
        <span className={styles.basis}>
          for {suggestion.volumeBand} a month at a ${suggestion.ticketColumn}+ ticket
        </span>
      </span>
      {!matches && (
        <button type="button" className={styles.apply} onClick={() => onChange(suggestion.rates)}>
          Use it
        </button>
      )}
    </p>
  );
}
