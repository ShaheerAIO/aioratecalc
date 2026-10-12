"use client";

import {
  describeBillingStart,
  isCompedService,
  lineListAmount,
  lineNetAmount,
} from "@/lib/quoting";
import { fmt$, fmtCycle, fmtFrequency } from "@/lib/utils";
import type { QuoteLine, QuoteTotals } from "@/types/merchant";
import styles from "./ProductConfigurator.module.css";

type Props = {
  lines: QuoteLine[];
  totals: QuoteTotals;
  packageSavings: number;
  discountTotal: number;
  dueAtCheckout: number;
  /** Set when the $0.50 pre-authorization is on the quote. */
  preAuthAmount: number | null;
};

/**
 * The quote, read as a receipt: every line, then the subtotal it belongs to.
 * One-time and recurring stay in separate groups — they are different units
 * and are never added into one number.
 */
export default function QuoteReceipt({
  lines, totals, packageSavings, discountTotal, dueAtCheckout, preAuthAmount,
}: Props) {
  const oneTime = lines.filter(l => l.billingFrequency === "one_time");

  return (
    <div className={styles.panel}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Quote Totals</h2>
        <p className={styles.sectionNote}>
          Every line, then what it adds up to. One-time and recurring charges stay in their own totals.
        </p>
      </div>

      {oneTime.length > 0 && (
        <ReceiptGroup title="Due once" subtotal={fmt$(totals.oneTime)} lines={oneTime} />
      )}

      {totals.recurring.map(r => (
        <ReceiptGroup
          key={r.frequency}
          title={`Per ${fmtFrequency(r.frequency)}`}
          subtotal={`${fmt$(r.amount)}/${fmtCycle(r.frequency)}`}
          lines={lines.filter(l => l.billingFrequency === r.frequency)}
        />
      ))}

      {packageSavings > 0 && (
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Package savings</span>
          <span className={styles.totalValue} data-tone="discount">−{fmt$(packageSavings)}</span>
        </div>
      )}
      {discountTotal > 0 && (
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Discounts applied</span>
          <span className={styles.totalValue} data-tone="discount">−{fmt$(discountTotal)}</span>
        </div>
      )}
      <div className={styles.totalRow}>
        <span className={styles.totalLabel}>Due at checkout</span>
        <span className={styles.totalValue}>{fmt$(dueAtCheckout)}</span>
      </div>
      <div className={styles.totalRow} data-emphasis="true">
        <span className={styles.totalLabel}>All recurring, monthly equivalent</span>
        <span className={styles.totalValue}>{fmt$(totals.monthlyEquivalent)}/mo</span>
      </div>
      {preAuthAmount != null && (
        <p className={styles.sectionNote}>
          Nothing else is charged at checkout, so a {fmt$(preAuthAmount)} card pre-authorization is
          added automatically. It can&apos;t be edited or removed — it&apos;s what lets the billing
          start be delayed.
        </p>
      )}
    </div>
  );
}

function ReceiptGroup({ title, subtotal, lines }: { title: string; subtotal: string; lines: QuoteLine[] }) {
  return (
    <div className={styles.receiptGroup}>
      <div className={styles.receiptGroupTitle}>{title}</div>
      {lines.map((line, i) => (
        <ReceiptLine key={`${line.hubspotProductId}-${i}`} line={line} />
      ))}
      <div className={styles.receiptSubtotal}>
        <span>Subtotal</span>
        <span>{subtotal}</span>
      </div>
    </div>
  );
}

function ReceiptLine({ line }: { line: QuoteLine }) {
  const discounted = (line.discountPercent ?? 0) > 0;
  const tag = line.coveredByPackage ? "In package" : isCompedService(line) ? "Included" : null;
  const cycle = line.billingFrequency === "one_time" ? "" : `/${fmtCycle(line.billingFrequency)}`;

  return (
    <div className={styles.receiptLine}>
      <div className={styles.receiptName}>
        {line.name}
        {tag && <span className={styles.receiptTag}>{tag}</span>}
      </div>
      <div className={styles.receiptMeta}>
        {line.qty} × {fmt$(line.unitPrice)}{cycle}
        {line.billingStart && ` · ${describeBillingStart(line.billingStart)}`}
      </div>
      <div className={styles.receiptAmount}>
        {discounted && <span className={styles.strike}>{fmt$(lineListAmount(line))}</span>}{" "}
        <span>{fmt$(lineNetAmount(line))}</span>
      </div>
    </div>
  );
}
