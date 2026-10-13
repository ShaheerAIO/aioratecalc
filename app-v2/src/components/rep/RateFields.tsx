"use client";

import { useEffect, useRef, useState } from "react";
import { DecimalField } from "@/components/rep/NumberField";
import { getCnpPolicyRateAction } from "@/lib/actions/rateMatrix";
import { DEFAULT_QUOTE_RATES, MAX_PLAUSIBLE_CARD_RATE, type QuoteRates } from "@/types/merchant";
import styles from "./RateFields.module.css";

/**
 * The rates a 2-tier quote is priced on, as the merchant reads them off it.
 *
 * TWO rates, not four, as of 2026-10-13 ("get rid of the dual rate (amex)" —
 * reverses the 2026-10-06 "AMEX priced apart" decision). AMEX used to get its
 * own card-present/card-not-present pair because it settles at its own cost;
 * the product owner decided that distinction wasn't worth a rep reading four
 * boxes on a screen the merchant is often looking at, so AMEX volume now
 * prices at whatever the ordinary rate quotes (see `derivePricing` in
 * pricing.ts). `QuoteRates` still CARRIES `amexCardPresentRate`/
 * `amexCardNotPresentRate` — a row saved before today can have real,
 * divergent numbers in them and has to keep parsing, same pattern as
 * `StoredQuoteType`/`RETIRED_PLATFORM_PRODUCTS` — but nothing here reads or
 * writes them any more; see that field's own doc comment in types/merchant.ts.
 *
 * Card-not-present is LOCKED, also as of 2026-10-13 ("lock cnp rates") — a
 * rep can see it but not type over it, UNLESS it isn't confirmed yet (see
 * `freshQuote` below, added the same day to close a regression the lock
 * itself introduced). For an already-saved quote (`freshQuote` absent) this
 * component does nothing to override it: `value.cardNotPresentRate` is
 * whatever the quote actually carries, locked immediately, and never
 * substituted — it only removes the rep's ability to retype it.
 *
 * One component for all three rep surfaces — the wizard's Pricing step,
 * prospect creation and the Edit Quote panel — because the margin control it
 * replaced had drifted into three different widgets with three different
 * bounds, and the rate is the most consequential number on a document that
 * can't be amended after publish.
 *
 * Rates are stored as fractions (0.0249) and typed as percentages (2.49),
 * which is the only conversion here.
 */
export type RateFieldsProps = {
  value: QuoteRates;
  onChange: (next: QuoteRates) => void;
  /** Hides the explanatory line where the host already says it. */
  hideNote?: boolean;
  /**
   * True on the two surfaces that START a quote (`PricingStep`, prospect
   * creation) — absent on `EditQuotePanel`, which is reopening an
   * already-saved quote.
   *
   * On a fresh quote, `value.cardNotPresentRate` starts at
   * `DEFAULT_QUOTE_RATES`' flat 2.49% placeholder, which is NOT AIO's policy
   * (3.30% by default). Locking the box at that placeholder — which is what
   * this component did for its first few hours — was a regression: before
   * the lock a rep could at least type the right number over a wrong
   * default; locked, they couldn't, and a quote where the rep hadn't yet
   * typed BOTH a volume and a ticket (so `RateSuggestion`'s fuller lookup
   * never fires — see that file) sat on a silently-wrong, un-fixable 2.49%.
   *
   * So on `freshQuote`, this component confirms AIO's flat card-not-present
   * policy rate ITSELF the moment it mounts — `getCnpPolicyRateAction`,
   * independent of any volume/ticket basis, because CNP doesn't need one
   * (it's one flat number, not matrix-looked-up; see rateMatrix.ts's
   * `DEFAULT_CNP_RATE_BPS`). Until that resolves — or if it fails — the box
   * stays EDITABLE rather than locking a number nobody confirmed. It only
   * ever applies the fetched value if nothing has changed the box since
   * mount, so a rep who typed over it, or a `RateSuggestion` that already
   * landed a fuller suggestion, both win over this fallback seed.
   */
  freshQuote?: boolean;
};

/**
 * Rates are stored as fractions and shown as percentages, ALWAYS to two
 * decimal places (2026-10-09). The trailing zeros used to be stripped, so
 * 2.50% read "2.5" and 3.00% read "3" — three different shapes for the same
 * kind of number, in the field where a tenfold typo is hardest to see.
 */
const pctText = (fraction: number) => (fraction * 100).toFixed(2);

export default function RateFields({ value, onChange, hideNote, freshQuote }: RateFieldsProps) {
  const setCardPresent = (pct: number) => onChange({ ...value, cardPresentRate: pct / 100 });
  const setCardNotPresent = (pct: number) => {
    const next = pct / 100;
    onChange({ ...value, cardNotPresentRate: next, amexCardNotPresentRate: next });
  };
  const setPerTransactionFee = (perTransactionFee: number) => onChange({ ...value, perTransactionFee });

  // A SAVED quote (no freshQuote) trusts its own stored CNP immediately —
  // cnpLocked starts true and nothing below ever runs for it. A fresh quote
  // starts UNCONFIRMED and editable; see freshQuote's doc comment above for
  // why that matters.
  const [cnpLocked, setCnpLocked] = useState(!freshQuote);
  const [cnpFetchFailed, setCnpFetchFailed] = useState(false);
  const initialCnp = useRef(value.cardNotPresentRate);
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; });

  useEffect(() => {
    if (!freshQuote) return;
    let cancelled = false;
    getCnpPolicyRateAction()
      .then(cnp => {
        if (cancelled) return;
        setCnpLocked(true);
        if (valueRef.current.cardNotPresentRate === initialCnp.current) {
          onChange({ ...valueRef.current, cardNotPresentRate: cnp, amexCardNotPresentRate: cnp });
        }
      })
      // A failed fetch must NOT lock an unverified number (see this file's
      // doc comment on `freshQuote`) — the box just stays editable, same as
      // it was before the 2026-10-13 lock, so a rep still has a way to get
      // the right number in.
      .catch(() => { if (!cancelled) setCnpFetchFailed(true); });
    return () => { cancelled = true; };
    // Deliberately once-per-mount: this is a fallback SEED, not a live sync —
    // RateSuggestion is what keeps CNP current after this point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshQuote]);

  return (
    <>
      <div className={styles.brand}>
        {/* Each lane reads as the sentence the merchant will see on their
            quote: "2.49% + $0.15". The fee is ONE number on the quote, so
            the two fee boxes are views of it — editing either moves both. */}
        <div className={styles.grid}>
          <div className={styles.field}>
            <span className={styles.label}>Card Present</span>
            <div className={styles.pair}>
              <span className={styles.inputWrap}>
                <DecimalField
                  className={styles.input}
                  value={Number(pctText(value.cardPresentRate))}
                  max={MAX_PLAUSIBLE_CARD_RATE * 100}
                  onChange={setCardPresent}
                  aria-label="Card present rate, percent"
                />
                <span className={styles.unit}>%</span>
              </span>
              <span className={styles.plus} aria-hidden="true">+</span>
              <span className={styles.inputWrap}>
                <span className={styles.unit} data-side="left">$</span>
                <DecimalField
                  className={styles.input} data-unit="leading"
                  value={value.perTransactionFee}
                  onChange={setPerTransactionFee}
                  aria-label="Card present, per transaction fee, dollars"
                />
              </span>
            </div>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Card Not Present</span>
            <div className={styles.pair}>
              <span className={styles.inputWrap}>
                {/* Locked once confirmed — see freshQuote's doc comment above
                    for the unconfirmed window a brand-new quote starts in.
                    `onChange` is a no-op while locked; `disabled` is what
                    actually stops a rep typing here, and the browser never
                    fires onChange on a disabled input in the first place. */}
                <DecimalField
                  className={styles.input}
                  value={Number(pctText(value.cardNotPresentRate))}
                  max={MAX_PLAUSIBLE_CARD_RATE * 100}
                  onChange={cnpLocked ? () => {} : setCardNotPresent}
                  disabled={cnpLocked}
                  aria-label={
                    cnpLocked
                      ? "Card not present rate, percent — set by AIO's rate card, not editable"
                      : "Card not present rate, percent — could not confirm AIO's rate card yet, enter it directly"
                  }
                />
                <span className={styles.unit}>%</span>
              </span>
              <span className={styles.plus} aria-hidden="true">+</span>
              <span className={styles.inputWrap}>
                <span className={styles.unit} data-side="left">$</span>
                <DecimalField
                  className={styles.input} data-unit="leading"
                  value={value.perTransactionFee}
                  onChange={setPerTransactionFee}
                  aria-label="Card not present, per transaction fee, dollars"
                />
              </span>
            </div>
            {freshQuote && !cnpLocked && (
              <span className={styles.cnpStatus}>
                {cnpFetchFailed
                  ? "Could not confirm AIO's rate card — enter the card-not-present rate directly."
                  : "Confirming AIO's rate card…"}
              </span>
            )}
          </div>
        </div>
      </div>

      {!hideNote && (
        <p className={styles.note}>
          Card-not-present is set by AIO&rsquo;s rate card and isn&rsquo;t rep-editable. Default is{" "}
          {pctText(DEFAULT_QUOTE_RATES.cardPresentRate)}% + ${DEFAULT_QUOTE_RATES.perTransactionFee.toFixed(2)} until
          the ticket-size and volume matrix has a basis to quote from.
        </p>
      )}
    </>
  );
}
