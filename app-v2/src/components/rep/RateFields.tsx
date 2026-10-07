"use client";

import { DEFAULT_QUOTE_RATES, type QuoteRates } from "@/types/merchant";
import styles from "./RateFields.module.css";

/**
 * The rates a 2-tier quote is priced on, as the merchant reads them off it.
 *
 * FOUR rates, not two: Visa/Mastercard/Discover and American Express are
 * priced apart because they settle at different costs, and each carries its
 * own card-present and card-not-present lane. They all default to the same
 * number today, which is why this groups them by brand — four equal
 * percentages in one undifferentiated row is unreadable, and a rep changing
 * "the card-present rate" needs to see which of the two they're on.
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
};

type RateKey = Exclude<keyof QuoteRates, "perTransactionFee">;

/** Which AMEX lane tracks which Visa/Mastercard/Discover lane. */
const AMEX_TWIN: Record<string, RateKey> = {
  cardPresentRate: "amexCardPresentRate",
  cardNotPresentRate: "amexCardNotPresentRate",
};

const pctText = (fraction: number) => (fraction * 100).toFixed(2).replace(/\.?0+$/, "");

const BRANDS: Array<{ label: string; cp: RateKey; cnp: RateKey }> = [
  { label: "Visa · Mastercard · Discover", cp: "cardPresentRate", cnp: "cardNotPresentRate" },
  { label: "American Express", cp: "amexCardPresentRate", cnp: "amexCardNotPresentRate" },
];

export default function RateFields({ value, onChange, hideNote }: RateFieldsProps) {
  // A blank or half-typed field reads as 0 rather than NaN — the preview then
  // shows a 0% quote, which is visibly wrong, where NaN would render "—" and
  // look like the server hadn't answered yet.
  //
  // AMEX FOLLOWS V/MD while the two agree, and stops the moment they don't.
  // A rep who types 2.75 over the standard rate means the deal is at 2.75, not
  // 2.75 on three lanes and a stale 2.49 on the fourth — and the fourth is the
  // one nobody scrolls down to check. Linked-while-equal rather than a toggle:
  // there is no hidden state to get out of sync, setting AMEX apart unlinks it
  // by itself, and setting it back equal relinks it.
  //
  // The four rates are still stored and quoted as four explicit numbers, so
  // the document always states what was actually sold.
  const setRate = (key: RateKey) => (raw: string) => {
    const next = (parseFloat(raw) || 0) / 100;
    const twin = AMEX_TWIN[key];
    const linked = twin !== undefined && value[twin] === value[key];
    onChange({ ...value, [key]: next, ...(linked ? { [twin]: next } : {}) });
  };

  return (
    <>
      {BRANDS.map(brand => (
        <div key={brand.label} className={styles.brand}>
          <span className={styles.brandLabel}>
            {brand.label}
            {brand.cp === "amexCardPresentRate" &&
              value.amexCardPresentRate === value.cardPresentRate &&
              value.amexCardNotPresentRate === value.cardNotPresentRate && (
                <span className={styles.brandTracking}> · matching Visa/MC/Discover</span>
              )}
          </span>
          {/* Each lane reads as the sentence the merchant will see on their
              quote: "2.49% + $0.15". The fee is ONE number on the quote, so
              the four fee boxes are views of it — editing any one moves all. */}
          <div className={styles.grid}>
            {([["Card Present", brand.cp], ["Card Not Present", brand.cnp]] as const).map(([label, key]) => (
              <div key={key} className={styles.field}>
                <span className={styles.label}>{label}</span>
                <div className={styles.pair}>
                  <span className={styles.inputWrap}>
                    <input
                      type="number" min="0" max="100" step="0.01" inputMode="decimal"
                      className={styles.input}
                      value={pctText(value[key])}
                      onChange={e => setRate(key)(e.target.value)}
                      aria-label={`${brand.label}, ${label.toLowerCase()} rate, percent`}
                    />
                    <span className={styles.unit}>%</span>
                  </span>
                  <span className={styles.plus} aria-hidden="true">+</span>
                  <span className={styles.inputWrap}>
                    <span className={styles.unit} data-side="left">$</span>
                    <input
                      type="number" min="0" step="0.01" inputMode="decimal"
                      className={styles.input} data-unit="leading"
                      value={value.perTransactionFee}
                      onChange={e => onChange({ ...value, perTransactionFee: parseFloat(e.target.value) || 0 })}
                      aria-label={`${brand.label}, ${label.toLowerCase()} per transaction fee, dollars`}
                    />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {!hideNote && (
        <p className={styles.note}>
          Default is {pctText(DEFAULT_QUOTE_RATES.cardPresentRate)}% + ${DEFAULT_QUOTE_RATES.perTransactionFee.toFixed(2)} on
          every lane until the ticket-size and volume matrix exists. The per-transaction fee is one
          number across all four.
        </p>
      )}
    </>
  );
}
