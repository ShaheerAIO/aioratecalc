"use client";

import type { ReactNode } from "react";
import {
  CHANNEL_LABELS, describeBillingStart, isPlatformTierProduct, lineListAmount, lineNetAmount,
} from "@/lib/quoting";
import { fmt$, fmt$0, fmtFrequency, fmtPct2, monthlyEquivalent } from "@/lib/utils";
import type { CustomerSafeQuote, QuoteLine } from "@/types/merchant";
import styles from "./QuoteSummary.module.css";

// The presentational half of a customer quote — headline figure, the ticker of
// supporting numbers, and the priced lines. Shared by the public /lead/[token]
// view (which wraps it with the accept panel) and the authenticated
// "Your Quote" tab, so the merchant sees the same quote before and after they
// accept it.
//
// It only ever receives a CustomerSafeQuote: no margin, no cost, no floor,
// nothing derived from them. Totals arrive pre-computed from the server so the
// "never sum across billing frequencies" rule keeps a single owner.

type Props = {
  quote: CustomerSafeQuote;
  /** Optional affordance appended to the config-basis note (the lead page's "upload a statement instead"). */
  basisAction?: ReactNode;
};

export default function QuoteSummary({ quote, basisAction }: Props) {
  // A marketing-only quote has no processing rate behind it, so there is no
  // effective rate, volume or savings to headline — the recurring cost of what
  // they're buying is the whole story.
  const rated = quote.basis !== "products";
  const showSavings = rated && quote.annualSavings !== null && quote.annualSavings > 0;

  const oneTimeLines  = quote.lines.filter(l => l.billingFrequency === "one_time");
  const recurringLines = quote.lines.filter(l => l.billingFrequency !== "one_time");
  const points = quote.orderPoints;

  // NET of any discount — this is what the merchant is actually charged, and
  // it is the same figure `quoteTotals` sums into the totals below.
  const lineTotal = (l: QuoteLine) => lineNetAmount(l);
  const isDiscounted = (l: QuoteLine) => (l.discountPercent ?? 0) > 0;
  const isPlatformLine = (l: QuoteLine) => isPlatformTierProduct(l.name);

  return (
    <>
      <div className={styles.statWrap}>
        {!rated ? (
          <>
            <div className={styles.statCaption}>Your Monthly Total</div>
            <div className={styles.statHero} data-tone="rate">
              {fmt$(quote.lineTotals?.monthlyEquivalent ?? 0)}
            </div>
            {quote.lineTotals && quote.lineTotals.oneTime > 0 && (
              <div className={styles.statTicker}>
                <div className={styles.statTickerItem}>
                  <div className={styles.statTickerValue}>{fmt$(quote.lineTotals.oneTime)}</div>
                  <div className={styles.statTickerLabel}>Due Once</div>
                </div>
              </div>
            )}
          </>
        ) : showSavings ? (
          <>
            <div className={styles.statCaption}>Estimated Annual Savings</div>
            <div className={styles.statHero}>{fmt$(quote.annualSavings)}</div>
            <div className={styles.statTicker}>
              <div className={styles.statTickerItem}>
                <div className={styles.statTickerValue}>{fmt$(quote.monthlySavings)}</div>
                <div className={styles.statTickerLabel}>Monthly Savings</div>
              </div>
              <div className={styles.statTickerItem}>
                <div className={styles.statTickerValue}>{fmtPct2(quote.effectiveRate)}</div>
                <div className={styles.statTickerLabel}>New Effective Rate</div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className={styles.statCaption}>Your AIO Effective Rate</div>
            <div className={styles.statHero} data-tone="rate">{fmtPct2(quote.effectiveRate)}</div>
            <div className={styles.statTicker}>
              <div className={styles.statTickerItem}>
                <div className={styles.statTickerValue}>{fmt$(quote.projectedMonthlyCost)}</div>
                <div className={styles.statTickerLabel}>Estimated Monthly Cost</div>
              </div>
              <div className={styles.statTickerItem}>
                <div className={styles.statTickerValue}>{fmt$0(quote.monthlyVolume)}</div>
                <div className={styles.statTickerLabel}>Monthly Volume</div>
              </div>
              <div className={styles.statTickerItem}>
                <div className={styles.statTickerValue}>{fmt$(quote.averageTicket)}</div>
                <div className={styles.statTickerLabel}>Average Ticket</div>
              </div>
            </div>
          </>
        )}
      </div>

      {quote.basis === "config" && (
        <p className={styles.basisNote}>
          Priced on the volume and average ticket your AIO representative entered. Send us a recent
          processing statement and we&apos;ll show you exactly what you&apos;d save against it.
          {basisAction && <> {basisAction}</>}
        </p>
      )}

      {quote.lines.length > 0 && quote.lineTotals && (
        <div className={styles.lines}>
          {recurringLines.length > 0 && (
            <section className={styles.lineGroup}>
              <h2 className={styles.lineGroupTitle}>Ongoing</h2>
              {recurringLines.map(l => (
                <div key={l.hubspotProductId} className={styles.lineRow}>
                  <div>
                    <div className={styles.lineName}>
                      {l.name}{l.qty > 1 ? ` ×${l.qty}` : ""}
                    </div>
                    {isPlatformLine(l) && points && (
                      <div className={styles.lineNote}>
                        Based on {points.total} ordering point{points.total === 1 ? "" : "s"}
                        {points.channels.length > 0 && (
                          <> — including {points.channels.map(c => CHANNEL_LABELS[c] ?? c).join(", ").toLowerCase()}</>
                        )}
                      </div>
                    )}
                    {/* When the first charge lands. Stated on the line rather than
                        in the totals: it changes the timing, not the amount. */}
                    {l.billingStart && (
                      <div className={styles.lineNote} data-tone="good">
                        {describeBillingStart(l.billingStart)}
                      </div>
                    )}
                  </div>
                  <div className={styles.linePrice}>
                    <div className={styles.linePriceMain}>
                      {isDiscounted(l) && (
                        <span className={styles.lineStrike}>{fmt$(lineListAmount(l))}</span>
                      )}
                      {fmt$(lineTotal(l))}/{fmtFrequency(l.billingFrequency)}
                    </div>
                    <div className={styles.linePriceAlt}>
                      {isDiscounted(l) && <span className={styles.lineSaved}>{l.discountPercent}% off · </span>}
                      ~{fmt$(monthlyEquivalent(lineTotal(l), l.billingFrequency))}/mo
                    </div>
                  </div>
                </div>
              ))}
              {quote.lineTotals.recurring.map(r => (
                <div key={r.frequency} className={styles.lineTotalRow}>
                  <span>Total per {fmtFrequency(r.frequency)}</span>
                  <span className={styles.lineTotalValue}>{fmt$(r.amount)}/{fmtFrequency(r.frequency)}</span>
                </div>
              ))}
              <div className={styles.lineTotalRow} data-emphasis="true">
                <span>Monthly equivalent</span>
                <span className={styles.lineTotalValue}>{fmt$(quote.lineTotals.monthlyEquivalent)}/mo</span>
              </div>
            </section>
          )}

          {oneTimeLines.length > 0 && (
            <section className={styles.lineGroup}>
              <h2 className={styles.lineGroupTitle}>One-Time</h2>
              {oneTimeLines.map(l => (
                <div key={l.hubspotProductId} className={styles.lineRow}>
                  <div className={styles.lineName}>
                    {l.name}{l.qty > 1 ? ` ×${l.qty}` : ""}
                  </div>
                  <div className={styles.linePrice}>
                    <div className={styles.linePriceMain}>
                      {isDiscounted(l) && (
                        <span className={styles.lineStrike}>{fmt$(lineListAmount(l))}</span>
                      )}
                      {fmt$(lineTotal(l))}
                    </div>
                    {isDiscounted(l) && (
                      <div className={styles.linePriceAlt}>
                        <span className={styles.lineSaved}>
                          {l.discountPercent === 100 ? "Included" : `${l.discountPercent}% off`}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div className={styles.lineTotalRow} data-emphasis="true">
                <span>Total due once</span>
                <span className={styles.lineTotalValue}>{fmt$(quote.lineTotals.oneTime)}</span>
              </div>
            </section>
          )}

          <p className={styles.lineFootnote}>
            Ongoing and one-time charges are listed separately because they bill on different
            schedules — they aren&apos;t a single number.
            {rated && <> Processing fees are quoted above at your effective rate.</>}
          </p>
        </div>
      )}
    </>
  );
}
