"use client";

import { useEffect, useState } from "react";
import { getSuggestedRatesAction, type RateSuggestion as Suggestion } from "@/lib/actions/rateMatrix";
import type { QuoteRates } from "@/types/merchant";
import styles from "./RateSuggestion.module.css";

/**
 * What AIO's rate card says to quote this merchant, given their volume and
 * average ticket — applied automatically wherever this renders.
 *
 * ALWAYS APPLIES as of 2026-10-13 ("get rid of the 'use it' and make it
 * always override") — this reverses both of the gates that used to exist
 * here: the `autoApply` prop (previously true only on the two surfaces that
 * START a quote) and the "untouched at the flat default" check. The product
 * owner wants the card's rate to win outright, including on `EditQuotePanel`,
 * which used to opt out on the reasoning that "these rates were already
 * chosen and saved" — see that file's own comment for what the reversal
 * means there: reopening a saved quote can now change its rates. A
 * PUBLISHED or ACCEPTED quote never reaches this code at all —
 * `EditQuotePanel` returns its frozen notice before mounting this component
 * or any other rate control, so the one-way-door rule on a published HubSpot
 * quote still holds; this component has no way to write through that freeze.
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
};

const sameRates = (a: QuoteRates, b: QuoteRates) =>
  a.cardPresentRate === b.cardPresentRate &&
  a.cardNotPresentRate === b.cardNotPresentRate &&
  a.amexCardPresentRate === b.amexCardPresentRate &&
  a.amexCardNotPresentRate === b.amexCardNotPresentRate &&
  a.perTransactionFee === b.perTransactionFee;

const pct = (fraction: number) => (fraction * 100).toFixed(2);

export default function RateSuggestion({
  monthlyVolume, avgTicket, value, onChange,
}: RateSuggestionProps) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  useEffect(() => {
    if (!(monthlyVolume > 0) || !(avgTicket > 0)) { setSuggestion(null); return; }
    let cancelled = false;
    const handle = setTimeout(() => {
      getSuggestedRatesAction({ monthlyVolume, avgTicket })
        .then(s => { if (!cancelled) setSuggestion(s); })
        // A card that can't be fetched leaves the rep on whatever rates are
        // already in the boxes. Never a blocker: nothing here is a
        // precondition for quoting.
        .catch(() => { if (!cancelled) setSuggestion(null); });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [monthlyVolume, avgTicket]);

  useEffect(() => {
    if (!suggestion) return;
    if (sameRates(value, suggestion.rates)) return;
    onChange(suggestion.rates);
    // `value` is read, not depended on: this fires when a SUGGESTION arrives
    // (a new volume/ticket basis, or the admin's rate card changing under a
    // reopened quote), not on every keystroke in a rate box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion]);

  if (!suggestion) return null;

  const { cardPresentRate, cardNotPresentRate, perTransactionFee } = suggestion.rates;

  return (
    <p className={styles.row} data-matches={true}>
      <span className={styles.text}>
        Rate card:{" "}
        <strong className={styles.rate}>
          {pct(cardPresentRate)}% in person · {pct(cardNotPresentRate)}% online · +${perTransactionFee.toFixed(2)}
        </strong>{" "}
        <span className={styles.basis}>
          for {suggestion.volumeBand} a month at a ${suggestion.ticketColumn}+ ticket
        </span>
      </span>
    </p>
  );
}
