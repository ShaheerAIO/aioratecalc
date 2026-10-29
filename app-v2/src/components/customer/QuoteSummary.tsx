"use client";

import { lineDescription } from "@/lib/lineDescriptions";
import {
  CHANNEL_LABELS, CHARGEBACK_FEE, RETRIEVAL_FEE, describeBillingStart, isInvoicedLine, lineListAmount, lineNetAmount,
} from "@/lib/quoting";
import { fmt$, fmt$0, fmtCycle, fmtFrequency, fmtPct2, monthlyEquivalent } from "@/lib/utils";
import type { CustomerSafePayment, CustomerSafeQuote, QuoteLine } from "@/types/merchant";
import styles from "./QuoteSummary.module.css";

// The presentational half of a customer quote — the line items and their
// totals. Shared by the public /lead/[token] view (which wraps it with the
// accept panel) and the authenticated "Your Quote" tab, so the merchant sees
// the same quote before and after they accept it.
//
// It only ever receives a CustomerSafeQuote: no margin, no cost, no floor,
// nothing derived from them. Totals arrive pre-computed from the server so the
// "never sum across billing frequencies" rule keeps a single owner.
//
// The rate/savings headline (effective rate, projected cost, estimated
// savings) was removed 2026-10-15 (product owner: "get rid of the whole rate
// breakdown... just show the line items"). The quoted RATES came back on
// 2026-10-18 in a card of their own ("separate card for payment details"):
// the two card rates, the volume they were quoted on, and the incident fees —
// still no effective rate, projected cost or savings.

type Props = {
  quote: CustomerSafeQuote;
};

export default function QuoteSummary({ quote }: Props) {
  // One-time lines are billed on a separate invoice after sign-up
  // (2026-10-22). The only one-time charges left on the quote itself are the
  // ones its own checkout collects — the $0.50 pre-authorization — shown on
  // their own so the merchant can see what is taken today. A $0 line (the rate
  // disclosure) has nothing to show there.
  //
  // A quote published BEFORE split billing (`oneTimeInvoiced: false`) has its
  // one-time lines on the HubSpot quote, paid at checkout — so it keeps the old
  // single "One-Time" list and "Total due once", and no invoice column.
  const invoiced = quote.oneTimeInvoiced;
  const oneTimeLines  = quote.lines.filter(l => invoiced ? isInvoicedLine(l) : l.billingFrequency === "one_time");
  const checkoutLines = invoiced
    ? quote.lines.filter(l => l.billingFrequency === "one_time" && !isInvoicedLine(l) && lineNetAmount(l) > 0)
    : [];
  const recurringLines = quote.lines.filter(l => l.billingFrequency !== "one_time");
  const invoiceTotal = oneTimeLines.reduce((n, l) => n + lineNetAmount(l), 0);

  // Packages (and plan-included items) cover one-time lines only — never a
  // recurring one — so grouping by `coveredByPackage` only ever splits the
  // one-time section. Covered lines sit under their own heading rather than
  // interleaved with what's actually being charged.
  const coveredOneTimeLines = oneTimeLines.filter(l => l.coveredByPackage);
  const chargedOneTimeLines = oneTimeLines.filter(l => !l.coveredByPackage);

  // Group covered lines by the package/plan name that covers them, preserving
  // first-seen order.
  const coveredGroups: { name: string; lines: QuoteLine[] }[] = [];
  for (const l of coveredOneTimeLines) {
    const name = l.coveredByPackage!;
    let group = coveredGroups.find(g => g.name === name);
    if (!group) {
      group = { name, lines: [] };
      coveredGroups.push(group);
    }
    group.lines.push(l);
  }

  // Named alongside the ordering-point count below. A channel id with no
  // current label (a saved quote can still carry a retired one, e.g.
  // "website") is dropped rather than printed raw.
  const channelLabels = (quote.orderPoints?.channels ?? [])
    .map(id => CHANNEL_LABELS[id])
    .filter((label): label is string => Boolean(label));

  // NET of any discount — this is what the merchant is actually charged, and
  // it is the same figure `quoteTotals` sums into the totals below.
  const lineTotal = (l: QuoteLine) => lineNetAmount(l);
  const isDiscounted = (l: QuoteLine) => (l.discountPercent ?? 0) > 0 || (l.discountAmount ?? 0) > 0;

  // How the saving reads to the MERCHANT. A cash discount says the dollars
  // the rep agreed — "$747 off" — rather than the percentage it happens to
  // work out as, which is the whole reason the cash lever exists (2026-10-14).
  // 100% is "Included" either way: on a comped or package-covered line that
  // is what it means, and a percentage nobody chose is not worth printing.
  const discountLabel = (l: QuoteLine) => {
    if (l.discountPercent === 100) return "Included";
    if ((l.discountAmount ?? 0) > 0) return `${fmt$(l.discountAmount!)} off`;
    return `${l.discountPercent}% off`;
  };

  // A package/plan-covered line is MSRP at a 100% discount — i.e. it already
  // costs nothing. Showing "$0.00" reads as a line item that happens to be
  // free; showing "Included" in its place reads as what it is.
  const renderOneTimeLine = (l: QuoteLine) => {
    const covered = Boolean(l.coveredByPackage);
    return (
      <div key={l.hubspotProductId} className={styles.lineRow}>
        <div>
          <div className={styles.lineName}>
            {l.name}{l.qty > 1 ? ` ×${l.qty}` : ""}
          </div>
          {lineDescription(l.hubspotProductId) && (
            <div className={styles.lineDesc}>{lineDescription(l.hubspotProductId)}</div>
          )}
        </div>
        <div className={styles.linePrice}>
          <div className={styles.linePriceMain}>
            {covered ? (
              <>
                <span className={styles.lineStrike}>{fmt$(lineListAmount(l))}</span>
                <span className={styles.lineSaved}>Included</span>
              </>
            ) : (
              <>
                {isDiscounted(l) && (
                  <span className={styles.lineStrike}>{fmt$(lineListAmount(l))}</span>
                )}
                {fmt$(lineTotal(l))}
              </>
            )}
          </div>
          {!covered && isDiscounted(l) && (
            <div className={styles.linePriceAlt}>
              <span className={styles.lineSaved}>{discountLabel(l)}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {/* First on the page (product owner, 2026-10-18): the rates are what a
          processing merchant is signing up to, ahead of any line item. */}
      {quote.payment && <PaymentDetails payment={quote.payment} />}

      {/* The ordering-point COUNT — a fact about what's being deployed, never
          the reason for any price. Order points stopped pricing anything on
          2026-10-05 (the platform fee is set by the plan now), so this is
          deliberately NOT placed next to the platform line or any other price
          — that juxtaposition is exactly what implied the causal link the old
          "Based on N ordering points" copy was deleted for. It sits here, with
          the rest of the configuration, on its own. */}
      {quote.orderPoints && quote.orderPoints.total > 0 && (
        <p className={styles.orderPointsNote}>
          Configured for {quote.orderPoints.total} ordering point{quote.orderPoints.total === 1 ? "" : "s"}
          {channelLabels.length > 0 && ` (${channelLabels.join(", ")})`}.
        </p>
      )}

      {quote.lines.length > 0 && quote.lineTotals && (
        <div className={styles.lines}>
          {/* Two columns (product owner, 2026-10-23): the subscription — what
              the quote bills, plus anything its checkout takes today — on the
              left, the one-time invoice on the right. One column when the
              quote only has one side, or when there isn't room. */}
          <div
            className={styles.columns}
            data-split={invoiced && (recurringLines.length > 0 || checkoutLines.length > 0) && oneTimeLines.length > 0 || undefined}
          >
          <div className={styles.column}>
          {recurringLines.length > 0 && (
            <section className={styles.lineGroup}>
              <h2 className={styles.lineGroupTitle}>Software</h2>
              {recurringLines.map(l => (
                <div key={l.hubspotProductId} className={styles.lineRow}>
                  <div>
                    <div className={styles.lineName}>
                      {l.name}{l.qty > 1 ? ` ×${l.qty}` : ""}
                    </div>
                    {lineDescription(l.hubspotProductId) && (
                      <div className={styles.lineDesc}>{lineDescription(l.hubspotProductId)}</div>
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
                      {fmt$(lineTotal(l))}/{fmtCycle(l.billingFrequency)}
                    </div>
                    {/* A monthly line IS its own monthly figure, so the "~$X/mo"
                        restatement only appears for a line on another cycle. */}
                    {(isDiscounted(l) || l.billingFrequency !== "monthly") && (
                      <div className={styles.linePriceAlt}>
                        {isDiscounted(l) && <span className={styles.lineSaved}>{discountLabel(l)}</span>}
                        {isDiscounted(l) && l.billingFrequency !== "monthly" && " · "}
                        {l.billingFrequency !== "monthly" &&
                          `~${fmt$(monthlyEquivalent(lineTotal(l), l.billingFrequency))}/mo`}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {/* When everything recurring is monthly, the per-cycle total and
                  the monthly total are the same number — show it once. */}
              {!quote.lineTotals.recurring.every(r => r.frequency === "monthly") &&
                quote.lineTotals.recurring.map(r => (
                  <div key={r.frequency} className={styles.lineTotalRow}>
                    <span>Total per {fmtFrequency(r.frequency)}</span>
                    <span className={styles.lineTotalValue}>{fmt$(r.amount)}/{fmtCycle(r.frequency)}</span>
                  </div>
                ))}
              <div className={styles.lineTotalRow} data-emphasis="true">
                <span>{quote.lineTotals.recurring.every(r => r.frequency === "monthly") ? "Monthly total" : "Monthly equivalent"}</span>
                <span className={styles.lineTotalValue}>{fmt$(quote.lineTotals.monthlyEquivalent)}/mo</span>
              </div>
            </section>
          )}

          {checkoutLines.length > 0 && (
            <section className={styles.lineGroup}>
              <h2 className={styles.lineGroupTitle}>Due at checkout</h2>
              {checkoutLines.map(renderOneTimeLine)}
            </section>
          )}
          </div>

          <div className={styles.column}>
          {oneTimeLines.length > 0 && (
            <section className={styles.lineGroup}>
              <h2 className={styles.lineGroupTitle}>{invoiced ? "One-Time — invoiced separately" : "One-Time"}</h2>
              {chargedOneTimeLines.map(renderOneTimeLine)}
              {/* Package/plan-covered items — already paid for, listed
                  separately so a merchant can see at a glance what's included
                  versus what's being charged. */}
              {coveredGroups.map(group => (
                <div key={group.name} className={styles.coveredGroup}>
                  <h3 className={styles.coveredGroupTitle}>Included in your {group.name}</h3>
                  {group.lines.map(renderOneTimeLine)}
                </div>
              ))}
              <div className={styles.lineTotalRow} data-emphasis="true">
                <span>{invoiced ? "Invoice total" : "Total due once"}</span>
                <span className={styles.lineTotalValue}>{fmt$(invoiced ? invoiceTotal : quote.lineTotals.oneTime)}</span>
              </div>
              {invoiced && (
                <p className={styles.lineFootnote}>
                  Sent as a separate invoice — open it and fill in your payment details to pay it.
                </p>
              )}
            </section>
          )}
          </div>
          </div>

          <p className={styles.lineFootnote}>
            Software and one-time charges are listed separately because they bill on different
            schedules — they aren&apos;t a single number.
          </p>
        </div>
      )}

    </>
  );
}

// The processing half of the quote, in a card of its own. The card-present
// rate is the headline and card-not-present sits under it in smaller type
// (product owner, 2026-10-18) — unless the merchant never takes a card in
// person, in which case card-not-present is the only rate and takes its place.
// Shown on every quote AIO processes for, with or without a known volume.
function PaymentDetails({ payment }: { payment: CustomerSafePayment }) {
  const fee = `+ ${fmt$(payment.perTransactionFee)} per transaction`;
  const headline = payment.cardPresentRate !== null
    ? { label: "Card present", rate: payment.cardPresentRate }
    : { label: "Card not present", rate: payment.cardNotPresentRate };

  return (
    <section className={styles.lineGroup} aria-label="Payment details">
      <h2 className={styles.lineGroupTitle}>Payment Details</h2>
      <div className={styles.rateHero}>
        <span className={styles.rateHeroLabel}>{headline.label}</span>
        <span className={styles.rateHeroValue}>{fmtPct2(headline.rate)}</span>
        <span className={styles.rateHeroFee}>{fee}</span>
      </div>
      {payment.cardPresentRate !== null && (
        <div className={styles.lineRow}>
          <span className={styles.lineDesc}>Card not present</span>
          <span className={styles.lineDesc}>{fmtPct2(payment.cardNotPresentRate)} {fee}</span>
        </div>
      )}
      {payment.monthlyVolume !== null && (
        <div className={styles.lineRow}>
          <span className={styles.lineName}>Monthly card volume</span>
          <span className={styles.lineName}>{fmt$0(payment.monthlyVolume)}</span>
        </div>
      )}
      <div className={styles.lineRow}>
        <span className={styles.lineName}>Chargeback fee</span>
        <span className={styles.lineName}>{fmt$(CHARGEBACK_FEE)} each</span>
      </div>
      <div className={styles.lineRow}>
        <span className={styles.lineName}>Retrieval fee</span>
        <span className={styles.lineName}>{fmt$(RETRIEVAL_FEE)} each</span>
      </div>
    </section>
  );
}
